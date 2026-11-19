import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fullReviewDecision, planSession, runSessionPlanner } from '../scripts/plan-review-session.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';
import { applyDiscoveryResult, beginDeepReview, completeDeepReview, failDeepReview } from '../scripts/review-session-core.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';
import { renderPendingHandoff } from '../scripts/review-ledger.mjs';
import { renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE='b'.repeat(40), A='a'.repeat(40), C='c'.repeat(40);
const author='jiaze-claude-review-bot[bot]';

function env(extra={}) {
  return {
    GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
    REQUESTED_MODE:'auto',EXPECTED_REVIEW_AUTHOR:author,...extra,
  };
}
// A comment is either a session (stored as the bot's own records, with its visible summary at the given id) or raw text.
function comment(id,body,user=author){return {id,user:{login:user},body};}
const pendingBody=(session,sourceCommentId)=>renderPendingHandoff({session,sourceCommentId});
function worldOf({comments=[],reviews=[]}={}){
  const pr=createFakePr({author,number:7});
  for(const c of comments){
    const trusted=c.user.login===author;
    if(typeof c.body==='string'){pr.addIssue(c.body,{id:c.id,user:c.user.login,type:trusted?'Bot':'User'});continue;}
    if(trusted) pr.seed(c.body);
    pr.addIssue(renderSessionComment(c.body),{id:c.id,user:c.user.login,type:trusted?'Bot':'User'});
  }
  for(const r of reviews) pr.addReview(r.body,{id:r.id,user:r.user.login,type:r.user.login===author?'Bot':'User'});
  return pr;
}
function fetchState(state={}){return worldOf(state).fetchImpl;}

test('planner starts discovery when no durable bot session exists',async()=>{
  const plan=await planSession({env:env(),fetchImpl:fetchState()});
  assert.equal(plan.decision.mode,'full');
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
      comment(5,session,'attacker'),
      comment(6,session),
    ]}),
  });
  assert.equal(plan.decision.mode,'verification');
  assert.equal(plan.decision.previousHead,A);
  assert.equal(plan.sessionCommentId,'6');
  assert.equal(plan.session.findings[0].id,'F001');
});

test('planner stops safely on a damaged bot handoff instead of silently restarting',async()=>{
  const plan=await planSession({
    env:env(),
    fetchImpl:fetchState({comments:[comment(9,'### Review Handoff · Seq 1 · first\nHandoff: COMPLETE\nSeq: 1')]}),
  });
  assert.equal(plan.decision.mode,'human_required');
  assert.ok(plan.ledgerStopped);
  assert.equal(plan.session,null);
});

test('explicit reset starts a fresh discovery while preserving session comment location',async()=>{
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchState({comments:[comment(7,session)]}),
  });
  assert.equal(plan.decision.mode,'full');
  assert.equal(plan.sessionCommentId,'7');
  assert.match(plan.decision.reason,/^explicit reset: /);
});

test('@claude review plans exactly like @gemini review for the same session; only the model differs',async()=>{
  const sessions={
    awaitingAudit:applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),
  };
  const plan=async(mode,session,sourceKind='comment')=>planSession({
    env:env({REQUESTED_MODE:mode,SOURCE_KIND:sourceKind}),
    fetchImpl:fetchState({comments:session?[comment(7,session)]:[]}),
  });
  // same HEAD, discovery done, audit pending
  const claude=await plan('claude',sessions.awaitingAudit);
  const gemini=await plan('auto',sessions.awaitingAudit);
  assert.equal(claude.decision.mode,'full'); // the final review is a full review: the sharded engine
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
  assert.equal(none.decision.mode,'full');
  assert.match(none.decision.reason,/Claude only/);
  assert.match((await plan('auto',null)).decision.reason,/Gemini first, Claude continues/);
});

