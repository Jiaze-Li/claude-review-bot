import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGeminiReview } from '../scripts/publish-gemini-review.mjs';

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
  assert.match(reviewCall.body.body, /jiaze-review-source-comment:99/);
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
