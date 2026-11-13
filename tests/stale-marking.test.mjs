import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSession } from '../scripts/plan-review-session.mjs';
import { applyStale } from '../scripts/apply-stale.mjs';
import { applyDiscoveryResult, parseSessionComment, renderSessionComment } from '../scripts/review-session-core.mjs';
import { decideNotificationAction } from '../scripts/notification-policy.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), C = 'c'.repeat(40);
const author = 'jiaze-claude-review-bot[bot]';
const ready = () => ({ ...applyDiscoveryResult({ result: { summary: 's', findings: [] }, baseSha: BASE, headSha: A, sourceCommentId: '1' }), status: 'READY', auditCompleted: true });
const env = (extra = {}) => ({ GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: C, REQUESTED_MODE: 'stale', EXPECTED_REVIEW_AUTHOR: author, ...extra });
const plan = (session, extra) => planSession({
  env: env(extra),
  fetchImpl: async (url) => /issues\/7\/comments/.test(url)
    ? Response.json(session ? [{ id: 5, user: { login: author }, body: renderSessionComment(session) }] : [])
    : Response.json([]),
});

test('a push after READY plans a zero-model stale marking', async () => {
  assert.equal((await plan(ready())).decision.mode, 'stale');
});

test('no marking when there is no session, the head is the reviewed one, a review is running, or it is already marked', async () => {
  assert.equal((await plan(null)).decision.mode, 'noop_waiting');
  assert.equal((await plan(ready(), { HEAD_SHA: A })).decision.mode, 'noop_waiting');
  assert.equal((await plan({ ...ready(), status: 'REVIEW_IN_PROGRESS' })).decision.mode, 'noop_waiting');
  assert.equal((await plan({ ...ready(), staleFor: A, staleHead: C, staleCommits: 1 })).decision.mode, 'noop_waiting');
  // a further push after being marked is marked again for the newer head
  const D = 'd'.repeat(40);
  assert.equal((await plan({ ...ready(), staleFor: A, staleHead: C, staleCommits: 1 }, { HEAD_SHA: D })).decision.mode, 'stale');
});

test('rendering: a stale READY is never plain READY and says how to get the new part reviewed', () => {
  const body = renderSessionComment({ ...ready(), staleFor: A, staleHead: C, staleCommits: 2 });
  assert.match(body, /Status: \*\*READY on an earlier commit \(NOT current\)\*\*/);
  assert.match(body, /2 newer commits/);
  assert.match(body, /@gemini review/);
  assert.doesNotMatch(body, /Status: \*\*READY\*\*/);
  const fresh = renderSessionComment({ ...ready(), staleFor: 'd'.repeat(40), staleHead: C });
  assert.match(fresh, /Status: \*\*READY\*\*/); // mark belongs to another reviewed commit: inert
});

test('stale marking is silent in the PR conversation unless it failed', () => {
  assert.equal(decideNotificationAction({ stage: 'finished', mode: 'stale', outcomes: { stale: 'success' } }).action, 'silent');
  assert.equal(decideNotificationAction({ stage: 'finished', mode: 'stale', outcomes: { stale: 'failure' } }).action, 'post_error');
});

test('apply-stale changes only the mark: status, findings, spend and reviewed commit stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  const session = ready();
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'stale' }, session, sessionCommentId: '5' }));
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    if (/pulls\/7$/.test(url)) return Response.json({ head: { sha: C } });
    if (/compare\//.test(url)) return Response.json({ ahead_by: 3 });
    writes.push({ method: init.method || 'GET', url, body: init.body });
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 900 });
  };
  const result = await applyStale({ env: env({ REVIEW_CONTEXT_DIR: dir, SOURCE_COMMENT_ID: '123' }), fetchImpl });
  assert.equal(result.marked, true);
  assert.deepEqual({ ...result.session, staleFor: undefined, staleHead: undefined, staleCommits: undefined }, { ...session, staleFor: undefined, staleHead: undefined, staleCommits: undefined });
  const posted = JSON.parse(writes.find((w) => w.method === 'POST').body).body;
  const stored = parseSessionComment(posted);
  assert.equal(stored.staleFor, A);
  assert.equal(stored.staleCommits, 3);
  assert.equal(stored.status, 'READY');
  assert.equal(stored.lastReviewedHead, A);
  assert.ok(writes.some((w) => w.method === 'DELETE')); // old comment replaced, the new one is at the bottom
});

test('apply-stale does nothing if the PR already moved on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'stale' }, session: ready(), sessionCommentId: '5' }));
  const fetchImpl = async (url) => /pulls\/7$/.test(url) ? Response.json({ head: { sha: 'e'.repeat(40) } }) : assert.fail('must not write');
  const result = await applyStale({ env: env({ REVIEW_CONTEXT_DIR: dir, SOURCE_COMMENT_ID: '123' }), fetchImpl });
  assert.equal(result.marked, false);
});
