import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { stopUnavailableReview } from '../scripts/stop-unavailable-review.mjs';
import { planSession } from '../scripts/plan-review-session.mjs';
import {
  CLAUDE_FALLBACK_PR_BUDGET_USD, chargeClaudeFallback, claudeFallbackBudgetLeft,
  planReviewSession, renderSessionComment, stopUnavailableReviewSession,
} from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40), PRIOR = 'c'.repeat(40);
const AUTHOR = 'jiaze-claude-review-bot[bot]';
function folder(mode='discovery',session=null){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unavailable-review-'));
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n');
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({
    decision:{mode},session,sessionCommentId:session?'123':null,
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

test('automatic fallback has a dedicated $3 pool and still obeys shared $6 cap',()=>{
  assert.equal(CLAUDE_FALLBACK_PR_BUDGET_USD,3);
  assert.equal(claudeFallbackBudgetLeft({fallbackSpendUsd:0,deepSpendUsd:0}),3);
  assert.equal(claudeFallbackBudgetLeft({fallbackSpendUsd:1,deepSpendUsd:5.5}),0.5);
  assert.equal(claudeFallbackBudgetLeft({fallbackSpendUsd:3,deepSpendUsd:3}),0);
  // Legacy sessions have no provenance split: keep conservative combined spend.
  assert.equal(claudeFallbackBudgetLeft({deepSpendUsd:6.22}),0);
  const charged=chargeClaudeFallback({version:1,baseSha:BASE,lastReviewedHead:HEAD,
    status:'AUDIT_PENDING',findings:[],fallbackSpendUsd:0,deepSpendUsd:0},0.4);
  assert.equal(charged.fallbackSpendUsd,0.4);
  assert.equal(charged.deepSpendUsd,0.4);
});

test('HTTP 402 stop records a marker and never starts Claude when budget is exhausted',async()=>{
  const dir=folder('discovery',{deepSpendUsd:6.22,fallbackSpendUsd:3});
  const calls=[];
  await assert.rejects(runGeminiReview({env:runnerEnv(dir),fetchImpl:unavailable(),queryImpl:fakeClaude(calls),
    logImpl:()=>{}}),/budget is exhausted/);
  assert.equal(calls.length,0);
  const marker=JSON.parse(fs.readFileSync(path.join(dir,'fallback-unavailable.json'),'utf8'));
  assert.equal(marker.mode,'discovery');
  assert.equal(marker.headSha,HEAD);
  assert.equal(marker.spentUsd,0);
});

test('Claude fallback cannot reserve more than its remaining pool',async()=>{
  const dir=folder('discovery',{deepSpendUsd:2.5,fallbackSpendUsd:1.5});
  const calls=[];
  const result=await runGeminiReview({env:runnerEnv(dir),fetchImpl:unavailable(),queryImpl:fakeClaude(calls),
    logImpl:()=>{}});
  assert.equal(result._meta.provider,'claude');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.maxBudgetUsd,1.5);
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
  assert.match(renderSessionComment(result.session),/Restore Gemini quota/);
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
  assert.equal(planReviewSession({session:stopped,baseSha:BASE,headSha:PRIOR,retryUnavailable:true}).mode,'human_required');
});

test('manual @gemini review resumes ONLY a provider-unavailable stop',async()=>{
  const session=stopUnavailableReviewSession({baseSha:BASE,headSha:HEAD,sourceCommentId:'100',
    mode:'discovery',reason:'Gemini HTTP 429; fallback disabled'});
  const fetchImpl=async(url)=>url.includes('/issues/5/comments')
    ? Response.json([{id:123,user:{login:AUTHOR},body:renderSessionComment(session)}])
    : Response.json([]);
  const env=stopEnv(folder(),{EXPECTED_REVIEW_AUTHOR:AUTHOR,REQUESTED_MODE:'auto',SOURCE_KIND:'comment'});
  assert.equal((await planSession({env,fetchImpl})).decision.mode,'discovery');
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
