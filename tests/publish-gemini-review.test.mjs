import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGeminiReview } from '../scripts/publish-gemini-review.mjs';
import { applyDiscoveryResult, beginDeepReview, completeDeepReview, sessionCommitStatus } from '../scripts/review-session-core.mjs';

const A = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
// The staged publisher only handles deltas on top of a reviewed state: here, a READY baseline for the previous HEAD.
const OLD = 'd'.repeat(40);
function readyBaseline() {
  const first = applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: OLD, sourceCommentId: '1' });
  return completeDeepReview({ session: beginDeepReview({ session: first, baseSha: BASE, headSha: OLD }), result: { summary: 'clean', findings: [], coverage: { complete: true, unreviewedPaths: [] } }, headSha: OLD });
}
const incrementalPlan = (extra = {}) => JSON.stringify({ decision: { mode: 'incremental', previousHead: OLD }, session: readyBaseline(), sessionCommentId: null, ...extra });

test('publisher writes durable session and exact-head PR review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    summary: 'Found one bug.',
    findings: [{
      severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.',
      path: 'a.js', line: 1, riskClass: 'state',
    }],
    _meta: { resolved_model: 'gemini-3.8-flash', effort: 'low', usage: { input_tokens: 10, output_tokens: 5, thoughts_tokens: 2 } },
  }));

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (url.includes('/pulls/7/files')) return Response.json([{ filename: 'a.js', patch: '@@ -0,0 +1 @@\n+bug' }]);
    if (url.endsWith('/issues/7/comments')) return Response.json({ id: 101 });
    if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202, html_url: 'https://example/review' });
    assert.fail('unexpected URL ' + url);
  };

  const out = await publishGeminiReview({
    env: {
      GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
      SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl,
  });
  assert.equal(out.session.status, 'REWORK');
  const sessionCall = calls.find((call) => call.url.endsWith('/issues/7/comments'));
  assert.match(sessionCall.body.body, /Independent Review Session/);
  assert.match(sessionCall.body.body, /F001/);
  const reviewCall = calls.find((call) => call.url.endsWith('/pulls/7/reviews') && call.method === 'POST');
  assert.equal(reviewCall.body.commit_id, A);
  assert.match(reviewCall.body.body, /Gemini Incremental Review/);
  assert.match(reviewCall.body.body, /jiaze-review-pending-session:v1:99:/);
  assert.doesNotMatch(reviewCall.body.body, /jiaze-review-source-comment:99/);
  assert.match(sessionCall.body.body, /jiaze-review-source-comment:99/);
  assert.equal(reviewCall.body.comments[0].line, 1);
});

test('publisher refuses stale HEAD before any write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-stale-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ summary: 'clean', findings: [] }));
  const calls = [];
  await assert.rejects(() => publishGeminiReview({
    env: {
      GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
      SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ base: { sha: BASE }, head: { sha: 'c'.repeat(40) } });
    },
  }), /refusing stale review/);
  assert.equal(calls.length, 1);
});


test('publisher does not advance durable session if HEAD moves after review publication', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-gemini-race-'));
  fs.writeFileSync(path.join(dir,'session-plan.json'),incrementalPlan());
  const reviewPath=path.join(dir,'review.json');
  fs.writeFileSync(reviewPath,JSON.stringify({summary:'clean',findings:[]}));
  let prReads=0;
  const calls=[];
  await assert.rejects(()=>publishGeminiReview({
    env:{
      GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
      SOURCE_COMMENT_ID:'99',REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir,
    },
    fetchImpl:async(url,init={})=>{
      calls.push({url,method:init.method||'GET'});
      if(url.endsWith('/pulls/7')){
        prReads+=1;
        return Response.json({base:{sha:BASE},head:{sha:prReads===1?A:'c'.repeat(40)}});
      }
      if(url.includes('/pulls/7/files')) return Response.json([]);
      if(url.endsWith('/pulls/7/reviews')) return Response.json({id:202});
      if(url.endsWith('/issues/7/comments')) return Response.json({id:101});
      assert.fail('unexpected URL '+url);
    },
  }),/durable session state was not advanced/);
  assert.equal(calls.filter(c=>c.url.endsWith('/pulls/7/reviews')).length,1);
  assert.equal(calls.filter(c=>c.url.endsWith('/issues/7/comments')).length,0);
});


test('review publication followed by session-write failure remains recoverable without processed marker', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-gemini-partial-'));
  fs.writeFileSync(path.join(dir,'session-plan.json'),incrementalPlan());
  const reviewPath=path.join(dir,'review.json');
  fs.writeFileSync(reviewPath,JSON.stringify({summary:'clean',findings:[]}));
  let reviewBody='';
  await assert.rejects(()=>publishGeminiReview({
    env:{
      GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
      SOURCE_COMMENT_ID:'99',REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir,
    },
    fetchImpl:async(url,init={})=>{
      if(url.endsWith('/pulls/7')) return Response.json({base:{sha:BASE},head:{sha:A}});
      if(url.includes('/pulls/7/files')) return Response.json([]);
      if(url.endsWith('/pulls/7/reviews')){
        reviewBody=JSON.parse(init.body).body;
        return Response.json({id:202});
      }
      if(url.endsWith('/issues/7/comments')) return new Response('write failed',{status:503});
      assert.fail('unexpected URL '+url);
    },
  }),/HTTP 503/);
  assert.match(reviewBody,/jiaze-review-pending-session:v1:99:/);
  assert.doesNotMatch(reviewBody,/jiaze-review-source-comment:99/);
});


