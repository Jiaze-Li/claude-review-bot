import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSessionComment, visibleResultChanged } from '../scripts/session-comment.mjs';
import { applyDiscoveryResult, beginDeepReview, completeDeepReview } from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), C = 'c'.repeat(40);
const clean = (head) => applyDiscoveryResult({ result: { summary: 's', findings: [] }, baseSha: BASE, headSha: head, sourceCommentId: '1' });
const bug = { severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' };
const rework = (head) => applyDiscoveryResult({ result: { summary: 's', findings: [bug] }, baseSha: BASE, headSha: head, sourceCommentId: '1' });

function recorder({ failDelete = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method, url: url.replace('https://api.github.com/repos/acme/p', '') });
    if (init.method === 'DELETE') return failDelete ? new Response('no', { status: 403 }) : new Response(null, { status: 204 });
    return Response.json({ id: init.method === 'POST' ? 900 : 5 });
  };
  return { calls, fetchImpl };
}
const save = (rec, previous, session, existingId = '5') => saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: rec.fetchImpl, existingId, previous, session, body: 'x' });

test('a changed status is posted as the newest comment and the old one removed; an unchanged one is edited in place', async () => {
  const changed = recorder();
  assert.equal(await save(changed, rework(A), { ...rework(A), status: 'READY' }), '900');
  assert.deepEqual(changed.calls.map((c) => `${c.method} ${c.url}`), ['POST /issues/7/comments', 'DELETE /issues/comments/5']);
  const same = recorder();
  assert.equal(await save(same, rework(A), rework(A)), '5');
  assert.deepEqual(same.calls.map((c) => `${c.method} ${c.url}`), ['PATCH /issues/comments/5']);
  const first = recorder();
  assert.equal(await save(first, null, clean(A), null), '900');
  assert.deepEqual(first.calls.map((c) => c.method), ['POST']);
});

test('a different HEAD reviewed with the same status is also a visible change', () => {
  assert.equal(visibleResultChanged(clean(A), clean(C)), true);
  assert.equal(visibleResultChanged(clean(A), clean(A)), false);
});

test('a run in progress is edited in place and judged against what the PR looked like before it started', async () => {
  const before = { ...clean(A), status: 'READY', auditCompleted: true };
  const running = beginDeepReview({ session: before, baseSha: BASE, headSha: A });
  assert.equal(running.deepReview.resumeStatus, 'READY');
  assert.equal(visibleResultChanged(before, running), false); // entering IN_PROGRESS is not announced
  // finishing with the same result on the same HEAD: nothing new to announce
  const same = completeDeepReview({ session: running, result: { summary: 's', findings: [], coverage: { complete: true, unreviewedPaths: [] } }, headSha: A });
  assert.equal(same.status, 'READY');
  assert.equal(visibleResultChanged(running, same), false);
  // finishing with a different status is announced
  const found = completeDeepReview({ session: running, result: { summary: 's', findings: [bug] }, headSha: A });
  assert.equal(visibleResultChanged(running, found), true);
  // a push: the new HEAD's review finishing READY is announced even though READY was READY before
  const next = beginDeepReview({ session: before, baseSha: BASE, headSha: C });
  const done = completeDeepReview({ session: next, result: { summary: 's', findings: [], coverage: { complete: true, unreviewedPaths: [] } }, headSha: C });
  assert.equal(done.status, 'READY');
  assert.equal(visibleResultChanged(next, done), true);
});

test('failing to remove the old comment never fails the save: the new comment is already the newest', async () => {
  const rec = recorder({ failDelete: true });
  assert.equal(await save(rec, rework(A), { ...rework(A), status: 'READY' }), '900');
});
