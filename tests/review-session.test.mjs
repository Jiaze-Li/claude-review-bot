import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VERIFICATION_ROUNDS,
  applyDiscoveryResult,
  applyVerificationResult,
  openMaterialFindings,
  parseSessionComment,
  planReviewSession,
  renderSessionComment,
} from '../scripts/review-session-core.mjs';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40), BASE='d'.repeat(40);
const finding=(severity='P1', title='Bug', riskClass='state-invariant')=>({
  severity,title,body:'Trigger X causes incorrect Y; expected Z.',path:'src/a.js',line:10,riskClass,
});

test('new session gets one discovery pass',()=>{
  assert.deepEqual(planReviewSession({baseSha:BASE,headSha:A}),{
    mode:'discovery',previousHead:null,reason:'new review session',
  });
});

test('discovery with only P3 is READY and P3 is non-blocking',()=>{
  const s=applyDiscoveryResult({result:{summary:'ok',findings:[finding('P3')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(s.status,'READY');
  assert.equal(openMaterialFindings(s).length,0);
  assert.equal(s.findings[0].status,'DEFERRED');
});

test('material discovery finding waits for a changed HEAD before verification',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(s.status,'REWORK');
  assert.equal(s.findings[0].id,'F001');
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:A}).mode,'noop_waiting');
  assert.deepEqual(planReviewSession({session:s,baseSha:BASE,headSha:B}),{
    mode:'verification',previousHead:A,reason:'verify the repair against open findings',
  });
});

test('verification fixes stable finding without rediscovery',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P2')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const v=applyVerificationResult({session:s,headSha:B,result:{
    summary:'fixed',verifications:[{findingId:'F001',status:'FIXED',reason:'repair closes trigger'}],findings:[],
  }});
  assert.equal(v.status,'READY');
  assert.equal(v.verificationRound,1);
  assert.equal(v.findings[0].status,'FIXED');
});

test('missing verification verdict fails closed and bounded rounds end HUMAN_REQUIRED',()=>{
  let s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  s=applyVerificationResult({session:s,headSha:B,result:{summary:'unclear',verifications:[],findings:[]}});
  assert.equal(s.status,'REWORK');
  assert.equal(s.verificationRound,1);
  s=applyVerificationResult({session:s,headSha:C,result:{summary:'still unclear',verifications:[],findings:[]}});
  assert.equal(s.status,'HUMAN_REQUIRED');
  assert.equal(s.verificationRound,MAX_VERIFICATION_ROUNDS);
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:C}).mode,'human_required');
});

test('verification may add only modeled repair regressions and P3 stays non-blocking',()=>{
  let s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  s=applyVerificationResult({session:s,headSha:B,result:{
    summary:'old fixed but regression',
    verifications:[{findingId:'F001',status:'FIXED',reason:'fixed'}],
    findings:[finding('P2','Repair regression','repair-regression'),finding('P3','Minor','minor')],
  }});
  assert.equal(s.status,'REWORK');
  assert.deepEqual(s.findings.map(x=>[x.id,x.status]),[['F001','FIXED'],['F002','OPEN'],['F003','DEFERRED']]);
});

test('READY same HEAD is free no-op; changed READY HEAD starts fresh discovery',()=>{
  const s=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:A}).mode,'noop_ready');
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:B}).mode,'discovery');
});

test('session comment round-trips durable hidden state',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding()]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const body=renderSessionComment(s);
  assert.match(body,/Independent Review Session/);
  assert.match(body,/REWORK/);
  assert.deepEqual(parseSessionComment(body),s);
  assert.equal(parseSessionComment('ordinary comment'),null);
});
