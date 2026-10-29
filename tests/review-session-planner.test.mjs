import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fullReviewDecision, planSession } from '../scripts/plan-review-session.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';
import { applyDiscoveryResult, pendingSessionMarker, renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE='b'.repeat(40), A='a'.repeat(40), C='c'.repeat(40);
const author='jiaze-claude-review-bot[bot]';

function env(extra={}) {
  return {
    GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
    REQUESTED_MODE:'auto',EXPECTED_REVIEW_AUTHOR:author,...extra,
  };
}
function comment(id,body,user=author){return {id,user:{login:user},body};}
function fetchState({comments=[],reviews=[]}={}){
  return async(url)=>{
    if(/issues\/7\/comments/.test(url)) return Response.json(comments);
    if(/pulls\/7\/reviews/.test(url)) return Response.json(reviews);
    assert.fail('unexpected URL '+url);
  };
}

test('planner starts discovery when no durable bot session exists',async()=>{
  const plan=await planSession({env:env(),fetchImpl:fetchState()});
  assert.equal(plan.decision.mode,'claude');
  assert.equal(plan.session,null);
});

test('planner trusts only the exact bot author and recovers latest durable session',async()=>{
  const session=applyDiscoveryResult({
    result:{summary:'bug',findings:[{
      severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state',
    }]},
    baseSha:BASE,headSha:A,sourceCommentId:'1',
  });
  const plan=await planSession({
    env:env({HEAD_SHA:C}),
    fetchImpl:fetchState({comments:[
      comment(5,renderSessionComment(session),'attacker'),
      comment(6,renderSessionComment(session)),
    ]}),
  });
  assert.equal(plan.decision.mode,'verification');
  assert.equal(plan.decision.previousHead,A);
  assert.equal(plan.sessionCommentId,'6');
  assert.equal(plan.session.findings[0].id,'F001');
});

test('planner refuses corrupt latest bot-authored session instead of silently restarting',async()=>{
  await assert.rejects(()=>planSession({
    env:env(),
    fetchImpl:fetchState({comments:[comment(9,'<!-- jiaze-review-session:v1 -->\ncorrupt')]}),
  }),/unreadable/);
});

test('explicit reset starts a fresh discovery while preserving session comment location',async()=>{
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchState({comments:[comment(7,renderSessionComment(session))]}),
  });
  assert.equal(plan.decision.mode,'claude');
  assert.equal(plan.sessionCommentId,'7');
  assert.match(plan.decision.reason,/^explicit reset: /);
});

test('@claude review plans exactly like @gemini review for the same session; only the model differs',async()=>{
  const sessions={
    awaitingAudit:applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),
  };
  const plan=async(mode,session,sourceKind='comment')=>planSession({
    env:env({REQUESTED_MODE:mode,SOURCE_KIND:sourceKind}),
    fetchImpl:fetchState({comments:session?[comment(7,renderSessionComment(session))]:[]}),
  });
  // same HEAD, discovery done, audit pending
  const claude=await plan('claude',sessions.awaitingAudit);
  const gemini=await plan('auto',sessions.awaitingAudit);
  assert.equal(claude.decision.mode,'claude'); // the final review is a full review: the sharded engine
  assert.match(claude.decision.reason,/Claude only/);
  assert.match(gemini.decision.reason,/Gemini first, Claude continues/);
  assert.equal(claude.decision.mode,gemini.decision.mode);
  assert.equal(claude.requestedMode,'claude');
  assert.equal(gemini.requestedMode,'auto');
  assert.equal(claude.sessionCommentId,'7');
  // an open finding repaired on a new HEAD: verification, whichever model is asked
  const rework=applyDiscoveryResult({result:{summary:'bug',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'}]},baseSha:BASE,headSha:C,sourceCommentId:'1'});
  assert.equal((await plan('claude',rework)).decision.mode,'verification');
  assert.equal((await plan('auto',rework)).decision.mode,'verification');
  // no session: the first review, in shards, by Claude only
  const none=await plan('claude',null);
  assert.equal(none.decision.mode,'claude');
  assert.match(none.decision.reason,/Claude only/);
  assert.match((await plan('auto',null)).decision.reason,/Gemini first, Claude continues/);
});

test('@claude review waits for a deep review already running on this HEAD, and a PARTIAL review continues',async()=>{
  const running={...applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),status:'REVIEW_IN_PROGRESS',
    deepReview:{head:A,startedAt:new Date().toISOString(),state:'IN_PROGRESS',resumeStatus:'AUDIT_PENDING'}};
  const waiting=await planSession({env:env({REQUESTED_MODE:'claude',SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,renderSessionComment(running))]})});
  assert.equal(waiting.decision.mode,'noop_waiting');
  const partial={...applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),status:'PARTIAL',
    coverage:{complete:false,head:A,reviewedKeys:[],unreviewedPaths:['x'],unreviewedCount:1}};
  const resumed=await planSession({env:env({REQUESTED_MODE:'claude',SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,renderSessionComment(partial))]})});
  assert.equal(resumed.decision.mode,'claude');
  assert.match(resumed.decision.reason,/partial review/);
});