test('droppedFindings tells apart same-title findings in different files', async () => {
  const { droppedFindings } = await import('../scripts/publish-gemini-review.mjs');
  const reported = [
    { title: 'Stale read', path: 'src/a.js' },
    { title: 'Stale read', path: 'src/b.js' },
  ];
  const kept = [{ title: 'Stale read', path: 'src/b.js' }];
  assert.deepEqual(droppedFindings(reported, kept), [{ title: 'Stale read', path: 'src/a.js' }]);
  assert.deepEqual(droppedFindings(reported, reported), []);
});

test('publisher preserves a material UNCERTAIN candidate and never leaves an inconclusive review READY', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-uncertain-'));
  fs.writeFileSync(path.join(dir,'session-plan.json'),incrementalPlan({requestedMode:'auto'}));
  const reviewPath=path.join(dir,'review.json');
  fs.writeFileSync(reviewPath,JSON.stringify({
    summary:'Possible budget authorization bug',findings:[],
    _meta:{provider:'gemini',resolved_model:'gemini-flash-latest'},
    _validation:{status:'VALIDATED',validations:[{
      candidateId:'D001',verdict:'UNCERTAIN',severity:'P2',
      title:'Dismiss comment might bypass spending cap',path:'.github/workflows/review-v2.yml',
      line:462,riskClass:'budget',reason:'Caller context was missing for the validator.',
    }]},
  }));
  let sessionComment='';
  let reviewBody='';
  const out=await publishGeminiReview({
    env:{GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',
      BASE_SHA:BASE,HEAD_SHA:A,SOURCE_COMMENT_ID:'99',
      REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init={})=>{
      if(url.endsWith('/pulls/7')) return Response.json({base:{sha:BASE},head:{sha:A}});
      if(url.includes('/pulls/7/files')) return Response.json([]);
      if(url.endsWith('/issues/7/comments')){
        sessionComment=JSON.parse(init.body).body;
        return Response.json({id:101});
      }
      if(url.endsWith('/pulls/7/reviews')){
        reviewBody=JSON.parse(init.body).body;
        return Response.json({id:202});
      }
      assert.fail('unexpected '+url);
    },
  });
  assert.equal(out.session.status,'HUMAN_REQUIRED');
  assert.equal(out.session.findings[0].status,'UNCERTAIN');
  assert.equal(out.session.findings[0].id,'F001');
  assert.equal(out.session.dismissed.length,0);
  assert.equal(sessionCommitStatus(out.session,A).state,'error');
  assert.match(sessionComment,/Unresolved material candidates: \*\*1\*\*/);
  assert.match(reviewBody,/Not merge-ready/);
  assert.match(reviewBody,/F001 · P2/);
  assert.match(reviewBody,/\*\*HUMAN_REQUIRED\*\*/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'published-session.json'),'utf8')).session.status,
    'HUMAN_REQUIRED');
});

test('a finding whose line is outside the diff is still pinned as a resolvable thread, with its marker; a file outside the PR stays in the body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-anchor-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    summary: 'Found three.',
    findings: [
      { severity: 'P2', title: 'Line far from the change', body: 'b1', path: 'a.js', line: 534, riskClass: 'state' },
      { severity: 'P3', title: 'No line given', body: 'b2', path: 'a.js', line: null, riskClass: 'state' },
      { severity: 'P3', title: 'In a file the PR does not touch', body: 'b3', path: 'untouched.js', line: 5, riskClass: 'state' },
    ],
    _meta: { resolved_model: 'gemini-x', effort: 'low', usage: { input_tokens: 1, output_tokens: 1, thoughts_tokens: 0 } },
  }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (url.includes('/pulls/7/files')) return Response.json([{ filename: 'a.js', patch: '@@ -1,2 +1,3 @@\n keep\n+new line\n keep too' }]);
    if (url.endsWith('/issues/7/comments')) return Response.json({ id: 101 });
    if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202, html_url: 'https://example/review' });
    assert.fail('unexpected URL ' + url);
  };
  await publishGeminiReview({
    env: { GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir },
    fetchImpl,
  });
  const review = calls.find((call) => call.url.endsWith('/pulls/7/reviews') && call.method === 'POST').body;
  assert.equal(review.comments.length, 2);
  assert.ok(review.comments.every((c) => c.path === 'a.js' && c.line === 2 && c.side === 'RIGHT'));
  assert.match(review.comments[0].body, /Pinned to the nearest changed line: line 534 is outside the changed lines/);
  assert.match(review.comments[1].body, /file-level finding/);
  assert.ok(review.comments.every((c) => /<!-- jiaze-finding:[0-9a-f]{10} -->/.test(c.body)));
  assert.match(review.body, /Findings without an inline anchor[\s\S]*In a file the PR does not touch/);
  assert.doesNotMatch(review.body, /Line far from the change<\/b>|Line far from the change.*untouched/);
});
