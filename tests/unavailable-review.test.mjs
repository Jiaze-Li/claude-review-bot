import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { stopUnavailableReview } from '../scripts/stop-unavailable-review.mjs';
import { planSession } from '../scripts/plan-review-session.mjs';
import {
  CLAUDE_AUTO_MIN_BUDGET_USD, DEEP_REVIEW_PR_BUDGET_USD,
  chargeClaudeFallback, claudeFallbackBudgetLeft, claudeFallbackCallBudget, isManualBudgetExemptReview,
  applyAuditResult, applyDiscoveryResult, planReviewSession, renderSessionComment,
  sessionCommitStatus, stopUnavailableReviewSession,
} from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40), PRIOR = 'c'.repeat(40);
const AUTHOR = 'jiaze-claude-review-bot[bot]';
function folder(mode='discovery',session=null){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unavailable-review-'));
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n');
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({
    requestedMode:'auto',decision:{mode},session,sessionCommentId:session?'123':null,
  }));
  return dir;
}
function runnerEnv(dir,more={}){return {GEMINI_API_KEY:'gemini',CLAUDE_CODE_OAUTH_TOKEN:'claude',
  TARGET_REPO:'owner/repo',PR_NUMBER:'5',HEAD_SHA:HEAD,REVIEW_CONTEXT_DIR:dir,...more};}
function stopEnv(dir,more={}){return {...runnerEnv(dir),BASE_SHA:BASE,SOURCE_COMMENT_ID:'200',
  GH_TOKEN:'token',...more};}
function unavailable(status=402){return async()=>new Response('no credits',{status});}
function fakeClaude(calls){
  return async function* (input){
    calls.push(input);
    yield {type:'result',subtype:'success',
      structured_output:{summary:'No confirmed defect',findings:[]},
      total_cost_usd:0.2,usage:{input_tokens:1,output_tokens:2}};
  };
}
function prAPI(calls,{head=HEAD,commentId=123}={}){
  return async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith('/pulls/5')) return Response.json({head:{sha:head},base:{sha:BASE}});
    if(url.endsWith('/issues/5/comments') || url.endsWith('/issues/comments/123')){
      assert.match(JSON.parse(init.body).body,/HUMAN_REQUIRED/);
      return Response.json({id:commentId});
    }
    throw Error('Unexpected GitHub request: '+url);
  };
}

test('automatic fallback shares the full $6 ledger; manual requests have a $5 per-call ceiling',()=>{
  assert.equal(DEEP_REVIEW_PR_BUDGET_USD,6);
  assert.equal(CLAUDE_AUTO_MIN_BUDGET_USD,0.5);
  assert.equal(claudeFallbackBudgetLeft({fallbackSpendUsd:3,deepSpendUsd:3}),3);
  assert.equal(claudeFallbackBudgetLeft({fallbackSpendUsd:1,deepSpendUsd:5.5}),0.5);
  assert.equal(claudeFallbackBudgetLeft({deepSpendUsd:6.22}),0);
  assert.equal(claudeFallbackCallBudget({deepSpendUsd:7},{manual:true}),5);
  assert.equal(claudeFallbackCallBudget({deepSpendUsd:5},{pendingUsd:0.4}),0.6);
  const charged=chargeClaudeFallback({version:1,baseSha:BASE,lastReviewedHead:HEAD,
    status:'AUDIT_PENDING',findings:[],fallbackSpendUsd:0,deepSpendUsd:0},0.4,'sdk');
  assert.equal(charged.fallbackSpendUsd,0.4);
  assert.equal(charged.deepSpendUsd,0.4);
  assert.equal(charged.claudeSdkSpendUsd,0.4);
  assert.equal(chargeClaudeFallback(charged,0.5,'reserve').claudeUnknownReserveUsd,0.5);
});

test('HTTP 402 stop records a marker and never starts Claude when budget is exhausted',async()=>{
  const dir=folder('discovery',{deepSpendUsd:6.22,fallbackSpendUsd:3});
  const calls=[];
  await assert.rejects(runGeminiReview({env:runnerEnv(dir),fetchImpl:unavailable(),queryImpl:fakeClaude(calls),
    logImpl:()=>{}}),/budget is exhausted or insufficient/);
  assert.equal(calls.length,0);
  const marker=JSON.parse(fs.readFileSync(path.join(dir,'fallback-unavailable.json'),'utf8'));
  assert.equal(marker.mode,'discovery');
  assert.equal(marker.headSha,HEAD);
  assert.equal(marker.spentUsd,0);
});