test('@claude review waits for a deep review already running on this HEAD, and a PARTIAL review continues',async()=>{
  const running={...applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),status:'REVIEW_IN_PROGRESS',
    deepReview:{head:A,startedAt:new Date().toISOString(),state:'IN_PROGRESS',resumeStatus:'AUDIT_PENDING'}};
  const waiting=await planSession({env:env({REQUESTED_MODE:'claude',SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,running)]})});
  assert.equal(waiting.decision.mode,'noop_waiting');
  const partial={...applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),status:'PARTIAL',
    coverage:{complete:false,head:A,reviewedKeys:[],unreviewedPaths:['x'],unreviewedCount:1}};
  const resumed=await planSession({env:env({REQUESTED_MODE:'claude',SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,partial)]})});
  assert.equal(resumed.decision.mode,'full');
  assert.match(resumed.decision.reason,/partial review/);
});

test('manual review retries a FAILED deep review on the exact HEAD without resetting the session',async()=>{
  const pending=applyDiscoveryResult({result:{summary:'discovery clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const begun=beginDeepReview({session:pending,baseSha:BASE,headSha:A,reserveUsd:5,now:'2026-11-12T02:00:00.000Z'});
  const failed=failDeepReview({session:begun,headSha:A,reason:'Claude provider quota exhausted',spentUsd:5});
  assert.equal(failed.status,'HUMAN_REQUIRED');
  assert.equal(failed.deepReview.state,'FAILED');
  assert.equal(failed.reviewFailure,undefined);
  const saved=fetchState({comments:[comment(7,failed)]});

  // Only a deliberate comment retries; routine webhook events do not loop.
  const automated=await planSession({env:env({SOURCE_KIND:'pull_request'}),fetchImpl:saved});
  assert.equal(automated.decision.mode,'human_required');
  for(const command of ['auto','claude']){
    const plan=await planSession({env:env({SOURCE_KIND:'comment',REQUESTED_MODE:command}),fetchImpl:saved});
    assert.equal(plan.decision.mode,'full');
    assert.match(plan.decision.reason,/manual retry of failed review/);
    assert.equal(plan.sessionCommentId,'7');
    assert.equal(plan.session.deepSpendUsd,5);
    assert.equal(plan.session.deepReview.state,'FAILED');
    const resumed=beginDeepReview({session:plan.session,baseSha:BASE,headSha:A,reserveUsd:0,now:'2026-11-12T07:00:00.000Z'});
    assert.equal(resumed.deepReview.resumeStatus,'AUDIT_PENDING');
    assert.equal(resumed.deepReview.final,true);
    const completed=completeDeepReview({session:resumed,headSha:A,result:{summary:'complete',findings:[],coverage:{complete:true,unreviewedPaths:[]}}});
    assert.equal(completed.status,'READY');
    assert.equal(completed.auditCompleted,true);
  }
  const moved=await planSession({env:env({HEAD_SHA:C,SOURCE_KIND:'comment'}),fetchImpl:saved});
  assert.equal(moved.decision.mode,'human_required');
});

test('a failed deep review with real findings remains HUMAN_REQUIRED after a manual retry command',async()=>{
  const rework=applyDiscoveryResult({result:{summary:'real bug',findings:[{
    severity:'P2',title:'Broken commit',body:'Stale write overwrites new state',path:'a.js',line:1,riskClass:'state',
  }]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const failed=failDeepReview({session:beginDeepReview({session:rework,baseSha:BASE,headSha:A}),headSha:A,reason:'provider quota'});
  const plan=await planSession({env:env({SOURCE_KIND:'comment',REQUESTED_MODE:'auto'}),
    fetchImpl:fetchState({comments:[comment(7,failed)]})});
  assert.equal(plan.decision.mode,'human_required');
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
      id:50,user:{login:author},body:'review body\n'+pendingBody(pending,'11'),
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
      id:50,user:{login:'attacker'},body:pendingBody(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'full');
});


test('explicit reset ignores a recoverable pending review and starts fresh discovery',async()=>{
  const pending=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'11'});
  const plan=await planSession({
    env:env({REQUESTED_MODE:'reset'}),
    fetchImpl:fetchState({reviews:[{
      id:50,user:{login:author},body:'review body\n'+pendingBody(pending,'11'),
    }]}),
  });
  assert.equal(plan.decision.mode,'full');
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
      comments:[comment(7,durable)],
      reviews:[{id:11,user:{login:author},body:'review\n'+pendingBody(newer,'2')}],
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
    assert.equal(plan.decision.mode,'full',`${bytes} bytes`);
    assert.match(plan.decision.reason,/in shards: Gemini first, Claude continues/);
  }
});

test('a resolved or reopened review thread is reconciled with the session without any model call',async()=>{
  const rework=applyDiscoveryResult({result:{summary:'bug',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y; expected Z.',path:'a.js',line:1,riskClass:'state'}]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const plan=(session)=>planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request'}),fetchImpl:fetchState({comments:session?[comment(7,session)]:[]})});
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
    fetchImpl:fetchState({comments:[comment(7,stale)],reviews:[{id:101,user:{login:author},body:'review body\n'+pendingBody(newer,'11')}]}),
  });
  assert.equal(plan.decision.mode,'recover');
  assert.match(plan.decision.reason,/review-thread decision was NOT applied yet/);
  assert.equal(plan.pendingSession.findings.length,1);
});