test('planner recovers a trusted pending current-HEAD review instead of rerunning Gemini',async()=>{
  const pending=applyDiscoveryResult({
    result:{summary:'bug',findings:[{
      severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state',
    }]},
    baseSha:BASE,headSha:A,sourceCommentId:'11',
  });
  const plan=await planSession({
    env:env(),
    fetchImpl:fetchState({reviews:[{
      id:50,user:{login:author},body:'review body\n'+pendingSessionMarker(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'recover');
  assert.equal(plan.pendingSourceCommentId,'11');
  assert.equal(plan.pendingReviewId,'50');
  assert.equal(plan.pendingSession.lastReviewedHead,A);
});

test('planner ignores pending state from another author',async()=>{
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'11'});
  const plan=await planSession({
    env:env(),
    fetchImpl:fetchState({reviews:[{
      id:50,user:{login:'attacker'},body:pendingSessionMarker(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'claude');
});


test('explicit reset ignores a recoverable pending review and starts fresh discovery',async()=>{
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'11'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchState({reviews:[{
      id:50,user:{login:author},body:'review body\n'+pendingSessionMarker(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'claude');
  assert.match(plan.decision.reason,/^explicit reset: /);
});

test('explicit Claude request recovers a newer published-but-unpersisted session first and says it did not run',async()=>{
  const durable=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const newer={...applyDiscoveryResult({
    result:{summary:'bug',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'}]},
    baseSha:BASE,headSha:A,sourceCommentId:'2'}),updatedAt:'2099-01-01T00:00:00.000Z'};
  const plan=await planSession({
    env:env({REQUESTED_MODE:'claude'}),
    fetchImpl:fetchState({
      comments:[comment(7,renderSessionComment(durable))],
      reviews:[{id:11,user:{login:author},body:'review\n'+pendingSessionMarker(newer,'2')}],
    }),
  });
  assert.equal(plan.decision.mode,'recover');
  assert.match(plan.decision.reason,/NOT run; send it again/);
  assert.equal(plan.pendingSession.findings[0].id,'F001');
});

test('every fresh full review goes through the sharded engine, whatever its size',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-size-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  for(const bytes of [1_000,100_000,1_600_000]){
    fs.writeFileSync(path.join(dir,'pr.diff'),'x'.repeat(bytes));
    const plan=await planSession({env:env({REVIEW_CONTEXT_DIR:dir}),fetchImpl:fetchState()});
    assert.equal(plan.decision.mode,'claude',`${bytes} bytes`);
    assert.match(plan.decision.reason,/in shards: Gemini first, Claude continues/);
  }
});

test('a resolved or reopened review thread is reconciled with the session without any model call',async()=>{
  const rework=applyDiscoveryResult({result:{summary:'bug',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'}]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=(session)=>planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request'}),fetchImpl:fetchState({comments:session?[comment(7,renderSessionComment(session))]:[]})});
  const withSession=await plan(rework);
  assert.equal(withSession.decision.mode,'threads');
  assert.equal(withSession.sessionCommentId,'7');
  assert.equal((await plan(null)).decision.mode,'noop_waiting');
  const running={...rework,status:'REVIEW_IN_PROGRESS',deepReview:{head:A,startedAt:new Date().toISOString(),state:'IN_PROGRESS',resumeStatus:'REWORK'}};
  const waiting=await plan(running);
  assert.equal(waiting.decision.mode,'noop_waiting');
  assert.match(waiting.decision.reason,/a review is running/);
});

test('a thread decision does not bypass recovery of a review that was published but not yet written to the session',async()=>{
  const stale=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const newer=applyDiscoveryResult({result:{summary:'bug',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'}]},baseSha:BASE,headSha:A,sourceCommentId:'11'});
  newer.updatedAt=new Date(Date.now()+60_000).toISOString();
  const plan=await planSession({
    env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request'}),
    fetchImpl:fetchState({comments:[comment(7,renderSessionComment(stale))],reviews:[{id:101,user:{login:author},body:'review body\n'+pendingSessionMarker(newer,'11')}]}),
  });
  assert.equal(plan.decision.mode,'recover');
  assert.match(plan.decision.reason,/review-thread decision was NOT applied yet/);
  assert.equal(plan.pendingSession.findings.length,1);
});

function threadFetch({session,findings,resolvedBy='jiaze-li',permission='write'}){
  return async(url,init={})=>{
    if(/issues\/7\/comments/.test(url)) return Response.json([comment(7,renderSessionComment(session))]);
    if(/pulls\/7\/reviews/.test(url)) return Response.json([]);
    if(url.endsWith('/graphql')) return Response.json({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:findings.map((f,i)=>({
      id:'T'+i,isResolved:resolvedBy!==null,resolvedBy:resolvedBy?{login:resolvedBy}:null,
      comments:{nodes:[{databaseId:i+1,author:{login:author.replace('[bot]','')},body:'x\n\n'+findingMarker(f.path,f.title)}]},
    }))}}}}});
    if(url.includes('/collaborators/')){
      // only the real resolver exists; a wrongly built login (e.g. an object) must not pass
      if(decodeURIComponent(url.split('/collaborators/')[1].split('/')[0])!==resolvedBy) return Response.json({message:'Not Found'},{status:404});
      return Response.json({permission});
    }
    assert.fail('unexpected URL '+url);
  };
}
const bug={severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'};

test('resolving every blocking thread after new commits runs the normal verification review; only its result decides READY',async()=>{
  const session=applyDiscoveryResult({result:{summary:'bug',findings:[bug]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=await planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request',HEAD_SHA:C}),
    fetchImpl:threadFetch({session,findings:session.findings})});
  assert.equal(plan.decision.mode,'verification');
  assert.equal(plan.decision.previousHead,A);
  assert.match(plan.decision.reason,/resolved by a person/);
});

test('resolved threads do not start a review when nothing is pushed, a resolver is not a writer, or a thread is still open',async()=>{
  const session=applyDiscoveryResult({result:{summary:'bug',findings:[bug]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const run=(extra,opts)=>planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request',...extra}),fetchImpl:threadFetch({session,findings:session.findings,...opts})});
  assert.equal((await run({HEAD_SHA:A},{})).decision.mode,'threads');
  assert.equal((await run({HEAD_SHA:C},{permission:'read'})).decision.mode,'threads');
  assert.equal((await run({HEAD_SHA:C},{resolvedBy:null})).decision.mode,'threads');
  assert.equal((await run({HEAD_SHA:C},{resolvedBy:author.replace('[bot]','')})).decision.mode,'threads');
});

test('the final review of a PR is a full review in the engine, whatever the size; a delta that needs a full look is too',async()=>{
  const awaiting=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-audit-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  const file=(i,bytes)=>`diff --git a/src/f${i}.js b/src/f${i}.js\n--- a/src/f${i}.js\n+++ b/src/f${i}.js\n@@ -1 +1 @@\n+${'x'.repeat(bytes)}\n`;
  const plan=(mode='auto')=>planSession({env:env({REVIEW_CONTEXT_DIR:dir,REQUESTED_MODE:mode,SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,renderSessionComment(awaiting))]})});
  for(const diff of [file(0,100),Array.from({length:30},(_,i)=>file(i,90_000)).join('')]){
    fs.writeFileSync(path.join(dir,'pr.diff'),diff);
    const planned=await plan();
    assert.equal(planned.decision.mode,'claude');
    assert.match(planned.decision.reason,/Gemini first/);
    assert.match((await plan('claude')).decision.reason,/Claude only/);
  }
});

test('a delta that needs a full look becomes a full review in the engine, with the reason kept',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-full-'));
  fs.writeFileSync(path.join(dir,'pr.diff'),'x'.repeat(5000));
  const gemini=fullReviewDecision({REVIEW_CONTEXT_DIR:dir},'auto','Full review: high-risk path: .github/workflows/build.yml');
  assert.equal(gemini.mode,'claude');
  assert.match(gemini.reason,/high-risk path.*5 KB diff in shards: Gemini first, Claude continues/);
  assert.match(fullReviewDecision({REVIEW_CONTEXT_DIR:dir},'claude','x').reason,/Claude only/);
});
