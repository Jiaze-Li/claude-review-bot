import { applyFullReview } from './helpers/full-review.mjs';
import test from 'node:test';
import { createFakePr } from './helpers/fake-pr.mjs';
import assert from 'node:assert/strict';
import {
    applyDiscoveryResult,
  applyOverride,
  applyVerificationResult,
  openMaterialFindings,
  planReviewSession,
  renderSessionComment,
} from '../scripts/review-session-core.mjs';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40), BASE='d'.repeat(40);
const finding=(severity='P1', title='Bug', riskClass='state-invariant')=>({
  severity,title,body:'Trigger X causes incorrect Y; expected Z.',path:'src/a.js',line:10,riskClass,
});

test('new session gets one discovery pass',()=>{
  assert.deepEqual(planReviewSession({baseSha:BASE,headSha:A}),{
    mode:'full_review',previousHead:null,reason:'new review session',
  });
});

test('discovery with a P3 keeps it open and blocks until fixed',()=>{
  const s=applyDiscoveryResult({result:{summary:'ok',findings:[finding('P3')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(s.status,'REWORK');
  assert.equal(openMaterialFindings(s).length,1);
  assert.equal(s.findings[0].status,'OPEN');
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

test('verification fixes stable finding and proceeds to the one-time final audit',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P2')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const v=applyVerificationResult({session:s,headSha:B,result:{
    summary:'fixed',verifications:[{findingId:'F001',status:'FIXED',reason:'repair closes trigger'}],findings:[],
  }});
  assert.equal(v.status,'AUDIT_PENDING');
  assert.equal(v.verificationRound,1);
  assert.equal(v.findings[0].status,'FIXED');
});

test('missing verification verdict fails closed, and there is no fixed number of verification rounds',()=>{
  let s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const heads=['b','c','d','e','f'].map((c)=>c.repeat(40));
  heads.forEach((head,i)=>{
    s=applyVerificationResult({session:s,headSha:head,result:{summary:'unclear',verifications:[],findings:[]}});
    assert.equal(s.status,'REWORK'); // never silently ends, never gives up on a count
    assert.equal(s.verificationRound,i+1);
    assert.equal(s.findings[0].status,'OPEN'); // an omitted verdict keeps the finding open
    assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:'9'.repeat(40)}).mode,'verification');
  });
});

test('verification may add only modeled repair regressions and a new P3 is open too',()=>{
  let s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  s=applyVerificationResult({session:s,headSha:B,result:{
    summary:'old fixed but regression',
    verifications:[{findingId:'F001',status:'FIXED',reason:'fixed'}],
    findings:[finding('P2','Repair regression','repair-regression'),finding('P3','Minor','minor')],
  }});
  assert.equal(s.status,'REWORK');
  assert.deepEqual(s.findings.map(x=>[x.id,x.status]),[['F001','FIXED'],['F002','OPEN'],['F003','OPEN']]);
});

test('a session waiting for its final review is finished by one complete full review, then READY is a free no-op',()=>{
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(pending.status,'AUDIT_PENDING');
  assert.equal(planReviewSession({session:pending,baseSha:BASE,headSha:A}).mode,'full_review');
  const s=applyFullReview({session:pending,result:{summary:'final audit clean',findings:[]},headSha:A});
  assert.equal(s.status,'READY');
  assert.equal(s.auditCompleted,true);
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:A}).mode,'noop_ready');
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:B}).mode,'incremental_candidate');
});

test('findings of the one final full review are verified without a second full review',()=>{
  let s=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  s=applyFullReview({session:s,result:{summary:'late bug',findings:[finding('P1','Late bug','final-audit')]},headSha:A});
  assert.equal(s.status,'REWORK');
  assert.equal(s.auditCompleted,true);
  assert.equal(s.findings.at(-1).origin,'CLAUDE_DEEP');
  s=applyVerificationResult({session:s,headSha:B,result:{
    summary:'fixed',verifications:[{findingId:s.findings.at(-1).id,status:'FIXED',reason:'repair closes final-audit trigger'}],findings:[],
  }});
  assert.equal(s.status,'READY');
  assert.equal(planReviewSession({session:s,baseSha:BASE,headSha:B}).mode,'noop_ready');
});

test('the session summary is readable and the durable state round-trips through the PR records',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding()]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const body=renderSessionComment(s);
  assert.match(body,/Independent Review Session/);
  assert.match(body,/REWORK/);
  assert.doesNotMatch(body,/jiaze-review-state/);
  const pr=createFakePr();
  pr.seed(s);
  assert.deepEqual(pr.session(),s);
});


test('verification cannot invent finding IDs outside the open durable registry', () => {
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.throws(()=>applyVerificationResult({session:s,headSha:B,result:{
    summary:'bad id',
    verifications:[{findingId:'F999',status:'FIXED',reason:'invented'}],
    findings:[],
  }}),/unknown or non-open finding id/);
});