test('Claude fallback uses the shared remaining allowance, not the old $3 fallback pool',async()=>{
  const dir=folder('discovery',{deepSpendUsd:2.5,fallbackSpendUsd:1.5});
  const calls=[];
  const result=await runGeminiReview({env:runnerEnv(dir),fetchImpl:unavailable(),queryImpl:fakeClaude(calls),
    logImpl:()=>{}});
  assert.equal(result._meta.provider,'claude');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.maxBudgetUsd,3.5);
});

test('unavailable review persists a fail-closed state without fabricating discovery',async()=>{
  const dir=folder();
  fs.writeFileSync(path.join(dir,'fallback-unavailable.json'),JSON.stringify({
    mode:'discovery',headSha:HEAD,reason:'Gemini HTTP 402; Claude fallback budget exhausted',spentUsd:0,
  }));
  const calls=[];
  const result=await stopUnavailableReview({env:stopEnv(dir),fetchImpl:prAPI(calls)});
  assert.equal(result.handled,true);
  assert.equal(result.session.status,'HUMAN_REQUIRED');
  assert.equal(result.session.lastReviewedHead,HEAD);
  assert.equal(result.session.reviewFailure.mode,'discovery');
  assert.equal(result.session.auditCompleted,false);
  assert.match(renderSessionComment(result.session),/Discovery: \*\*not completed\*\*/);
  assert.match(renderSessionComment(result.session),/Comment `@gemini review`/);
  assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
  assert.deepEqual(planReviewSession({session:result.session,baseSha:BASE,headSha:HEAD}).mode,'human_required');
});

test('failed audit retains confirmed discovery, existing spend, and audit retry stage',()=>{
  const session={version:1,baseSha:BASE,lastReviewedHead:HEAD,status:'AUDIT_PENDING',
    findings:[],auditCompleted:false,verificationRound:0,maxVerificationRounds:2,deepSpendUsd:4,
    fallbackSpendUsd:2,updatedAt:'2026-10-17T00:00:00Z'};
  const stopped=stopUnavailableReviewSession({session,baseSha:BASE,headSha:HEAD,
    sourceCommentId:'201',mode:'audit',reason:'provider outage'});
  assert.equal(stopped.status,'HUMAN_REQUIRED');
  assert.equal(stopped.deepSpendUsd,4);
  assert.equal(stopped.fallbackSpendUsd,2);
  assert.match(renderSessionComment(stopped),/Discovery: \*\*complete\*\*/);
  assert.equal(planReviewSession({session:stopped,baseSha:BASE,headSha:HEAD,retryUnavailable:true}).mode,'audit');
  assert.equal(planReviewSession({session:stopped,baseSha:BASE,headSha:HEAD,retryUnavailable:false}).mode,'human_required');
  assert.equal(planReviewSession({session:stopped,baseSha:BASE,headSha:PRIOR,retryUnavailable:true}).mode,'discovery');
});

test('manual @gemini review resumes ONLY a provider-unavailable stop',async()=>{
  const session=stopUnavailableReviewSession({baseSha:BASE,headSha:HEAD,sourceCommentId:'100',
    mode:'discovery',reason:'Gemini HTTP 429; fallback disabled'});
  const fetchImpl=async(url)=>url.includes('/issues/5/comments')
    ? Response.json([{id:123,user:{login:AUTHOR},body:renderSessionComment(session)}])
    : Response.json([]);
  const env=stopEnv(folder(),{EXPECTED_REVIEW_AUTHOR:AUTHOR,REQUESTED_MODE:'auto',SOURCE_KIND:'comment'});
  // The retried first review goes through the sharded engine (Gemini first, Claude if it is still down).
  assert.equal((await planSession({env,fetchImpl})).decision.mode,'claude');
  assert.equal((await planSession({env:{...env,SOURCE_KIND:'pull_request'},fetchImpl})).decision.mode,'human_required');
  const unrelated={...session,reviewFailure:undefined};
  assert.equal(planReviewSession({session:unrelated,baseSha:BASE,headSha:HEAD,retryUnavailable:true}).mode,'human_required');
});

