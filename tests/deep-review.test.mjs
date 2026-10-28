import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEEP_REVIEW_PR_BUDGET_USD, DEEP_REVIEW_STALE_MS, applyDiscoveryResult, beginDeepReview, completeDeepReview,
  deepReviewBudgetLeft, failDeepReview, isDeepReviewStale, planReviewSession, renderSessionComment,
  parseSessionComment, sessionCommitStatus, stopUnavailableReviewSession,
} from '../scripts/review-session-core.mjs';
import { runDeepReviewCommand } from '../scripts/deep-review.mjs';
import { syncCommitStatus } from '../scripts/sync-commit-status.mjs';
import { planSession } from '../scripts/plan-review-session.mjs';
import { closeStaleDeepReview, findStaleDeepReviews } from '../scripts/sweep-stale-deep-reviews.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), C = 'c'.repeat(40);
const T0 = '2026-10-16T08:00:00.000Z';
const finding = (severity, extra = {}) => ({ severity, title: 'Race in cache', body: 'Two writers interleave and corrupt the entry.', path: 'a.js', line: 3, ...extra });
function readySession(head = A) {
  return { ...applyDiscoveryResult({ result: { summary: 'ok', findings: [] }, baseSha: BASE, headSha: head, sourceCommentId: '1' }), status: 'READY', auditCompleted: true };
}

test('begin makes the session REVIEW_IN_PROGRESS and never READY; commit status is pending', () => {
  const s = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  assert.equal(s.status, 'REVIEW_IN_PROGRESS');
  assert.equal(s.deepReview.resumeStatus, 'READY');
  assert.equal(sessionCommitStatus(s, A).state, 'pending');
});

test('deep review with no material findings restores READY; a P2 blocks it', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const clean = completeDeepReview({ session: begun, result: { summary: 'fine', findings: [] }, headSha: A, spentUsd: 0.7 });
  assert.equal(clean.status, 'READY');
  assert.equal(clean.deepSpendUsd, 0.7);
  const bad = completeDeepReview({ session: begun, result: { summary: 'bug', findings: [finding('P2')] }, headSha: A });
  assert.equal(bad.status, 'REWORK');
  assert.equal(bad.findings.at(-1).origin, 'CLAUDE_DEEP');
  assert.equal(sessionCommitStatus(bad, A).state, 'failure');
});

test('P3-only deep findings do not block READY', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const s = completeDeepReview({ session: begun, result: { summary: 'nit', findings: [finding('P3')] }, headSha: A });
  assert.equal(s.status, 'READY');
});

test('deep review refuses to seed a session when none exists for the exact HEAD', () => {
  assert.throws(() => beginDeepReview({ session: null, baseSha: BASE, headSha: A, now: T0 }), /existing review session/);
  assert.throws(() => beginDeepReview({ session: readySession(C), baseSha: BASE, headSha: A, now: T0 }), /existing review session/);
});

test('a result for a different HEAD is refused and never advances the session', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  assert.throws(() => completeDeepReview({ session: begun, result: { summary: 'x', findings: [] }, headSha: C }), /does not match/);
});

test('more than six material findings are refused rather than silently dropped', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const many = Array.from({ length: 7 }, (_, i) => finding('P2', { title: `Bug number ${i} in module` }));
  assert.throws(() => completeDeepReview({ session: begun, result: { summary: 'x', findings: many }, headSha: A }), /more than 6 material/);
});

test('failure ends in HUMAN_REQUIRED, keeps spend, and reports an error status', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const f = failDeepReview({ session: begun, headSha: A, reason: 'budget', spentUsd: 1.9 });
  assert.equal(f.status, 'HUMAN_REQUIRED');
  assert.equal(f.deepSpendUsd, 1.9);
  assert.equal(sessionCommitStatus(f, A).state, 'error');
});

test('per-PR budget is cumulative and bounded', () => {
  assert.equal(deepReviewBudgetLeft({ deepSpendUsd: 1 }), DEEP_REVIEW_PR_BUDGET_USD - 1);
  assert.equal(deepReviewBudgetLeft({ deepSpendUsd: 99 }), 0);
});

