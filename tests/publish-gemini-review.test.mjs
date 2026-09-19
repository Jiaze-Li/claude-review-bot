import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGeminiReview } from '../scripts/publish-gemini-review.mjs';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';

const A = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

test('publisher writes durable session and exact-head PR review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'discovery' }, session: null, sessionCommentId: null,
  }));
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
  assert.match(reviewCall.body.body, /Gemini Discovery Review/);
  assert.match(reviewCall.body.body, /jiaze-review-pending-session:v1:99:/);
  assert.doesNotMatch(reviewCall.body.body, /jiaze-review-source-comment:99/);
  assert.match(sessionCall.body.body, /jiaze-review-source-comment:99/);
  assert.equal(reviewCall.body.comments[0].line, 1);
});

test('publisher refuses stale HEAD before any write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-stale-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'discovery' }, session: null, sessionCommentId: null,
  }));
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
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'discovery'},session:null,sessionCommentId:null}));
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
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'discovery'},session:null,sessionCommentId:null}));
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


test('publisher completes the one-time final audit and marks the session READY', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-gemini-audit-'));
  const pending=applyDiscoveryResult({result:{summary:'clean discovery',findings:[]},baseSha:BASE,headSha:A,sourceCommentId:'99'});
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({
    decision:{mode:'audit'},session:pending,sessionCommentId:'101',
  }));
  const reviewPath=path.join(dir,'audit.json');
  fs.writeFileSync(reviewPath,JSON.stringify({
    summary:'Final audit found no material bug.',findings:[],
    _meta:{resolved_model:'gemini-3.8-flash',effort:'low',mode:'audit',usage:{input_tokens:90,output_tokens:4,thoughts_tokens:0}},
  }));
  const calls=[];
  const out=await publishGeminiReview({
    env:{
      GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
      SOURCE_COMMENT_ID:'99',REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir,
    },
    fetchImpl:async(url,init={})=>{
      calls.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});
      if(url.endsWith('/pulls/7')) return Response.json({base:{sha:BASE},head:{sha:A}});
      if(url.includes('/pulls/7/files')) return Response.json([]);
      if(url.endsWith('/pulls/7/reviews')) return Response.json({id:202,html_url:'https://example/audit'});
      if(url.endsWith('/issues/comments/101')) return Response.json({id:101});
      assert.fail('unexpected URL '+url);
    },
  });
  assert.equal(out.session.status,'READY');
  assert.equal(out.session.auditCompleted,true);
  const reviewCall=calls.find(c=>c.url.endsWith('/pulls/7/reviews'));
  assert.match(reviewCall.body.body,/Gemini Final Audit Review/);
  const sessionCall=calls.find(c=>c.url.endsWith('/issues/comments/101'));
  assert.match(sessionCall.body.body,/Status: \*\*READY\*\*/);
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'published-session.json'),'utf8'));
  assert.equal(persisted.session.auditCompleted,true);
});