function threadFetch({session,findings,resolvedBy='jiaze-li',permission='write'}){
  const pr=worldOf({comments:[comment(7,session)]});
  return pr.layer(async(url,init={})=>{
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
  });
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

test('V1: resolving original P3 after new commits triggers verification, and unresolved original P3 blocks verification',async()=>{
  const p3={severity:'P3',title:'Real P3',body:'Trigger X causes Y; expected Z.',path:'b.js',line:2,riskClass:'state',failurePath:'Call f() with null -> throws TypeError instead of returning null.'};
  const session=applyDiscoveryResult({result:{summary:'bugs',findings:[bug,p3]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const allResolved=await planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request',HEAD_SHA:C}),
    fetchImpl:threadFetch({session,findings:session.findings})});
  assert.equal(allResolved.decision.mode,'verification');

  const p1OnlyFetch=async(url,init={})=>{
    if(url.endsWith('/graphql')&&!/lastEditedAt/.test(init.body)) return Response.json({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[
      {id:'T0',isResolved:true,resolvedBy:{login:'jiaze-li'},comments:{nodes:[{databaseId:1,author:{login:author.replace('[bot]','')},body:'x\n\n'+findingMarker(bug.path,bug.title)}]}},
      {id:'T1',isResolved:false,resolvedBy:null,comments:{nodes:[{databaseId:2,author:{login:author.replace('[bot]','')},body:'x\n\n'+findingMarker(p3.path,p3.title)}]}},
    ]}}}}});
    return threadFetch({session,findings:session.findings})(url,init);
  };
  const partialResolved=await planSession({env:env({REQUESTED_MODE:'threads',SOURCE_KIND:'pull_request',HEAD_SHA:C}),fetchImpl:p1OnlyFetch});
  assert.equal(partialResolved.decision.mode,'threads');
});

