import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarkedStale, saveSessionComment, visibleResultChanged } from '../scripts/session-comment.mjs';
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
const save = (rec, previous, session, existingId = '5') => saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: rec.fetchImpl, existingId, previous, session, body: 'x', projectionOnly: true });

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

test('marking a result out of date is a visible change, and a later review clears it', () => {
  const ready = { ...clean(A), status: 'READY', auditCompleted: true };
  const marked = { ...ready, staleFor: A, staleHead: C, staleCommits: 2 };
  assert.equal(visibleResultChanged(ready, marked), true);
  assert.equal(visibleResultChanged(marked, marked), false);
  assert.equal(isMarkedStale(marked), true);
  const reviewedLater = { ...marked, lastReviewedHead: C };
  assert.equal(isMarkedStale(reviewedLater), false); // the mark stops applying by itself
});

// ---- the durable record is written to the PR first, the summary comment second ----------------------------------
import { createFakePr, BOT } from './helpers/fake-pr.mjs';
import { buildLedger } from '../scripts/review-ledger.mjs';

const ledgerOf = (pr) => buildLedger({
  records: [...pr.issue].map((c) => ({ id: c.id, source: 'issue', createdAt: c.createdAt, body: c.body, login: c.user, type: c.type, lastEditedAt: null, minimizedReason: null })),
  botLogin: BOT, reads: { complete: true },
});

test('a save appends a Receipt and a closing Handoff to the PR before the summary comment is touched', async () => {
  const pr = createFakePr();
  const session = rework(A);
  const id = await saveSessionComment({
    target: 'acme/p', prNumber: 7, token: 't', fetchImpl: pr.fetchImpl, existingId: null, previous: null, session,
    body: '<!-- jiaze-review-session:v1 -->\nsummary', ledger: { botLogin: BOT, sourceCommentIds: ['55'], stage: 'first' },
  });
  const order = pr.calls.filter((c) => c.method === 'POST' && /issues\/7\/comments$/.test(c.url));
  assert.equal(order.length, 3); // receipt, handoff, summary
  assert.match(pr.issue[0].body, /^### Review Receipt/);
  assert.match(pr.issue[1].body, /Handoff: COMPLETE/);
  assert.match(pr.issue[2].body, /summary/);
  assert.equal(id, pr.issue[2].id);
  const ledger = ledgerOf(pr);
  assert.equal(ledger.state, 'ok');
  assert.equal(ledger.session.status, 'REWORK');
  assert.ok(ledger.receipts.has('55@created'));
});

test('the same command is never receipted twice and Seq/Prev chain across saves', async () => {
  const pr = createFakePr();
  const save1 = (session, extra = {}) => saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: pr.fetchImpl, session, body: 'summary', existingId: null, ledger: { botLogin: BOT, sourceCommentIds: ['55'], ...extra } });
  await save1(rework(A));
  await save1({ ...rework(A), status: 'READY', auditCompleted: true }, { stage: 'audit' });
  const receipts = pr.issue.filter((c) => /^### Review Receipt/.test(c.body));
  assert.equal(receipts.length, 1);
  const ledger = ledgerOf(pr);
  assert.equal(ledger.state, 'ok');
  assert.deepEqual(ledger.handoffs.map((h) => h.seq), [1, 2]);
});

test('an unreadable ledger stops the save: nothing is written, not even the summary', async () => {
  const pr = createFakePr();
  pr.addIssue('### Review Handoff · Seq 1 · first\nHandoff: COMPLETE\nSeq: 1', {});
  await assert.rejects(() => saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: pr.fetchImpl, session: rework(A), body: 'summary', existingId: null, ledger: { botLogin: BOT } }), /stopped safely/);
  assert.equal(pr.calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !c.url.endsWith('/graphql')).length, 0);
});

test('a plan made at an older handoff is refused instead of overwriting newer work', async () => {
  const pr = createFakePr();
  pr.seed(rework(A));
  await assert.rejects(() => saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: pr.fetchImpl, session: { ...rework(A), status: 'READY', auditCompleted: true }, body: 'summary', existingId: null, ledger: { botLogin: BOT, expectedSeq: 0 } }), /moved while this run was working/);
  assert.equal(pr.issue.length, 1);
});

test('an in-progress review is written as a Run Start that carries the state, never as a closed handoff', async () => {
  const pr = createFakePr();
  const running = beginDeepReview({ session: { ...clean(A), status: 'READY', auditCompleted: true }, baseSha: BASE, headSha: A, reserveUsd: 2, runId: '9' });
  await saveSessionComment({ target: 'acme/p', prNumber: 7, token: 't', fetchImpl: pr.fetchImpl, session: running, body: 'summary', existingId: null, ledger: { botLogin: BOT } });
  assert.match(pr.issue[0].body, /^### Review Run Start/);
  assert.doesNotMatch(pr.issue[0].body, /Handoff: COMPLETE/);
  const ledger = ledgerOf(pr);
  assert.equal(ledger.state, 'ok');
  assert.equal(ledger.session.status, 'REVIEW_IN_PROGRESS');
  assert.equal(ledger.inProgress, true);
  assert.equal(ledger.session.deepReview.reservedUsd, 2);
});
