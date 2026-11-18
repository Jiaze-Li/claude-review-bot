import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findingMarker } from '../scripts/review-anchors.mjs';
import { adoptOrphanFindings, findOrphanBotThreads, parseBotThreadBody } from '../scripts/review-threads.mjs';
import { reconcileOrphanThreads } from '../scripts/plan-review-session.mjs';
import { applyDiscoveryResult, applyVerificationResult, renderSessionComment } from '../scripts/review-session-core.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';
import { syncReviewThreads } from '../scripts/sync-review-threads.mjs';
import { SINGLE_REQUEST_MAX_BYTES } from '../scripts/review-shards.mjs';

const BASE = '1'.repeat(40);
const HEAD_OLD = '2'.repeat(40);
const HEAD_NEW = '3'.repeat(40);
const BOT_AUTHOR = 'jiaze-claude-review-bot[bot]';
const BOT_LOGIN = 'jiaze-claude-review-bot';

function makeContextDir(files = ['src/a.js', 'src/b.js']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-orphan-'));
  const prDiff = files.map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n-old\n+new\n`).join('');
  fs.writeFileSync(path.join(dir, 'pr.diff'), prDiff);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ title: 'PR', body: 'Test' }));
  return dir;
}

function makeEnv(contextDir, extra = {}) {
  return {
    TARGET_REPO: 'owner/repo',
    PR_NUMBER: '42',
    BASE_SHA: BASE,
    HEAD_SHA: HEAD_NEW,
    EXPECTED_REVIEW_AUTHOR: BOT_AUTHOR,
    GH_TOKEN: 'tok',
    REVIEW_CONTEXT_DIR: contextDir,
    ...extra,
  };
}

function makeBotThread({ id = 'T1', path: filePath = 'src/a.js', line = 2, isOutdated = false, isResolved = false, resolvedBy = null, severity = 'P2', title = 'Bug title', body = 'Concrete bug explanation.', findingId = null, riskClass = null, snapped = false, author = BOT_LOGIN, markerOverride = null } = {}) {
  const header = findingId ? `**[${findingId} · ${severity}] ${title}**` : `**[${severity}] ${title}**`;
  const parts = [header, body];
  if (riskClass) parts.push(`Risk class: ${riskClass}`);
  if (snapped) parts.push('_Pinned to the nearest changed line: line 10 is outside the changed lines._');
  parts.push(markerOverride ?? findingMarker(filePath, title));
  return {
    id,
    path: filePath,
    line,
    isOutdated,
    isResolved,
    resolvedBy: resolvedBy ? { login: resolvedBy } : null,
    comments: {
      nodes: [{
        databaseId: Number(String(id).replace(/\D/g, '') || 100),
        author: { login: author },
        body: parts.join('\n\n'),
      }],
    },
  };
}

function graphqlFetch(threads, mutations = []) {
  return async (url, init = {}) => {
    if (url.endsWith('/graphql')) {
      const payload = JSON.parse(init.body || '{}');
      const query = String(payload.query || '');
      if (query.includes('unresolveReviewThread')) {
        mutations.push({ type: 'unresolve', id: payload.variables.id });
        return Response.json({ data: { unresolveReviewThread: { thread: { id: payload.variables.id, isResolved: false } } } });
      }
      if (query.includes('resolveReviewThread')) {
        mutations.push({ type: 'resolve', id: payload.variables.id });
        return Response.json({ data: { resolveReviewThread: { thread: { id: payload.variables.id, isResolved: true } } } });
      }
      return Response.json({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } },
      });
    }
    if (url.includes('/replies')) {
      const body = JSON.parse(init.body || '{}').body;
      mutations.push({ type: 'reply', url, body });
      return Response.json({ id: 999 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function baseSession(status = 'AUDIT_PENDING', findings = []) {
  const session = applyDiscoveryResult({
    baseSha: BASE,
    headSha: HEAD_OLD,
    result: { summary: 'Prior review', findings },
  });
  return { ...session, status, auditCompleted: status === 'READY' };
}

test('AC1: recognizes old bot threads missing from session, adopts them, switches to verification, and renders counts', async () => {
  const dir = makeContextDir(['src/a.js', 'src/b.js']);
  const session = baseSession('AUDIT_PENDING');
  const threads = [
    makeBotThread({ id: 'T1', path: 'src/a.js', severity: 'P2', title: 'Missing null guard', findingId: 'F001', riskClass: 'correctness', snapped: true }),
    makeBotThread({ id: 'T2', path: 'src/b.js', severity: 'P1', title: 'Unchecked write' }),
    makeBotThread({ id: 'T3', path: 'src/a.js', severity: 'P2', title: 'Race on save' }),
    makeBotThread({ id: 'T4', path: 'src/b.js', severity: 'P3', title: 'Minor cleanup' }),
  ];

  const plan = {
    requestedMode: 'auto',
    decision: { mode: 'claude', previousHead: null, reason: 'PR changed before final audit' },
    session,
    sessionCommentId: '7',
  };

  const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch(threads) });
  assert.equal(next.decision.mode, 'verification');
  assert.equal(next.decision.scope, 'current-pr');
  assert.equal(next.session.status, 'AUDIT_PENDING'); // I3: session.status not mutated by adoption
  assert.equal(next.session.findings.length, 4);
  assert.ok(next.session.findings.every((f) => f.origin === 'THREAD_ORPHAN' && f.status === 'OPEN' && f.introducedHead === HEAD_NEW));
  assert.equal(next.orphanReconcile.found, 4);
  assert.equal(next.orphanReconcile.adopted, 4);
  assert.ok(fs.existsSync(path.join(dir, 'repair.diff')));

  const comment = renderSessionComment(next.session, { orphanReconcile: next.orphanReconcile });
  assert.match(comment, /Old bot threads reconciled: found \*\*4\*\* — verified \*\*0\*\* fixed \(closed\), \*\*4\*\* still open/);
});

test('AC2: verification resolves FIXED orphans and keeps STILL_OPEN/omitted orphans open fail-closed', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('REWORK');
  const threads = [
    makeBotThread({ id: 'T1', path: 'src/a.js', severity: 'P2', title: 'Fixed issue' }),
    makeBotThread({ id: 'T2', path: 'src/a.js', severity: 'P2', title: 'Still broken' }),
    makeBotThread({ id: 'T3', path: 'src/a.js', severity: 'P2', title: 'Omitted by verifier' }),
  ];
  const plan = await reconcileOrphanThreads({
    plan: { requestedMode: 'auto', decision: { mode: 'verification', previousHead: HEAD_OLD, reason: 'verify' }, session, sessionCommentId: '7' },
    env: makeEnv(dir),
    fetchImpl: graphqlFetch(threads),
  });

  const verified = applyVerificationResult({
    session: plan.session,
    headSha: HEAD_NEW,
    result: {
      summary: 'Checked 3 orphans',
      verifications: [
        { findingId: 'F001', status: 'FIXED', reason: 'Guard added' },
        { findingId: 'F002', status: 'STILL_OPEN', reason: 'Still missing check' },
        // F003 omitted -> must stay OPEN fail-closed
      ],
      findings: [],
    },
  });

  assert.equal(verified.status, 'REWORK');
  assert.equal(verified.findings.find((f) => f.id === 'F001').status, 'FIXED');
  assert.equal(verified.findings.find((f) => f.id === 'F002').status, 'OPEN');
  assert.equal(verified.findings.find((f) => f.id === 'F003').status, 'OPEN');
  assert.match(verified.findings.find((f) => f.id === 'F003').resolutionReason, /fail-closed/);

  const comment = renderSessionComment(verified, { orphanReconcile: plan.orphanReconcile });
  assert.match(comment, /Old bot threads reconciled: found \*\*3\*\* — verified \*\*1\*\* fixed \(closed\), \*\*2\*\* still open/);

  const mutations = [];
  const pr = createFakePr({ author: BOT_AUTHOR, number: 42 });
  pr.seed(verified);
  const syncFetch = pr.layer(graphqlFetch(threads, mutations));
  const syncResult = await syncReviewThreads({ env: makeEnv(dir, { REVIEW_MODE: 'verification' }), fetchImpl: syncFetch, log: { log() {}, warn() {} } });
  assert.equal(syncResult.resolved, 1);
  assert.deepEqual(mutations.filter((m) => m.type === 'resolve'), [{ type: 'resolve', id: 'T1' }]);
});

test('AC3: human-resolved orphan still open is reopened with reply; bot-resolved thread is ignored', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('REWORK');
  const threads = [
    makeBotThread({ id: 'T_HUMAN', path: 'src/a.js', severity: 'P2', title: 'Human resolved prematurely', isResolved: true, resolvedBy: 'alice' }),
    makeBotThread({ id: 'T_BOT', path: 'src/a.js', severity: 'P2', title: 'Bot already closed', isResolved: true, resolvedBy: BOT_LOGIN }),
  ];

  const found = findOrphanBotThreads({ session, threads, botLogin: BOT_LOGIN });
  assert.equal(found.orphans.length, 1);
  assert.equal(found.orphans[0].threadId, 'T_HUMAN');

  const plan = await reconcileOrphanThreads({
    plan: { requestedMode: 'auto', decision: { mode: 'verification', previousHead: HEAD_OLD, reason: 'verify' }, session, sessionCommentId: '7' },
    env: makeEnv(dir),
    fetchImpl: graphqlFetch(threads),
  });
  const verified = applyVerificationResult({
    session: plan.session,
    headSha: HEAD_NEW,
    result: {
      summary: 'Still broken',
      verifications: [{ findingId: 'F001', status: 'STILL_OPEN', reason: 'Issue persists' }],
      findings: [],
    },
  });

  const mutations = [];
  const pr = createFakePr({ author: BOT_AUTHOR, number: 42 });
  pr.seed(verified);
  const syncFetch = pr.layer(graphqlFetch(threads, mutations));
  const syncResult = await syncReviewThreads({ env: makeEnv(dir, { REVIEW_MODE: 'verification' }), fetchImpl: syncFetch, log: { log() {}, warn() {} } });
  assert.equal(syncResult.reopened, 1);
  assert.equal(mutations[0].type, 'unresolve');
  assert.equal(mutations[0].id, 'T_HUMAN');
  assert.equal(mutations[1].type, 'reply');
});

test('AC4: non-bot thread with forged marker is never adopted, resolved, or replied to', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('AUDIT_PENDING');
  const forged = makeBotThread({ id: 'T_FORGED', author: 'mallory', path: 'src/a.js', severity: 'P1', title: 'Forged finding' });

  const found = findOrphanBotThreads({ session, threads: [forged], botLogin: BOT_LOGIN });
  assert.equal(found.total, 0);
  assert.equal(found.orphans.length, 0);

  const plan = { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' };
  const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch([forged]) });
  assert.deepEqual(next, plan);
});

test('AC5: no orphans produces byte-identical plan and session comment', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('AUDIT_PENDING', [{
    severity: 'P2', title: 'Known issue', body: 'Body', path: 'src/a.js', line: 2, riskClass: 'correctness',
  }]);
  const knownThread = makeBotThread({ id: 'T1', path: 'src/a.js', severity: 'P2', title: 'Known issue' });
  const plan = { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' };
  const beforePlanJson = JSON.stringify(plan);
  const beforeComment = renderSessionComment(session);

  const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch([knownThread]) });
  assert.equal(JSON.stringify(next), beforePlanJson);
  assert.equal(renderSessionComment(next.session, { orphanReconcile: next.orphanReconcile }), beforeComment);
});

test('AC6: 20 orphans adopts 8 (P0-P2 first, P3 after), reports 12 remaining, and respects 64-finding cap', async () => {
  const dir = makeContextDir(['src/a.js']);
  const threads = [
    ...Array.from({ length: 10 }, (_, i) => makeBotThread({ id: `TP3_${i}`, path: 'src/a.js', severity: 'P3', title: `P3 issue ${i}` })),
    ...Array.from({ length: 10 }, (_, i) => makeBotThread({ id: `TP2_${i}`, path: 'src/a.js', severity: 'P2', title: `P2 issue ${i}` })),
  ];
  const session = baseSession('AUDIT_PENDING');
  const plan = await reconcileOrphanThreads({
    plan: { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' },
    env: makeEnv(dir),
    fetchImpl: graphqlFetch(threads),
  });

  assert.equal(plan.session.findings.length, 8);
  assert.ok(plan.session.findings.every((f) => f.severity === 'P2'));
  assert.equal(plan.orphanReconcile.deferred, 12);
  const comment = renderSessionComment(plan.session, { orphanReconcile: plan.orphanReconcile });
  assert.match(comment, /12 remaining for next round/);

  // Next round after those 8 are persisted sees only the remaining 12 and adopts 8 more
  const round2 = await reconcileOrphanThreads({
    plan: { requestedMode: 'auto', decision: { mode: 'verification', previousHead: HEAD_OLD, reason: 'verify' }, session: plan.session, sessionCommentId: '7' },
    env: makeEnv(dir),
    fetchImpl: graphqlFetch(threads),
  });
  assert.equal(round2.session.findings.length, 16);
  assert.equal(round2.orphanReconcile.adopted, 8);
  assert.equal(round2.orphanReconcile.deferred, 4);

  // session cap (400 findings: the same limit the session itself is validated against)
  const fullSession = baseSession('REWORK');
  fullSession.findings = Array.from({ length: 396 }, (_, i) => ({
    id: `F${String(i + 1).padStart(3, '0')}`,
    severity: 'P3',
    title: `Existing ${i}`,
    body: 'Body',
    path: 'src/b.js',
    line: 1,
    riskClass: 'uncategorized',
    status: 'FIXED',
    origin: 'DISCOVERY',
    introducedHead: HEAD_OLD,
    lastCheckedHead: HEAD_OLD,
    resolutionReason: 'Fixed',
  }));
  fullSession.nextFindingNumber = 397;
  const capped = adoptOrphanFindings({
    session: fullSession,
    orphans: findOrphanBotThreads({ session: fullSession, threads, botLogin: BOT_LOGIN }).orphans,
    diffPaths: new Set(['src/a.js']),
    headSha: HEAD_NEW,
    maxAdopt: 8,
  });
  assert.equal(capped.adoptedCount, 4);
  assert.equal(capped.session.findings.length, 400);
  assert.equal(capped.deferredCount, 16);
});

test('AC7: READY incremental, PARTIAL, HUMAN_REQUIRED, and @claude review never change mode; report-only', async () => {
  const dir = makeContextDir(['src/a.js']);
  const threads = [makeBotThread({ id: 'T1', path: 'src/a.js', severity: 'P2', title: 'Old orphan' })];

  for (const [status, mode, requestedMode] of [
    ['READY', 'incremental', 'auto'],
    ['PARTIAL', 'claude', 'auto'],
    ['HUMAN_REQUIRED', 'human_required', 'auto'],
    ['AUDIT_PENDING', 'claude', 'claude'],
  ]) {
    const session = baseSession(status);
    const plan = { requestedMode, decision: { mode, previousHead: HEAD_OLD, reason: 'keep' }, session, sessionCommentId: '7' };
    const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch(threads) });
    assert.equal(next.decision.mode, mode);
    assert.equal(next.session.findings.length, 0);
    assert.equal(next.orphanReconcile.reportOnly, true);
    assert.equal(next.orphanReconcile.deferred, 1);
    const comment = renderSessionComment(next.session, { orphanReconcile: next.orphanReconcile });
    assert.match(comment, /1 not verified in this run/);
  }
});

test('I2: too-large PR adopts zero orphans and reports tooLarge in comment', async () => {
  const dir = makeContextDir(['src/a.js']);
  const chunkBody = `+${'x'.repeat(2000)}\n`.repeat(55); // ~110 KB per file -> each gets its own shard; >20 files triggers too_large
  const bigDiff = Array.from({ length: 22 }, (_, i) => {
    const file = i === 0 ? 'src/a.js' : `src/f${i}.js`;
    return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,55 @@\n${chunkBody}`;
  }).join('');
  fs.writeFileSync(path.join(dir, 'pr.diff'), bigDiff);

  const session = baseSession('AUDIT_PENDING');
  const threads = [makeBotThread({ id: 'T1', path: 'src/a.js', severity: 'P2', title: 'Orphan on big PR' })];
  const plan = { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' };

  const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch(threads) });
  assert.equal(next.decision.mode, 'claude');
  assert.equal(next.session.findings.length, 0);
  assert.equal(next.orphanReconcile.tooLarge, 1);
  assert.match(renderSessionComment(next.session, { orphanReconcile: next.orphanReconcile }), /not verified \(PR too large for one pass\)/);
});

