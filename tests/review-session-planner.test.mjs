import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSession } from '../scripts/plan-review-session.mjs';
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
  assert.equal(claude.decision.mode,'audit');
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