test('a new commit invalidates READY and in-progress; status is per exact HEAD', () => {
  const ready = readySession(A);
  assert.equal(sessionCommitStatus(ready, A).state, 'success');
  assert.equal(sessionCommitStatus(ready, C).state, 'pending');
  const inProgress = beginDeepReview({ session: ready, baseSha: BASE, headSha: A, now: T0 });
  assert.equal(planReviewSession({ session: inProgress, baseSha: BASE, headSha: C }).mode, 'incremental_candidate');
  // ...but a push during a deep review on a REWORK session keeps its open findings and rounds.
  const rework = applyDiscoveryResult({ result: { summary: 'bug', findings: [{ severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' }] }, baseSha: BASE, headSha: A, sourceCommentId: '1' });
  const during = beginDeepReview({ session: rework, baseSha: BASE, headSha: A, now: T0 });
  const plan = planReviewSession({ session: during, baseSha: BASE, headSha: C });
  assert.equal(plan.mode, 'verification');
  assert.equal(plan.previousHead, A);
});

test('in-progress waits when fresh and resolves when stale (no infinite wait)', () => {
  const s = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const t = Date.parse(T0);
  assert.equal(planReviewSession({ session: s, baseSha: BASE, headSha: A, now: t + 1000 }).mode, 'noop_waiting');
  assert.equal(isDeepReviewStale(s, t + DEEP_REVIEW_STALE_MS + 1), true);
  assert.equal(planReviewSession({ session: s, baseSha: BASE, headSha: A, now: t + DEEP_REVIEW_STALE_MS + 1 }).mode, 'deep_review_stale');
});

test('a second deep review cannot start over a fresh in-progress one but can replace a stale one', () => {
  const s = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const t = Date.parse(T0);
  assert.throws(() => beginDeepReview({ session: s, baseSha: BASE, headSha: A, now: new Date(t + 1000).toISOString() }), /already in progress/);
  const again = beginDeepReview({ session: s, baseSha: BASE, headSha: A, now: new Date(t + DEEP_REVIEW_STALE_MS + 5).toISOString() });
  assert.equal(again.deepReview.resumeStatus, 'READY');
});

test('the in-progress session survives the comment round trip', () => {
  const s = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const back = parseSessionComment(renderSessionComment(s));
  assert.equal(back.status, 'REVIEW_IN_PROGRESS');
  assert.equal(back.deepReview.head, A);
});

// ---- workflow-facing commands with a fake GitHub ----
function fakeGitHub({ head = A, base = BASE } = {}) {
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    if (/\/pulls\/7$/.test(url)) return Response.json({ base: { sha: base }, head: { sha: head } });
    if (init.method === 'POST' || init.method === 'PATCH') {
      writes.push({ url, method: init.method, body: JSON.parse(init.body) });
      const patched = String(url).match(/comments\/(\d+)$/);
      return Response.json({ id: patched ? Number(patched[1]) : 901 });
    }
    assert.fail('unexpected ' + url);
  };
  return { fetchImpl, writes };
}
function ctxDir(plan, usage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify(plan));
  if (usage) fs.writeFileSync(path.join(dir, 'claude-usage.json'), JSON.stringify(usage));
  return dir;
}
const cenv = (dir, extra = {}) => ({
  TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '55',
  GH_TOKEN: 't', REVIEW_CONTEXT_DIR: dir, ...extra,
});

test('begin -> finalize writes IN_PROGRESS then READY into the same comment', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' }, { total_cost_usd: 0.5 });
  const env = cenv(dir, { GITHUB_OUTPUT: path.join(dir, 'out') });
  const begun = await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(begun.status, 'REVIEW_IN_PROGRESS');
  assert.match(gh.writes[0].body.body, /Status: \*\*REVIEW_IN_PROGRESS\*\*/);
  assert.match(fs.readFileSync(path.join(dir, 'out'), 'utf8'), /run=true/);
  assert.doesNotMatch(gh.writes[0].body.body, /jiaze-review-source-comment/);
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ summary: 'fine', findings: [] }));
  const done = await runDeepReviewCommand('finalize', { env: { ...env, REVIEW_PATH: path.join(dir, 'review.json') }, fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(done.status, 'READY');
  assert.equal(done.deepSpendUsd, 0.5);
  assert.equal(gh.writes[1].url.endsWith('/issues/comments/300'), true);
  assert.match(gh.writes[1].body.body, /jiaze-review-source-comment:55/);
});

test('manual @claude review runs with $5 limit even after exhausting the automatic PR cap', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: { ...readySession(), deepSpendUsd: 6 }, sessionCommentId: '300' });
  const env = cenv(dir, { GITHUB_OUTPUT: path.join(dir, 'out') });
  const s = await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(s.status, 'REVIEW_IN_PROGRESS');
  assert.equal(s.deepSpendUsd, 11);
  assert.match(fs.readFileSync(path.join(dir, 'out'), 'utf8'), /run=true/);
  assert.match(fs.readFileSync(path.join(dir, 'out'), 'utf8'), /run_budget_usd=5.00/);
});