test('V6: runSessionPlanner orchestrates planning and non-reset new-HEAD full review carries open findings or stops at >8',async()=>{
  const partialWithOpen={
    ...applyDiscoveryResult({result:{summary:'bugs',findings:[bug]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),
    status:'PARTIAL',
    coverage:{complete:false,unreviewedCount:1,unreviewedPaths:['x.js'],reviewedKeys:[],head:A},
  };
  const planned=await runSessionPlanner({
    env:env({HEAD_SHA:C,REQUESTED_MODE:'auto',SOURCE_KIND:'comment'}),
    fetchImpl:fetchState({comments:[comment(7,partialWithOpen)]}),
  });
  assert.equal(planned.decision.mode,'full');
  assert.equal(planned.decision.carryOpen,true);

  const manyOpen={
    ...partialWithOpen,
    findings:Array.from({length:9},(_,i)=>({
      id:`F${String(i+1).padStart(3,'0')}`,severity:'P1',title:`Bug ${i+1}`,body:'x',path:`f${i}.js`,line:1,riskClass:'state',
      status:'OPEN',origin:'DISCOVERY',introducedHead:A,lastCheckedHead:A,resolutionReason:null,
    })),
    nextFindingNumber:10,
  };
  const blocked=await runSessionPlanner({
    env:env({HEAD_SHA:C,REQUESTED_MODE:'auto',SOURCE_KIND:'comment'}),
    fetchImpl:fetchState({comments:[comment(7,manyOpen)]}),
  });
  assert.equal(blocked.decision.mode,'human_required');
});

test('the final review of a PR is a full review in the engine, whatever the size; a delta that needs a full look is too',async()=>{
  const awaiting=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-audit-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  const file=(i,bytes)=>`diff --git a/src/f${i}.js b/src/f${i}.js\n--- a/src/f${i}.js\n+++ b/src/f${i}.js\n@@ -1 +1 @@\n+${'x'.repeat(bytes)}\n`;
  const plan=(mode='auto')=>planSession({env:env({REVIEW_CONTEXT_DIR:dir,REQUESTED_MODE:mode,SOURCE_KIND:'comment'}),fetchImpl:fetchState({comments:[comment(7,awaiting)]})});
  for(const diff of [file(0,100),Array.from({length:30},(_,i)=>file(i,90_000)).join('')]){
    fs.writeFileSync(path.join(dir,'pr.diff'),diff);
    const planned=await plan();
    assert.equal(planned.decision.mode,'full');
    assert.match(planned.decision.reason,/Gemini first/);
    assert.match((await plan('claude')).decision.reason,/Claude only/);
  }
});

test('a delta that needs a full look becomes a full review in the engine, with the reason kept',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-full-'));
  fs.writeFileSync(path.join(dir,'pr.diff'),'x'.repeat(5000));
  const gemini=fullReviewDecision({REVIEW_CONTEXT_DIR:dir},'auto','Full review: high-risk path: .github/workflows/build.yml');
  assert.equal(gemini.mode,'full');
  assert.match(gemini.reason,/high-risk path.*5 KB diff in shards: Gemini first, Claude continues/);
  assert.match(fullReviewDecision({REVIEW_CONTEXT_DIR:dir},'claude','x').reason,/Claude only/);
});

test('a PARTIAL review continues for a person\'s command or for the run that continues it, not for an unrelated automatic event',async()=>{
  const partial={...applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'1'}),status:'PARTIAL',
    coverage:{complete:false,head:A,reviewedKeys:[],unreviewedPaths:['x'],unreviewedCount:1}};
  const plan=(extra)=>planSession({env:env(extra),fetchImpl:fetchState({comments:[comment(7,partial)]})});
  assert.equal((await plan({SOURCE_KIND:'comment'})).decision.mode,'full');
  assert.equal((await plan({SOURCE_KIND:'pull_request',SOURCE_COMMENT_ID:'8140844152995'})).decision.mode,'full'); // the continuation run
  assert.equal((await plan({SOURCE_KIND:'pull_request',SOURCE_COMMENT_ID:'263171400319958021003132'})).decision.mode,'noop_waiting'); // a reopened PR
});