test('verification retry preserves previous reviewed HEAD across repeated provider failures',()=>{
  const initial={version:1,baseSha:BASE,lastReviewedHead:PRIOR,status:'REWORK',
    auditCompleted:false,findings:[],fallbackSpendUsd:0,deepSpendUsd:0};
  const first=stopUnavailableReviewSession({session:initial,baseSha:BASE,headSha:HEAD,
    sourceCommentId:'100',mode:'verification',reason:'provider outage'});
  assert.equal(first.reviewFailure.previousHead,PRIOR);
  assert.equal(planReviewSession({session:first,baseSha:BASE,headSha:HEAD,retryUnavailable:true}).previousHead,PRIOR);
});

test('unknown Claude spend on an errored fallback is reserved and persisted',async()=>{
  const dir=folder();
  fs.writeFileSync(path.join(dir,'fallback-unavailable.json'),JSON.stringify({
    mode:'discovery',headSha:HEAD,reason:'Claude failed after Gemini 502',spentUsd:2.5,
  }));
  const calls=[];
  const s=(await stopUnavailableReview({env:stopEnv(dir),fetchImpl:prAPI(calls)})).session;
  assert.equal(s.deepSpendUsd,2.5);
  assert.equal(s.fallbackSpendUsd,2.5);
});

test('replaying a source comment cannot double-charge a persisted fallback failure',async()=>{
  const previous=stopUnavailableReviewSession({baseSha:BASE,headSha:HEAD,mode:'discovery',
    reason:'Gemini unavailable',sourceCommentId:'200',spentUsd:1});
  const dir=folder('discovery',previous);
  fs.writeFileSync(path.join(dir,'fallback-unavailable.json'),JSON.stringify({
    mode:'discovery',headSha:HEAD,reason:'Gemini unavailable',spentUsd:1,
  }));
  const calls=[];
  const s=(await stopUnavailableReview({env:stopEnv(dir),fetchImpl:prAPI(calls)})).session;
  assert.equal(s.deepSpendUsd,1);
  assert.equal(s.fallbackSpendUsd,1);
});

test('moved HEAD and non-provider errors never advance the durable status',async()=>{
  const dir=folder();
  const calls=[];
  assert.equal((await stopUnavailableReview({env:stopEnv(dir),fetchImpl:prAPI(calls)})).handled,false);
  assert.equal(calls.length,0);
  fs.writeFileSync(path.join(dir,'fallback-unavailable.json'),JSON.stringify({
    mode:'discovery',headSha:HEAD,reason:'Gemini down',spentUsd:0,
  }));
  await assert.rejects(stopUnavailableReview({env:stopEnv(dir),fetchImpl:prAPI(calls,{head:PRIOR})}),/PR moved/);
  assert.equal(calls.filter(c=>c.init.method==='PATCH'||c.init.method==='POST').length,0);
});

test('low automatic allowance avoids a doomed Claude call, but a manual comment can exceed $6',async()=>{
  const dir=folder('discovery',{deepSpendUsd:5.8,fallbackSpendUsd:3});
  const calls=[];
  await assert.rejects(runGeminiReview({env:runnerEnv(dir,{SOURCE_KIND:'pull_request'}),
    fetchImpl:unavailable(),queryImpl:fakeClaude(calls),logImpl:()=>{}}),/budget is exhausted or insufficient/);
  assert.equal(calls.length,0);
  const marker=JSON.parse(fs.readFileSync(path.join(dir,'fallback-unavailable.json'),'utf8'));
  assert.equal(marker.spentUsd,0);
  const manual=folder('discovery',{deepSpendUsd:8,fallbackSpendUsd:3});
  const result=await runGeminiReview({env:runnerEnv(manual,{SOURCE_KIND:'comment'}),
    fetchImpl:unavailable(),queryImpl:fakeClaude(calls),logImpl:()=>{}});
  assert.equal(result.summary,'No confirmed defect');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.maxBudgetUsd,5);
  assert.equal(result._meta.cost_source,'sdk');
});

test('a pull request webhook cannot masquerade as a manually authorized review',async()=>{
  const dir=folder('discovery',{deepSpendUsd:7});
  const calls=[];
  await assert.rejects(runGeminiReview({env:runnerEnv(dir,{SOURCE_KIND:'pull_request'}),
    fetchImpl:unavailable(),queryImpl:fakeClaude(calls),logImpl:()=>{}}),/budget is exhausted or insufficient/);
  assert.equal(calls.length,0);
});