test('fail closes an in-progress run to HUMAN_REQUIRED and accounts the spend', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' }, { total_cost_usd: 1.2 });
  const env = cenv(dir, { GITHUB_OUTPUT: path.join(dir, 'out') });
  await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  const f = await runDeepReviewCommand('fail', { env: { ...env, DEEP_REVIEW_FAILURE_REASON: 'turn limit' }, fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(f.status, 'HUMAN_REQUIRED');
  assert.equal(f.deepSpendUsd, 1.2);
});

test('a stale in-progress marker from a dead run is failed by the next trigger', async () => {
  const gh = fakeGitHub();
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 1.25, now: T0 });
  const dir = ctxDir({ decision: { mode: 'deep_review_stale' }, session: stale, sessionCommentId: '300' });
  const later = new Date(Date.parse(T0) + DEEP_REVIEW_STALE_MS + 1000).toISOString();
  const f = await runDeepReviewCommand('fail', { env: cenv(dir), fetchImpl: gh.fetchImpl, now: later });
  assert.equal(f.status, 'HUMAN_REQUIRED');
  assert.equal(f.deepSpendUsd, 1.25); // unknown spend of a dead run stays charged at what that run reserved
});

test('fail never touches a fresh in-progress marker owned by another live run', async () => {
  const gh = fakeGitHub();
  const fresh = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  for (const mode of ['claude', 'deep_review_stale']) {
    const dir = ctxDir({ decision: { mode }, session: fresh, sessionCommentId: '300' });
    const r = await runDeepReviewCommand('fail', { env: cenv(dir), fetchImpl: gh.fetchImpl, now: T0 });
    assert.equal(r, null);
  }
  assert.equal(gh.writes.length, 0);
});

