import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chainIndex, continuationMode, continuationSourceKind, continueReview, decideContinuation, nextChainId, MAX_CONTINUATIONS } from '../scripts/continue-review.mjs';
import { applyDiscoveryResult, renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40);
const awaiting = applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: HEAD, sourceCommentId: '1' });
const rework = applyDiscoveryResult({ result: { summary: 'bug', findings: [{ severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' }] }, baseSha: BASE, headSha: HEAD, sourceCommentId: '1' });
const partial = { ...awaiting, status: 'PARTIAL', coverage: { complete: false, head: HEAD, unreviewedCount: 4, unreviewedPaths: ['x'], reviewedKeys: [] } };

test('chain ids: a real comment id is index 0, each continuation adds one, and ids stay 13 digits', () => {
  assert.equal(chainIndex('6492010062'), 0);
  assert.equal(chainIndex('191686553422555437202209828870816291839'), 0);
  const first = nextChainId('6492010062', '40844152995');
  assert.equal(first, '8140844152995');
  assert.equal(chainIndex(first), 1);
  assert.equal(chainIndex(nextChainId(first, '40844199999')), 2);
});

test('a PARTIAL engine run, or a settled PR waiting for its final full review, continues; nothing else does', () => {
  const base = { headSha: HEAD, sourceCommentId: '6492010062' };
  assert.equal(decideContinuation({ ...base, session: partial, planMode: 'claude' }).continue, true);
  assert.equal(decideContinuation({ ...base, session: awaiting, planMode: 'verification' }).continue, true);
  assert.equal(decideContinuation({ ...base, session: partial, planMode: 'verification' }).continue, false); // PARTIAL only continues after an engine run
  assert.equal(decideContinuation({ ...base, session: { ...partial, lastReviewedHead: 'c'.repeat(40) }, planMode: 'claude' }).continue, false);
  assert.equal(decideContinuation({ ...base, session: { ...awaiting, status: 'READY' }, planMode: 'claude' }).continue, false);
  assert.equal(decideContinuation({ ...base, session: rework, planMode: 'verification' }).continue, false);
  for (const planMode of ['threads', 'override', 'noop_waiting']) assert.equal(decideContinuation({ ...base, session: awaiting, planMode }).continue, false); // bookkeeping starts no paid work
  assert.equal(decideContinuation({ ...base, session: awaiting, planMode: 'dismiss' }).continue, true);
  assert.equal(decideContinuation({ ...base, session: null, planMode: 'claude' }).continue, false);
});

test('the chain stops after the continuation limit', () => {
  let id = '6492010062';
  for (let i = 0; i < MAX_CONTINUATIONS; i += 1) {
    assert.equal(decideContinuation({ session: partial, headSha: HEAD, sourceCommentId: id, planMode: 'claude' }).continue, true);
    id = nextChainId(id, '40844152995');
  }
  assert.equal(decideContinuation({ session: partial, headSha: HEAD, sourceCommentId: id, planMode: 'claude' }).continue, false);
});

test('the next run is dispatched with the same inputs and a new trigger id; nothing is dispatched when there is nothing left', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continue-'));
  const dispatched = [];
  const run = (session) => continueReview({
    env: { TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: HEAD, SOURCE_COMMENT_ID: '6492010062', SOURCE_KIND: 'comment', REQUESTED_MODE: 'auto', TRIGGER_USER: 'jiaze', REVIEW_MODE: 'verification', GH_TOKEN: 't', DISPATCH_TOKEN: 'd', GITHUB_REPOSITORY: 'ctl/repo', GITHUB_RUN_ID: '40844152995', CONTROL_REF: 'main', EXPECTED_REVIEW_AUTHOR: 'bot[bot]', REVIEW_CONTEXT_DIR: dir },
    log: { log() {} },
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/issues/7/comments')) return Response.json(session ? [{ id: 5, user: { login: 'bot[bot]' }, body: renderSessionComment(session) }] : []);
      if (url.endsWith('/actions/workflows/review-v2.yml/dispatches')) { dispatched.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
      assert.fail('unexpected URL ' + url);
    },
  });
  assert.equal((await run({ ...awaiting })).continue, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].inputs, { target_repo: 'acme/project', pr_number: '7', base_sha: BASE, head_sha: HEAD, trigger_user: 'jiaze', source_comment_id: '8140844152995', source_kind: 'comment', requested_mode: 'auto' });
  assert.equal((await run({ ...awaiting, status: 'READY' })).continue, false);
  assert.equal(dispatched.length, 1);
});

test('the workflow starts the next run only after a successful job, never fails the review, and may only dispatch itself', async () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const start = yml.indexOf('- name: Continue a big review in the next run');
  assert.ok(start > yml.indexOf('- name: Resolve review threads for closed findings'));
  const block = yml.slice(start, yml.indexOf('- name: Finalize workflow status'));
  assert.match(block, /continue-on-error: true/);
  assert.match(block, /job\.status == 'success'/);
  assert.doesNotMatch(yml, /Prepare automatic final audit|Run automatic Gemini final audit/); // the final review is a continuation, not a second pipeline
  assert.doesNotMatch(block, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(yml, /^permissions:\n  contents: read\n  actions: write/m);
});

test('a continuation never repeats a one-shot command: reset, override, dismiss and threads continue as auto; claude stays claude', async () => {
  assert.equal(continuationMode('claude'), 'claude');
  for (const mode of ['reset', 'override', 'dismiss', 'threads', 'auto', undefined]) assert.equal(continuationMode(mode), 'auto');
});

test('who asked decides the money rules of the whole chain', () => {
  assert.equal(continuationSourceKind('auto', 'comment'), 'comment');
  assert.equal(continuationSourceKind('claude', 'comment'), 'comment');
  assert.equal(continuationSourceKind('auto', 'pull_request'), 'pull_request');
  assert.equal(continuationSourceKind('threads', 'pull_request'), 'comment'); // resolving threads is a person asking
  assert.equal(continuationSourceKind('dismiss', 'comment'), 'pull_request'); // a dismissal is not a request for more review
  assert.equal(continuationSourceKind('override', 'comment'), 'pull_request');
});
