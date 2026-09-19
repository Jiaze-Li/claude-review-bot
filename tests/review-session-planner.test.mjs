import test from 'node:test';
import assert from 'node:assert/strict';
import { planSession } from '../scripts/plan-review-session.mjs';
import { applyDiscoveryResult, renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE='b'.repeat(40), A='a'.repeat(40), C='c'.repeat(40);
const author='jiaze-claude-review-bot[bot]';

function env(extra={}) {
  return {
    GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
    REQUESTED_MODE:'auto',EXPECTED_REVIEW_AUTHOR:author,...extra,
  };
}
function comment(id,body,user=author){return {id,user:{login:user},body};}
function fetchComments(items){
  return async(url)=>{
    assert.match(url,/issues\/7\/comments/);
    return Response.json(items);
  };
}

test('planner starts discovery when no durable bot session exists',async()=>{
  const plan=await planSession({env:env(),fetchImpl:fetchComments([])});
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
    fetchImpl:fetchComments([
      comment(5,renderSessionComment(session),'attacker'),
      comment(6,renderSessionComment(session)),
    ]),
  });
  assert.equal(plan.decision.mode,'verification');
  assert.equal(plan.decision.previousHead,A);
  assert.equal(plan.sessionCommentId,'6');
  assert.equal(plan.session.findings[0].id,'F001');
});

test('planner refuses corrupt latest bot-authored session instead of silently restarting',async()=>{
  await assert.rejects(()=>planSession({
    env:env(),
    fetchImpl:fetchComments([comment(9,'<!-- jiaze-review-session:v1 -->\ncorrupt')]),
  }),/unreadable/);
});

test('explicit reset starts a fresh discovery while preserving session comment location',async()=>{
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchComments([comment(7,renderSessionComment(session))]),
  });
  assert.equal(plan.decision.mode,'discovery');
  assert.equal(plan.sessionCommentId,'7');
  assert.equal(plan.decision.reason,'explicit reset');
});

test('explicit Claude mode bypasses session lookup entirely',async()=>{
  let calls=0;
  const plan=await planSession({
    env:env({REQUESTED_MODE:'claude'}),
    fetchImpl:async()=>{calls+=1;throw new Error('should not fetch');},
  });
  assert.equal(calls,0);
  assert.equal(plan.decision.mode,'claude');
});