test('a killed run with no usage file is charged its allotted budget', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' });
  const env = cenv(dir, { GITHUB_OUTPUT: path.join(dir, 'out'), DEEP_REVIEW_MAX_BUDGET_USD: '1.50' });
  await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  const f = await runDeepReviewCommand('fail', { env, fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(f.deepSpendUsd, 1.5);
});

test('if the PR moved, begin refuses and fail leaves the superseded marker alone', async () => {
  const moved = fakeGitHub({ head: C });
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' });
  await assert.rejects(() => runDeepReviewCommand('begin', { env: cenv(dir), fetchImpl: moved.fetchImpl, now: T0 }), /PR moved/);
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const dir2 = ctxDir({ decision: { mode: 'deep_review_stale' }, session: stale, sessionCommentId: '300' });
  const r = await runDeepReviewCommand('fail', { env: cenv(dir2), fetchImpl: moved.fetchImpl, now: T0 });
  assert.equal(r, null);
  assert.equal(moved.writes.length, 0);
});

// ---- required status check ----
function statusFetch(session, posted) {
  return async (url, init = {}) => {
    if (/issues\/7\/comments/.test(url)) {
      return Response.json(session ? [{ id: 1, user: { login: 'bot[bot]' }, body: renderSessionComment(session) }] : []);
    }
    if (/statuses\//.test(url)) { posted.push({ url, body: JSON.parse(init.body) }); return Response.json({}); }
    assert.fail('unexpected ' + url);
  };
}
const senv = (extra = {}) => ({ TARGET_REPO: 'acme/project', PR_NUMBER: '7', HEAD_SHA: A, GH_TOKEN: 't', STATUS_TOKEN: 's', EXPECTED_REVIEW_AUTHOR: 'bot[bot]', ...extra });

test('READY on this HEAD posts success; a different HEAD stays pending', async () => {
  const posted = [];
  await syncCommitStatus({ env: senv(), fetchImpl: statusFetch(readySession(A), posted) });
  assert.equal(posted[0].body.state, 'success');
  assert.equal(posted[0].body.context, 'claude-review-bot/review');
  const other = [];
  await syncCommitStatus({ env: senv({ HEAD_SHA: C }), fetchImpl: statusFetch(readySession(A), other) });
  assert.equal(other[0].body.state, 'pending');
});

test('a failed run with no session for the HEAD reports error instead of pending forever', async () => {
  const posted = [];
  await syncCommitStatus({ env: senv({ JOB_FAILED: 'true' }), fetchImpl: statusFetch(null, posted) });
  assert.equal(posted[0].body.state, 'error');
});

test('strict mode refuses to continue when the required status cannot be posted', async () => {
  await assert.rejects(() => syncCommitStatus({ env: senv({ STATUS_TOKEN: '', STATUS_STRICT: 'true' }), fetchImpl: async () => assert.fail('no calls') }), /permission/);
  await assert.rejects(() => syncCommitStatus({
    env: senv({ STATUS_STRICT: 'true' }),
    fetchImpl: async (url) => /comments/.test(url) ? Response.json([]) : new Response('no', { status: 403 }),
  }), /not posted/);
});

test('missing status token never breaks the review and says so', async () => {
  const r = await syncCommitStatus({ env: senv({ STATUS_TOKEN: '' }), fetchImpl: async () => assert.fail('no calls expected') });
  assert.equal(r, null);
});

test('auto stale marker is planned as deep_review_stale from the comment', async () => {
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: '2020-01-01T00:00:00.000Z' });
  const plan = await planSession({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, REQUESTED_MODE: 'auto', EXPECTED_REVIEW_AUTHOR: 'bot[bot]' },
    fetchImpl: async (url) => /comments/.test(url)
      ? Response.json([{ id: 4, user: { login: 'bot[bot]' }, body: renderSessionComment(stale) }])
      : Response.json([]),
  });
  assert.equal(plan.decision.mode, 'deep_review_stale');
});

test('the run budget is reserved at begin so an interrupted run still counts against the PR cap', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: { ...readySession(), deepSpendUsd: 3 }, sessionCommentId: '300' });
  const s = await runDeepReviewCommand('begin', { env: cenv(dir, { GITHUB_OUTPUT: path.join(dir, 'out') }), fetchImpl: gh.fetchImpl, now: T0 });
  assert.equal(s.deepSpendUsd, 8); // 3 already spent + 5 reserved
  assert.equal(parseSessionComment(gh.writes[0].body.body).deepSpendUsd, 8);
});

test('reservation is reconciled to actual spend on success and kept when actual is unknown', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 2, now: T0 });
  assert.equal(begun.deepSpendUsd, 2);
  assert.equal(completeDeepReview({ session: begun, result: { summary: 'ok', findings: [] }, headSha: A, spentUsd: 0.4 }).deepSpendUsd, 0.4);
  assert.equal(failDeepReview({ session: begun, headSha: A, reason: 'x', spentUsd: 2 }).deepSpendUsd, 2);
});