test('failed fallback reserves unknown cost separately from SDK-reported spend',()=>{
  const prior=stopUnavailableReviewSession({baseSha:BASE,headSha:HEAD,mode:'discovery',
    sourceCommentId:'200',reason:'provider down',spentUsd:1.1,
    costCharges:[{amount:0.2,source:'sdk'},{amount:0.9,source:'reserve'}]});
  assert.equal(prior.deepSpendUsd,1.1);
  assert.equal(prior.claudeSdkSpendUsd,0.2);
  assert.equal(prior.claudeUnknownReserveUsd,0.9);
  assert.match(renderSessionComment(prior),/unknown-usage reserve/);
});

test('verification retry on a moved HEAD preserves the original repair baseline',()=>{
  const initial={version:1,baseSha:BASE,lastReviewedHead:PRIOR,status:'REWORK',
    auditCompleted:false,findings:[],fallbackSpendUsd:0,deepSpendUsd:0};
  const stopped=stopUnavailableReviewSession({session:initial,baseSha:BASE,headSha:HEAD,
    sourceCommentId:'100',mode:'verification',reason:'provider outage'});
  const plan=planReviewSession({session:stopped,baseSha:BASE,headSha:'d'.repeat(40),retryUnavailable:true});
  assert.equal(plan.mode,'verification');
  assert.equal(plan.previousHead,PRIOR);
});

test('a successful manually retried final audit clears HUMAN_REQUIRED only when findings are clean',()=>{
  const audited=applyDiscoveryResult({result:{summary:'clean',findings:[]},
    baseSha:BASE,headSha:HEAD,sourceCommentId:'10'});
  const stopped=stopUnavailableReviewSession({session:audited,baseSha:BASE,headSha:HEAD,
    sourceCommentId:'20',mode:'audit',reason:'Gemini 402 and fallback exhausted'});
  assert.equal(stopped.status,'HUMAN_REQUIRED');
  assert.equal(planReviewSession({session:stopped,baseSha:BASE,headSha:HEAD,retryUnavailable:true}).mode,'audit');
  const clear=applyAuditResult({session:stopped,headSha:HEAD,result:{summary:'independent audit clean',findings:[]}});
  assert.equal(clear.status,'READY');
  assert.equal(sessionCommitStatus(clear,HEAD).state,'success');
  const bug=applyAuditResult({session:stopped,headSha:HEAD,result:{summary:'bug',findings:[{
    severity:'P2',title:'Failed write',body:'A known state loses data after retry',
    path:'src/app.js',line:2,riskClass:'state',
  }]}});
  assert.equal(bug.status,'REWORK');
  assert.equal(sessionCommitStatus(bug,HEAD).state,'failure');
});

test('only explicit review comments qualify for manual budget exemption',()=>{
  assert.equal(isManualBudgetExemptReview({sourceKind:'comment',requestedMode:'auto'}),true);
  assert.equal(isManualBudgetExemptReview({sourceKind:'comment',requestedMode:'reset'}),true);
  for (const requestedMode of ['dismiss','override','claude','unknown',undefined]) {
    assert.equal(isManualBudgetExemptReview({sourceKind:'comment',requestedMode}),false);
  }
  assert.equal(isManualBudgetExemptReview({sourceKind:'pull_request',requestedMode:'auto'}),false);
});

test('a dismiss-triggered final audit cannot bypass an exhausted automatic Claude budget',async()=>{
  const dir=folder('audit',{version:1,baseSha:BASE,lastReviewedHead:HEAD,status:'AUDIT_PENDING',
    auditCompleted:false,findings:[],deepSpendUsd:6});
  const plan=JSON.parse(fs.readFileSync(path.join(dir,'session-plan.json'),'utf8'));
  plan.requestedMode='dismiss';
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify(plan));
  const calls=[];
  await assert.rejects(runGeminiReview({env:runnerEnv(dir,{SOURCE_KIND:'comment'}),
    fetchImpl:unavailable(),queryImpl:fakeClaude(calls),logImpl:()=>{}}),
    /automatic budget is exhausted or insufficient/);
  assert.equal(calls.length,0);
});

test('the final audit workflow preserves the originating command, not a fabricated manual review',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/review-v2.yml',import.meta.url),'utf8');
  const auditPlan=workflow.split('      - name: Prepare automatic final audit')[1]
    ?.split('      - name: Run automatic Gemini final audit')[0] ?? '';
  assert.match(auditPlan,/jq -r '\.requestedMode \/\/ empty'/);
  assert.match(auditPlan,/requestedMode: \$requested_mode/);
  assert.match(auditPlan,/requested_mode.*dismiss/);
  assert.doesNotMatch(auditPlan,/requestedMode: "auto"/);
});