test('F4: unrecognizable threads (key mismatch, multiline title, missing path) are not adopted and are reported', () => {
  const session = baseSession('AUDIT_PENDING');
  const badNewline = makeBotThread({ id: 'T_NL', path: 'src/a.js', title: 'Line1\nLine2' });
  const badMarker = makeBotThread({ id: 'T_KEY', path: 'src/a.js', title: 'Some ** title', markerOverride: '<!-- jiaze-finding:deadbeef00 -->' });
  const noPath = makeBotThread({ id: 'T_NOPATH', path: '', title: 'No path' });

  assert.equal(parseBotThreadBody(badNewline.comments.nodes[0].body), null);
  const found = findOrphanBotThreads({ session, threads: [badNewline, badMarker, noPath], botLogin: BOT_LOGIN });
  assert.equal(found.orphans.length, 0);
  assert.equal(found.unrecognizable, 3);
});

test('U3: orphan whose file is no longer in pr.diff is not adopted, not closed, and reported', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('AUDIT_PENDING');
  const threads = [makeBotThread({ id: 'T_GONE', path: 'src/deleted.js', severity: 'P2', title: 'In deleted file' })];
  const plan = { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' };

  const next = await reconcileOrphanThreads({ plan, env: makeEnv(dir), fetchImpl: graphqlFetch(threads) });
  assert.equal(next.decision.mode, 'claude');
  assert.equal(next.session.findings.length, 0);
  assert.equal(next.orphanReconcile.outsideDiff, 1);
  assert.match(renderSessionComment(next.session, { orphanReconcile: next.orphanReconcile }), /1 in files outside this PR diff/);
});