test('Claude blocker is not suppressed by a concern Gemini already rejected', () => {
  let s = readySession();
  s = { ...s, findings: [{ id: 'F001', severity: 'P2', title: 'Race in cache', body: 'x', path: 'a.js', line: 3, riskClass: 'r', status: 'DISMISSED', origin: 'DISCOVERY', introducedHead: A, lastCheckedHead: A, resolutionReason: 'rejected' }],
    dismissed: [{ title: 'Race in cache', path: 'a.js', riskClass: 'r', reason: 'rejected' }] };
  const begun = beginDeepReview({ session: s, baseSha: BASE, headSha: A, now: T0 });
  const done = completeDeepReview({ session: begun, result: { summary: 'bug', findings: [finding('P1')] }, headSha: A });
  assert.equal(done.status, 'REWORK');
  assert.equal(done.findings.at(-1).origin, 'CLAUDE_DEEP');
});

test('begin posts the pending status BEFORE the durable write, so a failed write cannot leave an old green', async () => {
  const order = [];
  const fetchImpl = async (url, init = {}) => {
    if (/\/pulls\/7$/.test(url)) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (/statuses\//.test(url)) { order.push('status:' + JSON.parse(init.body).state); return Response.json({}); }
    if (init.method === 'PATCH') { order.push('write'); return new Response('boom', { status: 500 }); }
    assert.fail('unexpected ' + url);
  };
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' });
  await assert.rejects(() => runDeepReviewCommand('begin', { env: cenv(dir, { STATUS_TOKEN: 's' }), fetchImpl, now: T0 }), /HTTP 500/);
  assert.deepEqual(order, ['status:pending', 'write']);
});

test('strict mode: begin refuses to start when the pending status cannot be posted', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' });
  await assert.rejects(() => runDeepReviewCommand('begin', { env: cenv(dir, { STATUS_STRICT: 'true' }), fetchImpl: gh.fetchImpl, now: T0 }), /permission/);
  assert.equal(gh.writes.length, 0);
});

test('final mirror turns a stale READY into error when the attempted deep review job failed', async () => {
  const posted = [];
  await syncCommitStatus({ env: senv({ DEEP_REVIEW_ATTEMPTED: 'true', JOB_FAILED: 'true' }), fetchImpl: statusFetch(readySession(A), posted) });
  assert.equal(posted[0].body.state, 'error');
  const ok = [];
  await syncCommitStatus({ env: senv({ DEEP_REVIEW_ATTEMPTED: 'true' }), fetchImpl: statusFetch(readySession(A), ok) });
  assert.equal(ok[0].body.state, 'success');
});

function sweepFetch({ repos, prs, comments, onWrite, liveHead = {} }) {
  return async (url, init = {}) => {
    if (/installation\/repositories/.test(url)) return Response.json({ repositories: repos });
    const pull = String(url).match(/repos\/([^/]+\/[^/]+)\/pulls\?state=open/);
    if (pull) return Response.json(prs[pull[1]] ?? []);
    const live = String(url).match(/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (live) return Response.json({ head: { sha: liveHead[`${live[1]}#${live[2]}`] ?? prs[live[1]].find((p) => String(p.number) === live[2]).head.sha } });
    const one = String(url).match(/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
    if (one && !init.method) return Response.json(Object.values(comments).flat().find((c) => String(c.id) === one[2]));
    const list = String(url).match(/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments/);
    if (list) return Response.json(comments[`${list[1]}#${list[2]}`] ?? []);
    if (init.method) { onWrite({ url, method: init.method, body: JSON.parse(init.body) }); return Response.json({}); }
    assert.fail('unexpected ' + url);
  };
}

test('sweeper finds stale deep reviews across installed repositories without any configured list', async () => {
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 2, now: '2020-01-01T00:00:00.000Z' });
  const fresh = beginDeepReview({ session: readySession(C), baseSha: BASE, headSha: C, reserveUsd: 2, now: new Date().toISOString() });
  const fetchImpl = sweepFetch({
    repos: [{ full_name: 'acme/project' }, { full_name: 'acme/second' }, { full_name: 'acme/old', archived: true }],
    prs: {
      'acme/project': [{ number: 7, head: { sha: A } }, { number: 8, head: { sha: C } }, { number: 9, head: { sha: C } }],
      'acme/second': [{ number: 3, head: { sha: A } }],
    },
    comments: {
      'acme/project#7': [{ id: 70, user: { login: 'bot[bot]' }, body: renderSessionComment(stale) }],
      'acme/project#8': [{ id: 80, user: { login: 'bot[bot]' }, body: renderSessionComment(fresh) }],
      'acme/project#9': [{ id: 90, user: { login: 'bot[bot]' }, body: renderSessionComment(stale) }],
      'acme/second#3': [{ id: 30, user: { login: 'bot[bot]' }, body: renderSessionComment(stale) }],
    },
    onWrite: () => assert.fail('find must never write'),
  });
  const found = await findStaleDeepReviews({ env: { EXPECTED_REVIEW_AUTHOR: 'bot[bot]', GH_TOKEN: 't' }, fetchImpl });
  assert.deepEqual(found, [{ repo: 'acme/project', pr: 7 }, { repo: 'acme/second', pr: 3 }]);
});

