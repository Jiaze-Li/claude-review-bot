import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyReviewBaseline, planSession, resolveVerificationScope } from '../scripts/plan-review-session.mjs';
import { SINGLE_REQUEST_MAX_BYTES, planShards, splitDiffByFile, stagedFixedBytes, stagedReviewCapacity } from '../scripts/review-shards.mjs';
import { SINGLE_REQUEST_MAX_BYTES as RUNNER_LIMIT } from '../scripts/run-gemini-review.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';
import { runDeepReviewCommand } from '../scripts/deep-review.mjs';
import { applyDiscoveryResult, applyVerificationResult, beginDeepReview, completeDeepReview, parseSessionComment, renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40), OLD = 'a'.repeat(40), NEW = 'c'.repeat(40);
const MB_OLD = '1'.repeat(40), MB_NEW = '2'.repeat(40);
const author = 'jiaze-claude-review-bot[bot]';

const fileDiff = (name, padBytes = 0) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-x\n+${'y'.repeat(padBytes)}\n`;
const smallPrDiff = (n = 11) => Array.from({ length: n }, (_, i) => fileDiff(`src/f${i}.js`)).join('');
const hugeDiff = (n = 25) => Array.from({ length: n }, (_, i) => fileDiff(`big/f${i}.js`, 110_000)).join('');

function finding(title = 'Stale write') {
  return { severity: 'P1', title, body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' };
}
function reworkSession(count = 1) {
  const s = applyDiscoveryResult({ result: { summary: 'bug', findings: [finding()] }, baseSha: BASE, headSha: OLD, sourceCommentId: '1' });
  if (count > 1) {
    s.findings = Array.from({ length: count }, (_, i) => ({ ...s.findings[0], id: `F${String(i + 1).padStart(3, '0')}`, title: `Stale write ${i}`, line: i + 1 }));
    s.nextFindingNumber = count + 1;
  }
  return s;
}
function context({ prDiff = smallPrDiff(), mergeBase = MB_NEW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-baseline-'));
  fs.writeFileSync(path.join(dir, 'pr.diff'), prDiff);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ number: 7, title: 't' }));
  if (mergeBase) fs.writeFileSync(path.join(dir, 'merge-base.txt'), `${mergeBase}\n`);
  return dir;
}
const env = (dir, extra = {}) => ({ GH_TOKEN: 't', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: NEW, REVIEW_CONTEXT_DIR: dir, ...extra });
// Fake GitHub compare: forward = previousHead...head, base = baseSha...previousHead.
function compareFetch({ forward = { status: 'ahead' }, mergeBaseOld = MB_NEW, baseStatus = 200, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (url.includes(`/compare/${OLD}...${NEW}`)) return typeof forward === 'number' ? new Response('x', { status: forward }) : Response.json(forward);
    if (url.includes(`/compare/${BASE}...${OLD}`)) return baseStatus === 200 ? Response.json({ merge_base_commit: { sha: mergeBaseOld } }) : new Response('x', { status: baseStatus });
    assert.fail(`unexpected URL ${url}`);
  };
}
const verificationPlan = (session = reworkSession()) => ({
  requestedMode: 'auto', session,
  decision: { mode: 'verification', previousHead: OLD, reason: 'verify the repair' },
});

test('T1 the unrelated two-point diff overflows the staged limit while the real PR diff fits', () => {
  const twoPoint = hugeDiff(25);
  const cap = stagedReviewCapacity({ diff: twoPoint, fixedBytes: 1000 });
  assert.equal(cap.kind, 'too_large');
  assert.ok(cap.deferred.length > 0);
  const direct = planShards({ files: splitDiffByFile(twoPoint).map((c) => c.path), chunks: splitDiffByFile(twoPoint) });
  assert.ok(direct.deferred.length > 0, 'real planShards also defers files (20+ shards)');
  assert.equal(stagedReviewCapacity({ diff: smallPrDiff(11), fixedBytes: 1000 }).kind, 'single');
});

test('T3/T5 an ordinary fix on the same merge base stays a delta and writes nothing', async () => {
  const dir = context();
  const plan = verificationPlan();
  const calls = [];
  const decision = await resolveVerificationScope({ plan, env: env(dir), fetchImpl: compareFetch({ calls }) });
  assert.deepEqual(decision, plan.decision);
  assert.equal(fs.existsSync(path.join(dir, 'repair.diff')), false);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((u) => u.includes(`/compare/${BASE}...${OLD}`)), 'second compare uses the PR base (not a hard-coded main)');
});

test('T2/T10 a diverged history verifies against the whole current PR diff, findings untouched', async () => {
  const dir = context();
  const plan = verificationPlan();
  const before = JSON.stringify(plan.session);
  const decision = await resolveVerificationScope({ plan, env: env(dir), fetchImpl: compareFetch({ forward: { status: 'diverged' } }) });
  assert.equal(decision.mode, 'verification');
  assert.equal(decision.scope, 'current-pr');
  assert.equal(decision.previousHead, OLD);
  assert.match(decision.reason, /11 files/);
  assert.ok(decision.reason.includes(MB_NEW.slice(0, 7)) && decision.reason.includes(NEW.slice(0, 7)));
  assert.equal(fs.readFileSync(path.join(dir, 'repair.diff'), 'utf8'), fs.readFileSync(path.join(dir, 'pr.diff'), 'utf8'));
  assert.equal(JSON.stringify(plan.session), before);

  // The old finding is closed only by an explicit FIXED, and is kept when the verifier says STILL_OPEN or says nothing.
  const fixed = applyVerificationResult({ session: plan.session, headSha: NEW, result: { summary: 's', findings: [], verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'gone' }] } });
  assert.equal(fixed.findings[0].status, 'FIXED');
  assert.notEqual(fixed.status, 'READY');
  const still = applyVerificationResult({ session: plan.session, headSha: NEW, result: { summary: 's', findings: [], verifications: [{ findingId: 'F001', status: 'STILL_OPEN', reason: 'still' }] } });
  assert.equal(still.findings[0].status, 'OPEN');
  assert.equal(still.status, 'REWORK');
  const omitted = applyVerificationResult({ session: plan.session, headSha: NEW, result: { summary: 's', findings: [], verifications: [] } });
  assert.equal(omitted.findings[0].status, 'OPEN');
});

test('T4 merging the target branch into the PR (ancestor, different merge base) counts as rewritten', async () => {
  const dir = context();
  const decision = await resolveVerificationScope({ plan: verificationPlan(), env: env(dir), fetchImpl: compareFetch({ mergeBaseOld: MB_OLD }) });
  assert.equal(decision.scope, 'current-pr');
  assert.match(decision.reason, /target branch was merged/);
  assert.ok(fs.existsSync(path.join(dir, 'repair.diff')));
});

test('T6 an unreachable old commit is rewritten; server errors and odd answers throw, never a delta', async () => {
  for (const status of [404, 422]) {
    const dir = context();
    const decision = await resolveVerificationScope({ plan: verificationPlan(), env: env(dir), fetchImpl: compareFetch({ forward: status }) });
    assert.equal(decision.scope, 'current-pr', `HTTP ${status}`);
    assert.match(decision.reason, /no longer reachable/);
  }
  for (const forward of [500, 502, 403]) {
    const dir = context();
    await assert.rejects(resolveVerificationScope({ plan: verificationPlan(), env: env(dir), fetchImpl: compareFetch({ forward }) }), /compare failed/);
    assert.equal(fs.existsSync(path.join(dir, 'repair.diff')), false);
  }
  const dir = context();
  await assert.rejects(resolveVerificationScope({ plan: verificationPlan(), env: env(dir), fetchImpl: compareFetch({ baseStatus: 500 }) }), /compare failed/);
  await assert.rejects(resolveVerificationScope({ plan: verificationPlan(), env: env(dir), fetchImpl: compareFetch({ forward: { status: 'weird' } }) }), /Unexpected GitHub compare status/);
  const missing = context({ mergeBase: null });
  await assert.rejects(resolveVerificationScope({ plan: verificationPlan(), env: env(missing), fetchImpl: compareFetch() }), /merge base is missing/);
  await assert.rejects(classifyReviewBaseline({ previousHead: OLD, headSha: NEW, baseSha: BASE, mergeBaseNow: 'nope', target: 'a/b', token: 't', fetchImpl: compareFetch() }), /merge base/);
});

test('T7 a PR too large to verify goes to a sharded review that carries the old OPEN finding as needs-confirmation', async () => {
  const dir = context({ prDiff: hugeDiff(25) });
  const plan = verificationPlan();
  const decision = await resolveVerificationScope({ plan, env: env(dir), fetchImpl: compareFetch({ forward: { status: 'diverged' } }) });
  assert.equal(decision.mode, 'claude');
  assert.equal(decision.carryOpen, true);
  assert.equal(decision.previousHead, null);
  assert.match(decision.reason, /needs confirmation/);
  assert.match(decision.reason, new RegExp(`25 files, base ${MB_NEW.slice(0, 7)}, head ${NEW.slice(0, 7)}`));
  assert.equal(fs.existsSync(path.join(dir, 'repair.diff')), false);

  const begun = beginDeepReview({ session: plan.session, baseSha: BASE, headSha: NEW, carryOpen: decision.carryOpen });
  const carried = begun.findings.find((f) => f.carriedFromId === 'F001');
  assert.ok(carried);
  assert.equal(carried.status, 'UNCERTAIN');
  assert.equal(carried.origin, 'CARRIED_OPEN');
  assert.equal(carried.title, plan.session.findings[0].title);
  const done = completeDeepReview({ session: begun, headSha: NEW, result: { summary: 'clean', findings: [], coverage: { complete: true, unreviewedPaths: [] } } });
  assert.equal(done.status, 'HUMAN_REQUIRED');
  assert.notEqual(done.status, 'READY');
  assert.ok(done.findings.some((f) => f.carriedFromId === 'F001' && f.status === 'UNCERTAIN'));
  // The carried entry survives the durable session comment round trip.
  const reread = parseSessionComment(renderSessionComment(done));
  assert.ok(reread.findings.some((f) => f.carriedFromId === 'F001' && f.origin === 'CARRIED_OPEN' && f.status === 'UNCERTAIN'));
});

test('T7b more than 8 blocking findings stops for a person instead of truncating', async () => {
  const dir = context({ prDiff: hugeDiff(25) });
  const plan = verificationPlan(reworkSession(9));
  const decision = await resolveVerificationScope({ plan, env: env(dir), fetchImpl: compareFetch({ forward: { status: 'diverged' } }) });
  assert.equal(decision.mode, 'human_required');
  assert.equal(decision.carryOpen, undefined);
  assert.match(decision.reason, /9 blocking findings/);
  assert.match(decision.reason, /reset review/);
  assert.match(decision.reason, /override review/);
  assert.doesNotMatch(decision.reason, /dismiss them|confirm or dismiss/);
  assert.match(decision.reason, new RegExp(`25 files, base ${MB_NEW.slice(0, 7)}, head ${NEW.slice(0, 7)}`));
  assert.equal(plan.session.findings.length, 9);
  // Exactly 8 still fits.
  const eight = await resolveVerificationScope({ plan: verificationPlan(reworkSession(8)), env: env(dir), fetchImpl: compareFetch({ forward: { status: 'diverged' } }) });
  assert.equal(eight.mode, 'claude');
  const begun = beginDeepReview({ session: reworkSession(8), baseSha: BASE, headSha: NEW, carryOpen: true });
  assert.equal(begun.findings.length, 8);
});

test('T7c carryOpen is off by default: a full review of a new HEAD still starts without the old OPEN findings', () => {
  const begun = beginDeepReview({ session: reworkSession(), baseSha: BASE, headSha: NEW });
  assert.equal(begun.findings.length, 0);
  assert.equal(JSON.stringify(begun).includes('carriedFromId'), false);
  const explicitFalse = beginDeepReview({ session: reworkSession(), baseSha: BASE, headSha: NEW, carryOpen: false, now: begun.updatedAt });
  assert.deepEqual(explicitFalse.findings, begun.findings);
});

test('T8 planner and staged runner share one capacity rule at the exact boundary', async () => {
  assert.equal(RUNNER_LIMIT, SINGLE_REQUEST_MAX_BYTES);
  const runnerSource = fs.readFileSync(new URL('../scripts/run-gemini-review.mjs', import.meta.url), 'utf8');
  assert.match(runnerSource, /stagedReviewCapacity\(/);
  const session = reworkSession();
  const prJson = JSON.stringify({ number: 7, title: 't' });
  const risk = { version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } };
  const fixed = stagedFixedBytes({ prJson, session, riskProfile: risk });
  const base = fileDiff('one.js');
  const exact = fileDiff('one.js', SINGLE_REQUEST_MAX_BYTES - fixed - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(exact) + fixed, SINGLE_REQUEST_MAX_BYTES);
  for (const [diff, kind] of [[exact, 'single'], [fileDiff('one.js', SINGLE_REQUEST_MAX_BYTES - fixed - Buffer.byteLength(base) + 1), 'sharded']]) {
    assert.equal(stagedReviewCapacity({ diff, fixedBytes: fixed }).kind, kind);
    const dir = context({ prDiff: diff });
    const decision = await resolveVerificationScope({ plan: verificationPlan(session), env: env(dir), fetchImpl: compareFetch({ forward: { status: 'diverged' } }) });
    assert.equal(decision.mode, 'verification', `${kind} still verifies in the staged pipeline`);
  }
});

test('T9 non-main base, auto planning and the CLI wiring all reach the same decision', async () => {
  const otherBase = 'd'.repeat(40);
  const dir = context();
  const comments = [{ id: 1, user: { login: author }, body: renderSessionComment(reworkSession()) }];
  const fetchImpl = async (url) => {
    if (/issues\/7\/comments/.test(url)) return Response.json(comments);
    if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
    if (url.includes(`/compare/${OLD}...${NEW}`)) return Response.json({ status: 'ahead' });
    if (url.includes(`/compare/${otherBase}...${OLD}`)) return Response.json({ merge_base_commit: { sha: MB_OLD } });
    assert.fail(`unexpected URL ${url}`);
  };
  const e = env(dir, { BASE_SHA: otherBase, REQUESTED_MODE: 'auto', EXPECTED_REVIEW_AUTHOR: author });
  const plan = await planSession({ env: e, fetchImpl });
  assert.equal(plan.decision.mode, 'verification');
  const decision = await resolveVerificationScope({ plan, env: e, fetchImpl });
  assert.equal(decision.scope, 'current-pr');
  // Non-verification decisions are never touched.
  const untouched = await resolveVerificationScope({ plan: { decision: { mode: 'claude', previousHead: null, reason: 'x' }, session: null }, env: e, fetchImpl: async () => assert.fail('no network') });
  assert.equal(untouched.mode, 'claude');
  // Every verification decision (auto, retry, threads) leaves the planner through the CLI tail, which resolves its scope first.
  const source = fs.readFileSync(new URL('../scripts/plan-review-session.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('plan.decision = await resolveVerificationScope') > 0
    && source.indexOf('plan.decision = await resolveVerificationScope') < source.indexOf("plan.decision.mode === 'incremental_candidate'"));
});

function threadFetch({ session, resolvedBy = 'jiaze-li' }) {
  return async (url) => {
    if (/issues\/7\/comments/.test(url)) return Response.json([{ id: 7, user: { login: author }, body: renderSessionComment(session) }]);
    if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
    if (url.endsWith('/graphql')) {
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: session.findings.map((f, i) => ({
        id: `T${i}`, isResolved: true, resolvedBy: { login: resolvedBy },
        comments: { nodes: [{ databaseId: i + 1, author: { login: author.replace('[bot]', '') }, body: `x\n\n${findingMarker(f.path, f.title)}` }] },
      })) } } } } });
    }
    if (url.includes('/collaborators/')) return Response.json({ permission: 'write' });
    if (url.includes(`/compare/${OLD}...${NEW}`)) return Response.json({ status: 'diverged' });
    assert.fail(`unexpected URL ${url}`);
  };
}

test('T9 the threads path (a person resolved every blocking thread) also verifies the whole current PR after a rebase', async () => {
  const dir = context();
  const session = reworkSession();
  const e = env(dir, { REQUESTED_MODE: 'threads', SOURCE_KIND: 'pull_request', EXPECTED_REVIEW_AUTHOR: author });
  const fetchImpl = threadFetch({ session });
  const plan = await planSession({ env: e, fetchImpl });
  assert.equal(plan.decision.mode, 'verification');
  assert.equal(plan.decision.previousHead, OLD);
  const decision = await resolveVerificationScope({ plan, env: e, fetchImpl });
  assert.equal(decision.mode, 'verification');
  assert.equal(decision.scope, 'current-pr');
  assert.match(decision.reason, /PR history was rewritten/);
  assert.equal(fs.readFileSync(path.join(dir, 'repair.diff'), 'utf8'), fs.readFileSync(path.join(dir, 'pr.diff'), 'utf8'));
});

test('T9 a manual retry of a provider-unavailable verification also uses the whole current PR after a rebase', async () => {
  const dir = context({ prDiff: hugeDiff(25) });
  const stopped = {
    ...reworkSession(), status: 'HUMAN_REQUIRED',
    reviewFailure: { code: 'REVIEWER_UNAVAILABLE', mode: 'verification', head: OLD, previousHead: OLD, reason: 'provider down' },
  };
  const comments = [{ id: 7, user: { login: author }, body: renderSessionComment(stopped) }];
  const fetchImpl = async (url) => {
    if (/issues\/7\/comments/.test(url)) return Response.json(comments);
    if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
    if (url.includes(`/compare/${OLD}...${NEW}`)) return Response.json({ status: 'diverged' });
    assert.fail(`unexpected URL ${url}`);
  };
  const e = env(dir, { REQUESTED_MODE: 'auto', SOURCE_KIND: 'comment', EXPECTED_REVIEW_AUTHOR: author });
  const plan = await planSession({ env: e, fetchImpl });
  assert.equal(plan.decision.mode, 'verification');
  const decision = await resolveVerificationScope({ plan, env: e, fetchImpl });
  assert.equal(decision.mode, 'claude');
  assert.equal(decision.carryOpen, true);
});

test('the deep-review begin step hands the planner\'s carryOpen to the new session (and defaults to off)', async () => {
  const github = async (url, init = {}) => {
    if (/\/pulls\/7$/.test(url)) return Response.json({ base: { sha: BASE }, head: { sha: NEW } });
    if (init.method === 'POST' || init.method === 'PATCH') return Response.json({ id: 901 });
    if (/\/statuses\//.test(url)) return Response.json({});
    assert.fail(`unexpected ${url}`);
  };
  for (const [carryOpen, expected] of [[true, 1], [undefined, 0]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-carry-'));
    fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
      requestedMode: 'auto', session: reworkSession(), sessionCommentId: '300',
      decision: { mode: 'claude', previousHead: null, reason: 'x', ...(carryOpen ? { carryOpen } : {}) },
    }));
    const begun = await runDeepReviewCommand('begin', {
      env: { TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: NEW, SOURCE_COMMENT_ID: '55', GH_TOKEN: 't', REVIEW_CONTEXT_DIR: dir, GITHUB_OUTPUT: path.join(dir, 'out') },
      fetchImpl: github, now: '2026-11-17T00:00:00.000Z',
    });
    assert.equal(begun.findings.filter((f) => f.carriedFromId === 'F001' && f.status === 'UNCERTAIN').length, expected);
  }
});

test('F001 a carried needs-confirmation finding suppresses a re-report of the same path and title, nothing else', () => {
  const carriedSession = () => beginDeepReview({ session: reworkSession(), baseSha: BASE, headSha: NEW, carryOpen: true });
  const complete = (session, findings) => completeDeepReview({ session, headSha: NEW, result: { summary: 's', findings, coverage: { complete: true, unreviewedPaths: [] } } });
  const same = { ...finding(), title: '  STALE write ' };
  const duplicate = complete(carriedSession(), [same]);
  assert.equal(duplicate.findings.length, 1);
  assert.equal(duplicate.findings[0].status, 'UNCERTAIN');
  assert.equal(duplicate.findings[0].origin, 'CARRIED_OPEN');
  assert.equal(duplicate.status, 'HUMAN_REQUIRED');

  const different = complete(carriedSession(), [{ ...finding('Another bug'), path: 'a.js' }, { ...finding(), path: 'other.js' }]);
  assert.equal(different.findings.length, 3);
  assert.equal(different.findings.filter((f) => f.status === 'OPEN').length, 2);
  assert.equal(different.status, 'REWORK');

  // Any UNCERTAIN carry (including CARRIED_UNCERTAIN) suppresses a duplicate re-report of the same path and title.
  const plain = carriedSession();
  plain.findings = plain.findings.map((f) => ({ ...f, origin: 'CARRIED_UNCERTAIN' }));
  assert.equal(complete(plain, [finding()]).findings.filter((f) => f.status === 'OPEN').length, 0);
});

test('P2 the exits named for a stopped rewritten-history session are the ones that actually work on the new HEAD', async () => {
  const session = reworkSession(9);
  const fetchImpl = async (url) => {
    if (/issues\/7\/comments/.test(url)) return Response.json([{ id: 7, user: { login: author }, body: renderSessionComment(session) }]);
    if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
    assert.fail(`unexpected URL ${url}`);
  };
  const plan = (requested) => planSession({ env: env(context(), { REQUESTED_MODE: requested, SOURCE_KIND: 'comment', EXPECTED_REVIEW_AUTHOR: author }), fetchImpl });
  assert.equal((await plan('dismiss')).decision.mode, 'dismiss', 'dismiss is available on the new HEAD when blocking findings remain');
  assert.equal((await plan('override')).decision.mode, 'override');
  assert.notEqual((await plan('reset')).decision.mode, 'noop_waiting');
});
