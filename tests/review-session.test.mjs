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
  const ready=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'9'});
  assert.equal(planReviewSession({session:ready,baseSha:NEW_BASE,headSha:A}).mode,'noop_ready');

  const rework=applyDiscoveryResult({result:{summary:'bug',findings:[finding('P1')]},baseSha:BASE,headSha:A,sourceCommentId:'10'});
  assert.equal(planReviewSession({session:rework,baseSha:NEW_BASE,headSha:A}).mode,'noop_waiting');
  assert.equal(planReviewSession({session:rework,baseSha:NEW_BASE,headSha:B}).mode,'verification');
});

test('maximum accepted bounded session remains renderable through two verification rounds',()=>{
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
  assert.equal(s.status,'HUMAN_REQUIRED');
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