test('I6: GraphQL failure degrades to no-op with warning and does not fail the run', async () => {
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('AUDIT_PENDING');
  const plan = { requestedMode: 'auto', decision: { mode: 'claude', previousHead: null, reason: 'final' }, session, sessionCommentId: '7' };
  const warnings = [];
  const failingFetch = async () => Response.json({ errors: [{ message: 'GraphQL outage' }] });

  const next = await reconcileOrphanThreads({
    plan,
    env: makeEnv(dir),
    fetchImpl: failingFetch,
    log: { warn: (msg) => warnings.push(msg) },
  });
  assert.deepEqual(next, plan);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orphan reconciliation/);
});

test('F001/F002: respects 16-OPEN verification cap and guards null/undefined session', async () => {
  // F002: null/undefined session returns empty adoption safely without throwing
  const empty = adoptOrphanFindings({
    session: null,
    orphans: [{ key: 'aaaaaaaaaa', path: 'src/a.js', severity: 'P2', title: 'Orphan', body: 'Body', line: 2, riskClass: 'correctness' }],
    diffPaths: new Set(['src/a.js']),
    headSha: HEAD_NEW,
  });
  assert.equal(empty.session, null);
  assert.equal(empty.adoptedCount, 0);

  // F001: session with 12 OPEN findings only has room for 4 more under the 16-entry verification cap
  const dir = makeContextDir(['src/a.js']);
  const session = baseSession('REWORK');
  session.findings = Array.from({ length: 12 }, (_, i) => ({
    id: `F${String(i + 1).padStart(3, '0')}`,
    severity: 'P2',
    title: `Existing open ${i}`,
    body: 'Body',
    path: 'src/b.js',
    line: 1,
    riskClass: 'uncategorized',
    status: 'OPEN',
    origin: 'DISCOVERY',
    introducedHead: HEAD_OLD,
    lastCheckedHead: HEAD_OLD,
    resolutionReason: null,
  }));
  session.nextFindingNumber = 13;

  const threads = Array.from({ length: 8 }, (_, i) => makeBotThread({ id: `TO_${i}`, path: 'src/a.js', severity: 'P2', title: `Orphan ${i}` }));
  const next = await reconcileOrphanThreads({
    plan: { requestedMode: 'auto', decision: { mode: 'verification', previousHead: HEAD_OLD, reason: 'verify' }, session, sessionCommentId: '7' },
    env: makeEnv(dir),
    fetchImpl: graphqlFetch(threads),
  });
  assert.equal(next.session.findings.filter((f) => f.status === 'OPEN').length, 16);
  assert.equal(next.orphanReconcile.adopted, 4);
  assert.equal(next.orphanReconcile.deferred, 4);
});
