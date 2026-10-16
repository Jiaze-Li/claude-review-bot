import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(plan.decision.mode,'discovery');
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
  assert.equal(plan.decision.mode,'discovery');
  assert.equal(plan.sessionCommentId,'7');
  assert.equal(plan.decision.reason,'explicit reset');
});

test('explicit Claude mode joins the durable session for this HEAD',async()=>{
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'claude'}),
    fetchImpl:fetchState({comments:[comment(7,renderSessionComment(session))]}),
  });
  assert.equal(plan.decision.mode,'claude');
  assert.equal(plan.sessionCommentId,'7');
  assert.equal(plan.session.lastReviewedHead,A);
});

test('explicit Claude mode waits instead of seeding a session when no review exists for this HEAD',async()=>{
  const none=await planSession({env:env({REQUESTED_MODE:'claude'}),fetchImpl:fetchState()});
  assert.equal(none.decision.mode,'noop_waiting');
  assert.match(none.decision.reason,/NOT queued.*send @claude review again/);
  const old=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:C,sourceCommentId:'1'});
  const other=await planSession({
    env:env({REQUESTED_MODE:'claude'}),
    fetchImpl:fetchState({comments:[comment(7,renderSessionComment(old))]}),
  });
  assert.equal(other.decision.mode,'noop_waiting');
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
  assert.equal(plan.decision.mode,'discovery');
});


test('explicit reset ignores a recoverable pending review and starts fresh discovery',async()=>{
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'11'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchState({reviews:[{
      id:50,user:{login:author},body:'review body\n'+pendingSessionMarker(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'discovery');
  assert.equal(plan.decision.reason,'explicit reset');
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