test('target base-tip movement alone never spends another discovery call',()=>{
  const NEW_BASE='e'.repeat(40);
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const ready=applyFullReview({session:pending,result:{summary:'audit clean',findings:[]},headSha:A});
  assert.equal(planReviewSession({session:ready,baseSha:NEW_BASE,headSha:A}).mode,'noop_ready');

  const rework=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'10'});
  assert.equal(planReviewSession({session:rework,baseSha:NEW_BASE,headSha:A}).mode,'noop_waiting');
  assert.equal(planReviewSession({session:rework,baseSha:NEW_BASE,headSha:B}).mode,'verification');
});

test('maximum accepted bounded session remains renderable through repeated verification rounds',()=>{
  const text=(ch,n)=>ch.repeat(n);
  const maxFinding=(i)=>({
    severity:'P1',
    title:text(String(i%10),200),
    body:text('b',1200),
    path:'src/'+text('p',480)+i+'.js',
    line:i+1,
    riskClass:text('r',60),
  });
  let s=applyDiscoveryResult({
    result:{summary:text('s',1500),findings:Array.from({length:6},(_,i)=>maxFinding(i))},
    baseSha:BASE,headSha:A,sourceCommentId:'9',
  });

  const verify=(head,offset)=>({
    session:s,
    headSha:head,
    result:{
      summary:text('v',1500),
      verifications:s.findings.filter(f=>f.status==='OPEN').map(f=>({
        findingId:f.id,status:'STILL_OPEN',reason:text('q',800),
      })),
      findings:Array.from({length:3},(_,i)=>maxFinding(offset+i)),
    },
  });
  s=applyVerificationResult(verify(B,10));
  s=applyVerificationResult(verify(C,20));
  assert.equal(s.status,'REWORK'); // there is no round limit that stops the review
  assert.equal(s.findings.length,12);
  const body=renderSessionComment(s,{sourceCommentIds:['1','2']});
  assert.ok(Buffer.byteLength(body,'utf8')<65536);
  assert.match(body,/jiaze-review-source-comment:1/);
  assert.match(body,/jiaze-review-source-comment:2/);
});


test('Gemini may return a detailed finding while durable session stores a compact copy',()=>{
  const detailed={
    severity:'P1',
    title:'Detailed bug',
    body:'x'.repeat(2500),
    path:'src/a.js',
    line:10,
    riskClass:'state-invariant',
  };
  const s=applyDiscoveryResult({
    result:{summary:'s'.repeat(2500),findings:[detailed]},
    baseSha:BASE,headSha:A,sourceCommentId:'9',
  });
  assert.equal(s.status,'REWORK');
  assert.equal(s.findings[0].body.length,450);
  assert.equal(s.lastSummary.length,500);
});

test('verification reason may be detailed while durable resolution is compacted',()=>{
  let s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  s=applyVerificationResult({session:s,headSha:B,result:{
    summary:'verification',
    verifications:[{findingId:'F001',status:'STILL_OPEN',reason:'r'.repeat(1500)}],
    findings:[],
  }});
  assert.equal(s.status,'REWORK');
  assert.equal(s.findings[0].resolutionReason.length,600);
});

test('V4: override and head-changing transitions strip stale, reviewFailure, and expired coverage/deepReview',()=>{
  const s=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  const dirty={
    ...s,
    staleFor:A,staleHead:B,staleCommits:2,
    reviewFailure:{code:'REVIEWER_UNAVAILABLE',mode:'verification',head:A,previousHead:A,reason:'402'},
    coverage:{complete:false,unreviewedCount:1,unreviewedPaths:['x.js'],reviewedKeys:[],head:A},
    deepReview:{head:A,startedAt:'2026-01-01T00:00:00Z',state:'COMPLETE'},
  };
  const overridden=applyOverride({session:dirty,headSha:B,by:'jiaze-li'});
  assert.equal(overridden.status,'READY');
  assert.equal(overridden.reviewFailure,undefined);
  assert.equal(overridden.staleFor,undefined);
  assert.equal(overridden.staleHead,undefined);
  assert.equal(overridden.staleCommits,undefined);
  assert.equal(overridden.coverage,undefined);
  assert.equal(overridden.deepReview,undefined);
  const body=renderSessionComment(overridden);
  assert.doesNotMatch(body,/Review stopped/);
  assert.doesNotMatch(body,/NOT current/);

  const verified=applyVerificationResult({session:dirty,headSha:B,result:{
    summary:'fixed',verifications:[{findingId:'F001',status:'FIXED',reason:'fixed'}],findings:[],
  }});
  assert.equal(verified.reviewFailure,undefined);
  assert.equal(verified.staleFor,undefined);
  assert.equal(verified.coverage,undefined);
  assert.equal(verified.deepReview,undefined);
});