test('close fails a stale review closed and posts an error status', async () => {
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 2, now: '2020-01-01T00:00:00.000Z' });
  const writes = [];
  const fetchImpl = sweepFetch({
    repos: [], prs: { 'acme/project': [{ number: 7, head: { sha: A } }] },
    comments: { 'acme/project#7': [{ id: 70, user: { login: 'bot[bot]' }, body: renderSessionComment(stale) }] },
    onWrite: (w) => writes.push(w),
  });
  const ok = await closeStaleDeepReview({ repo: 'acme/project', prNumber: 7, env: { EXPECTED_REVIEW_AUTHOR: 'bot[bot]', GH_TOKEN: 't', STATUS_TOKEN: 's' }, fetchImpl });
  assert.equal(ok, true);
  assert.match(writes[0].body.body, /Status: \*\*HUMAN_REQUIRED\*\*/);
  assert.equal(writes[1].body.state, 'error');
});

test('close inside the lock leaves alone a review that was restarted or moved since the scan', async () => {
  const stale = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 2, now: '2020-01-01T00:00:00.000Z' });
  const restarted = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, reserveUsd: 2, now: new Date().toISOString() });
  for (const [label, body, liveHead] of [['restarted', renderSessionComment(restarted), A], ['moved', renderSessionComment(stale), C]]) {
    const writes = [];
    const fetchImpl = sweepFetch({
      repos: [], prs: { 'acme/project': [{ number: 7, head: { sha: A } }] },
      comments: { 'acme/project#7': [{ id: 70, user: { login: 'bot[bot]' }, body }] },
      liveHead: { 'acme/project#7': liveHead },
      onWrite: (w) => writes.push(w),
    });
    const ok = await closeStaleDeepReview({ repo: 'acme/project', prNumber: 7, env: { EXPECTED_REVIEW_AUTHOR: 'bot[bot]', GH_TOKEN: 't', STATUS_TOKEN: 's' }, fetchImpl });
    assert.equal(ok, false, label);
    assert.equal(writes.length, 0, label);
  }
});