test('AC-02: decision regression matrix across new PR, READY, REWORK, AUDIT_PENDING, PARTIAL, HUMAN_REQUIRED, REVIEW_IN_PROGRESS (reset guard), recover, and duplicate event', async () => {
  // 1. New PR -> full
  const newPr = await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'pull_request' }),
    fetchImpl: fetchState({ comments: [] }),
  });
  assert.equal(newPr.decision.mode, 'full');

  // 2. READY same HEAD (auto -> noop_ready, reset -> full), new HEAD -> incremental
  const ready = {
    ...applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: A, sourceCommentId: '1' }),
    status: 'READY',
    auditCompleted: true,
    handledCommentIds: ['50'],
  };
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '51' }),
    fetchImpl: fetchState({ comments: [comment(7, ready)] }),
  })).decision.mode, 'noop_ready');
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'reset', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '52' }),
    fetchImpl: fetchState({ comments: [comment(7, ready)] }),
  })).decision.mode, 'full');
  assert.equal((await planSession({
    env: env({ HEAD_SHA: C, REQUESTED_MODE: 'auto', SOURCE_KIND: 'pull_request', SOURCE_COMMENT_ID: '53' }),
    fetchImpl: fetchState({ comments: [comment(7, ready)] }),
  })).decision.mode, 'incremental_candidate');

  // 3. Duplicate event -> noop_ready
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '50' }),
    fetchImpl: fetchState({ comments: [comment(7, ready)] }),
  })).decision.mode, 'noop_ready');

  // 4. REWORK same HEAD -> noop_waiting; new HEAD -> verification
  const discovered = applyDiscoveryResult({
    result: {
      summary: 'issue',
      findings: [{ path: 'src/a.js', line: 1, severity: 'P2', title: 'Bug', body: 'Details', failurePath: 'bad path' }],
    },
    baseSha: BASE,
    headSha: A,
    sourceCommentId: '10',
  });
  const rework = {
    ...discovered,
    status: 'REWORK',
    findings: [{ ...discovered.findings[0], status: 'OPEN' }],
  };
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'pull_request', SOURCE_COMMENT_ID: '11' }),
    fetchImpl: fetchState({ comments: [comment(7, rework)] }),
  })).decision.mode, 'noop_waiting');
  assert.equal((await planSession({
    env: env({ HEAD_SHA: C, REQUESTED_MODE: 'auto', SOURCE_KIND: 'pull_request', SOURCE_COMMENT_ID: '12' }),
    fetchImpl: fetchState({ comments: [comment(7, rework)] }),
  })).decision.mode, 'verification');

  // 5. AUDIT_PENDING same HEAD -> full
  const auditPending = applyDiscoveryResult({
    result: { summary: 'clean', findings: [] },
    baseSha: BASE,
    headSha: A,
    sourceCommentId: '20',
  });
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '21' }),
    fetchImpl: fetchState({ comments: [comment(7, auditPending)] }),
  })).decision.mode, 'full');

  // 6. HUMAN_REQUIRED same HEAD (auto -> human_required; explicit @gemini after provider outage -> full)
  const humanReq = {
    ...auditPending,
    status: 'HUMAN_REQUIRED',
    reviewFailure: {
      code: 'REVIEWER_UNAVAILABLE',
      mode: 'audit',
      reason: 'quota exceeded',
      at: new Date().toISOString(),
    },
  };
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'pull_request', SOURCE_COMMENT_ID: '31' }),
    fetchImpl: fetchState({ comments: [comment(7, humanReq)] }),
  })).decision.mode, 'human_required');
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '32' }),
    fetchImpl: fetchState({ comments: [comment(7, humanReq)] }),
  })).decision.mode, 'full');

  // 7. REVIEW_IN_PROGRESS same HEAD (active) blocks even reset and claude (concurrent guard)
  const inProgress = beginDeepReview({
    session: auditPending,
    headSha: A,
    baseSha: BASE,
    sourceCommentId: '40',
    runId: 'run-1',
    now: new Date().toISOString(),
  });
  for (const mode of ['auto', 'claude', 'reset']) {
    assert.equal((await planSession({
      env: env({ HEAD_SHA: A, REQUESTED_MODE: mode, SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '41' }),
      fetchImpl: fetchState({ comments: [comment(7, inProgress)] }),
    })).decision.mode, 'noop_waiting', mode);
  }

  // 8. recover mode (pending published review newer than durable session)
  const newerPending = { ...auditPending, updatedAt: new Date(Date.now() + 60_000).toISOString() };
  assert.equal((await planSession({
    env: env({ HEAD_SHA: A, REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '61' }),
    fetchImpl: fetchState({
      comments: [comment(7, auditPending)],
      reviews: [{ id: 8, user: { login: author }, body: pendingBody(newerPending, '60') }],
    }),
  })).decision.mode, 'recover');
});