test('the sweeper close job shares the main review workflow PR lock, queues instead of cancelling, and runs different PRs in parallel', () => {
  const sweep = fs.readFileSync(new URL('../.github/workflows/sweep-stale-deep-reviews.yml', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.match(main, /group: independent-review-\$\{\{ inputs\.target_repo \}\}-\$\{\{ inputs\.pr_number \}\}\n  cancel-in-progress: false\n(?:  #.*\n)*  queue: max/);
  assert.match(sweep, /group: independent-review-\$\{\{ matrix\.repo \}\}-\$\{\{ matrix\.pr \}\}\n      cancel-in-progress: false\n      queue: max/);
  assert.match(sweep, /max-parallel: 4/);
});

test('the Claude step is bounded below the whole job timeout so publish and cleanup still have time', () => {
  const main = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const step = main.slice(main.indexOf('- name: Run Claude explicit deep review'));
  const stepMinutes = Number(step.match(/timeout-minutes: (\d+)/)[1]);
  const jobMinutes = Number(main.match(/\n    timeout-minutes: (\d+)/)[1]);
  assert.equal(stepMinutes, 20);
  assert.ok(stepMinutes + 5 <= jobMinutes);
  assert.equal(DEEP_REVIEW_STALE_MS, 20 * 60 * 1000);
});

test('successful manual Claude review recovers a provider-unavailable audited HEAD to READY',()=>{
  const stopped=stopUnavailableReviewSession({session:readySession(),baseSha:BASE,headSha:A,
    sourceCommentId:'40',mode:'incremental',reason:'providers unavailable'});
  assert.equal(stopped.status,'HUMAN_REQUIRED');
  const begun=beginDeepReview({session:stopped,baseSha:BASE,headSha:A,now:T0,reserveUsd:2});
  const done=completeDeepReview({session:begun,result:{summary:'independent review clean',findings:[]},
    headSha:A,spentUsd:0.7,costSource:'sdk'});
  assert.equal(done.status,'READY');
  assert.equal(done.reviewFailure,undefined);
  assert.equal(done.deepSpendUsd,0.7);
  assert.equal(done.claudeSdkSpendUsd,0.7);
  assert.equal(sessionCommitStatus(done,A).state,'success');
});

test('manual Claude cannot turn an unfinished discovery/final audit or material bug directly READY',()=>{
  const discovery=applyDiscoveryResult({result:{summary:'clean',findings:[]},
    baseSha:BASE,headSha:A,sourceCommentId:'40'});
  const stopped=stopUnavailableReviewSession({session:discovery,baseSha:BASE,headSha:A,
    sourceCommentId:'42',mode:'audit',reason:'providers unavailable'});
  const begun=beginDeepReview({session:stopped,baseSha:BASE,headSha:A,now:T0});
  const clean=completeDeepReview({session:begun,result:{summary:'clean',findings:[]},headSha:A});
  assert.equal(clean.status,'AUDIT_PENDING');
  const found=completeDeepReview({session:begun,result:{summary:'bug',findings:[finding('P2')]},headSha:A});
  assert.equal(found.status,'REWORK');
  assert.equal(sessionCommitStatus(found,A).state,'failure');
});

test('partial coverage never reaches READY, names the unreviewed files, and a complete re-run clears it', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const partial = completeDeepReview({
    session: begun, headSha: A,
    result: { summary: 'ran out of budget', findings: [], coverage: { complete: false, unreviewedPaths: ['ui/Layout.swift'], note: 'budget' } },
  });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(sessionCommitStatus(partial, A).state, 'error');
  assert.deepEqual(partial.coverage.unreviewedPaths, ['ui/Layout.swift']);
  const body = renderSessionComment(partial);
  assert.match(body, /Review coverage: \*\*PARTIAL\*\*/);
  assert.match(body, /ui\/Layout\.swift/);
  // The same HEAD waits for a manual re-run; a new HEAD restarts bounded discovery.
  assert.equal(planReviewSession({ session: partial, baseSha: BASE, headSha: A }).mode, 'noop_waiting');
  assert.equal(planReviewSession({ session: partial, baseSha: BASE, headSha: C }).mode, 'discovery');
  const rerun = completeDeepReview({
    session: beginDeepReview({ session: partial, baseSha: BASE, headSha: A, now: T0 }), headSha: A,
    result: { summary: 'all covered', findings: [], coverage: { complete: true, unreviewedPaths: [], note: '' } },
  });
  assert.equal(rerun.status, 'READY');
  assert.equal(rerun.coverage, undefined);
});

test('a model claiming complete while listing unreviewed files is still PARTIAL; open findings outrank PARTIAL', () => {
  const begun = beginDeepReview({ session: readySession(), baseSha: BASE, headSha: A, now: T0 });
  const lying = completeDeepReview({
    session: begun, headSha: A,
    result: { summary: 's', findings: [], coverage: { complete: true, unreviewedPaths: ['x.swift'] } },
  });
  assert.equal(lying.status, 'PARTIAL');
  const bug = completeDeepReview({
    session: begun, headSha: A,
    result: { summary: 's', findings: [finding('P2')], coverage: { complete: false, unreviewedPaths: ['x.swift'] } },
  });
  assert.equal(bug.status, 'REWORK');
});

test('standalone @claude review needs no Gemini session: complete pass is READY with the audit marked done', () => {
  const begun = beginDeepReview({ session: null, baseSha: BASE, headSha: A, standalone: true, now: T0 });
  assert.equal(begun.status, 'REVIEW_IN_PROGRESS');
  assert.equal(begun.deepReview.standalone, true);
  const done = completeDeepReview({
    session: begun, headSha: A,
    result: { summary: 'clean', findings: [], coverage: { complete: true, unreviewedPaths: [], note: '' } },
  });
  assert.equal(done.status, 'READY');
  assert.equal(done.auditCompleted, true);
  assert.equal(sessionCommitStatus(done, A).state, 'success');
  // Partial coverage or a P2 still blocks a standalone review.
  const partial = completeDeepReview({ session: begun, headSha: A, result: { summary: 's', findings: [], coverage: { complete: false, unreviewedPaths: ['x'] } } });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(completeDeepReview({ session: begun, headSha: A, result: { summary: 's', findings: [finding('P2')] } }).status, 'REWORK');
});

test('standalone review on a new HEAD starts fresh but keeps the PR spend ledger; non-standalone still requires a session', () => {
  const old = { ...readySession(C), deepSpendUsd: 4, claudeSdkSpendUsd: 3 };
  const begun = beginDeepReview({ session: old, baseSha: BASE, headSha: A, standalone: true, reserveUsd: 5, now: T0 });
  assert.equal(begun.lastReviewedHead, A);
  assert.equal(begun.deepSpendUsd, 9);
  assert.equal(begun.claudeSdkSpendUsd, 3);
  assert.equal(begun.findings.length, 0);
  assert.throws(() => beginDeepReview({ session: old, baseSha: BASE, headSha: A, now: T0 }), /requires an existing review session/);
});

test('a standalone review re-run after PARTIAL keeps its standalone marker and reaches READY', () => {
  const first = beginDeepReview({ session: null, baseSha: BASE, headSha: A, standalone: true, now: T0 });
  const partial = completeDeepReview({ session: first, headSha: A, result: { summary: 's', findings: [], coverage: { complete: false, unreviewedPaths: ['x'] } } });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.auditCompleted, false);
  const rerun = beginDeepReview({ session: partial, baseSha: BASE, headSha: A, now: T0 });
  assert.equal(rerun.deepReview.standalone, true);
  const done = completeDeepReview({ session: rerun, headSha: A, result: { summary: 's', findings: [], coverage: { complete: true, unreviewedPaths: [] } } });
  assert.equal(done.status, 'READY');
  assert.equal(done.auditCompleted, true);
});

test('a deep review that failed closed can be retried and recovers; findings-based HUMAN_REQUIRED stays sticky', () => {
  const failed = failDeepReview({
    session: beginDeepReview({ session: null, baseSha: BASE, headSha: A, standalone: true, now: T0 }),
    headSha: A, reason: 'timed out',
  });
  assert.equal(failed.status, 'HUMAN_REQUIRED');
  const retry = beginDeepReview({ session: failed, baseSha: BASE, headSha: A, now: T0 });
  assert.equal(retry.deepReview.resumeStatus, 'AUDIT_PENDING');
  const done = completeDeepReview({ session: retry, headSha: A, result: { summary: 's', findings: [], coverage: { complete: true, unreviewedPaths: [] } } });
  assert.equal(done.status, 'READY');
  // A HUMAN_REQUIRED that came from elsewhere (here a provider failure) is not cleared by this path.
  const other = { ...failed, reviewFailure: { code: 'REVIEWER_UNAVAILABLE', mode: 'discovery', head: A, reason: 'x' } };
  assert.equal(beginDeepReview({ session: other, baseSha: BASE, headSha: A, now: T0 }).deepReview.resumeStatus, 'HUMAN_REQUIRED');
});
