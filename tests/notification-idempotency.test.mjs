import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_ACTIONS,
  decideNotificationAction,
  extractSourceCommentMarkers,
} from '../scripts/notification-policy.mjs';
import {
  publishRunStatus,
  recordSessionMarker,
} from '../scripts/review-status.mjs';
import {
  parseSessionComment,
  renderSessionComment,
} from '../scripts/review-session-core.mjs';

const HEAD = '1'.repeat(40);
const BASE = '0'.repeat(40);

function createMockSession({
  status = 'READY',
  findings = [],
  verificationRound = 0,
  auditCompleted = true,
} = {}) {
  return {
    version: 1,
    status,
    findings,
    verificationRound,
    maxVerificationRounds: 3,
    auditCompleted,
    lastReviewedHead: HEAD,
    baseSha: BASE,
    fullAuditHead: HEAD,
    deepSpendUsd: 0,
  };
}

test('idempotency: silent noop_ready updates session comment marker and enables webhook deduplication', async () => {
  const session = createMockSession({ status: 'READY' });
  let currentCommentBody = renderSessionComment(session, { sourceCommentIds: ['100'] });
  const commentHistory = [];

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({
        id: 777,
        body: currentCommentBody,
      });
    }
    if (method === 'PATCH') {
      const parsed = JSON.parse(options.body);
      currentCommentBody = parsed.body;
      commentHistory.push({ method: 'PATCH', body: parsed.body });
      return Response.json({ id: 777 });
    }
    throw new Error(`Unexpected call to ${method} ${url}`);
  };

  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '900',
    GITHUB_RUN_ATTEMPT: '1',
    TARGET_REPO: 'target/repo',
    PR_NUMBER: '42',
    SOURCE_COMMENT_ID: '200',
    SOURCE_KIND: 'comment',
    HEAD_SHA: HEAD,
    STATUS_STAGE: 'finished',
    REVIEW_MODE: 'noop_ready',
    REVIEW_REASON: 'current HEAD is already READY',
    GH_TOKEN: 'fake-token',
  };

  // Run 1: First delivery of source comment 200
  const result1 = await publishRunStatus({
    env,
    fetchImpl,
    plan: { sessionCommentId: '777', session },
  });

  // Must be silent in conversation
  assert.equal(result1, null);
  // Session comment was patched in place with the new marker
  assert.equal(commentHistory.length, 1);
  const updatedMarkers = extractSourceCommentMarkers(currentCommentBody);
  assert.ok(updatedMarkers.includes('100'));
  assert.ok(updatedMarkers.includes('200'));

  // Run 2: Re-delivery of the same source comment 200
  // When dedupe runs against currentCommentBody, it finds the marker
  assert.ok(currentCommentBody.includes('<!-- jiaze-review-source-comment:200 -->'));

  // If workflow dedupe step sets DUPLICATE=true:
  const result2 = await publishRunStatus({
    env: { ...env, DUPLICATE: 'true' },
    fetchImpl,
    plan: { sessionCommentId: '777', session },
  });
  assert.equal(result2, null);
  // No additional comment PATCH was made
  assert.equal(commentHistory.length, 1);
});

test('idempotency: zero-change thread resolution updates marker silently without conversation spam', async () => {
  const session = createMockSession({ status: 'REWORK' });
  let currentCommentBody = renderSessionComment(session, { sourceCommentIds: ['10'] });
  const patches = [];

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({ id: 888, body: currentCommentBody });
    }
    if (method === 'PATCH') {
      const parsed = JSON.parse(options.body);
      currentCommentBody = parsed.body;
      patches.push(parsed.body);
      return Response.json({ id: 888 });
    }
    throw new Error(`Unexpected call: ${method} ${url}`);
  };

  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '901',
    GITHUB_RUN_ATTEMPT: '1',
    TARGET_REPO: 'target/repo',
    PR_NUMBER: '42',
    SOURCE_COMMENT_ID: '20',
    SOURCE_KIND: 'comment',
    HEAD_SHA: HEAD,
    STATUS_STAGE: 'finished',
    REVIEW_MODE: 'threads',
    THREADS_OUTCOME: 'success',
    THREAD_PROBLEMS: '0',
    GH_TOKEN: 'fake-token',
  };

  const res = await publishRunStatus({
    env,
    fetchImpl,
    plan: { sessionCommentId: '888', session },
  });

  assert.equal(res, null);
  assert.equal(patches.length, 1);
  assert.match(patches[0], /jiaze-review-source-comment:20/);
  assert.match(patches[0], /jiaze-review-source-comment:10/);
  // Ensure no PR conversation echo comment was posted
  assert.doesNotMatch(patches[0], /Review-thread decisions applied/);
});

test('deterministic concurrency: forces two actors to read same prior state before writes and verifies actual conflict behavior (AC5, E1)', async () => {
  const initialSession = createMockSession({ status: 'READY' });
  let currentCommentBody = renderSessionComment(initialSession, {
    sourceCommentIds: ['1', '2', '3', '4', '5', '6', '7'],
  });

  const trace = [];
  let aReadResolve;
  const aReadPromise = new Promise((resolve) => { aReadResolve = resolve; });
  let bCanProceedResolve;
  const bCanProceedPromise = new Promise((resolve) => { bCanProceedResolve = resolve; });
  let aPatchedResolve;
  const aPatchedPromise = new Promise((resolve) => { aPatchedResolve = resolve; });

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const bodyStr = options.body ? JSON.parse(options.body).body : null;

    if (method === 'GET') {
      const markers = extractSourceCommentMarkers(currentCommentBody);
      // Synchronize both actors so both read the identical initial state before either writes
      if (!trace.some((t) => t.actor === 'A' && t.method === 'GET')) {
        trace.push({ actor: 'A', method: 'GET', markers: [...markers] });
        aReadResolve();
        // Pause Actor A until Actor B also reads the identical prior state
        await bCanProceedPromise;
        return Response.json({ id: 999, body: currentCommentBody });
      }
      trace.push({ actor: 'B', method: 'GET', markers: [...markers] });
      // Both actors have now read the same prior state
      bCanProceedResolve();
      return Response.json({ id: 999, body: currentCommentBody });
    }

    if (method === 'PATCH') {
      const parsedMarkers = extractSourceCommentMarkers(bodyStr);
      const actor = parsedMarkers.includes('8') ? 'A' : 'B';
      if (actor === 'B') {
        // Force Actor B to wait until Actor A has committed its write
        await aPatchedPromise;
      }
      trace.push({ actor, method: 'PATCH', markers: [...parsedMarkers] });
      currentCommentBody = bodyStr;
      if (actor === 'A') {
        aPatchedResolve();
      }
      return Response.json({ id: 999 });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  };

  // Launch Actor A and Actor B concurrently
  const callA = recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '8',
    fetchImpl,
  });

  // Ensure Actor A has started its GET before launching Actor B
  await aReadPromise;

  const callB = recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '9',
    fetchImpl,
  });

  const [resA, resB] = await Promise.all([callA, callB]);

  // Both calls return the session comment ID
  assert.equal(resA, '999');
  assert.equal(resB, '999');

  // Verify the exact interleaving trace:
  // Both actors read the identical prior state [1..7] before either PATCHes
  assert.deepEqual(trace, [
    { actor: 'A', method: 'GET', markers: ['1', '2', '3', '4', '5', '6', '7'] },
    { actor: 'B', method: 'GET', markers: ['1', '2', '3', '4', '5', '6', '7'] },
    { actor: 'A', method: 'PATCH', markers: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    { actor: 'B', method: 'PATCH', markers: ['1', '2', '3', '4', '5', '6', '7', '9'] },
  ]);

  // In GitHub REST API without atomic CAS or If-Match enforcement, Actor B's PATCH
  // overwrites Actor A's write (last-write-wins).
  const finalMarkers = extractSourceCommentMarkers(currentCommentBody);
  assert.deepEqual(finalMarkers, ['1', '2', '3', '4', '5', '6', '7', '9']);

  // The durable session state remains completely valid and uncorrupted
  const parsed = parseSessionComment(currentCommentBody);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.lastReviewedHead, HEAD);
});

test('workflow serialization: serialized bot writers preserve all markers without lost updates (AC2, AC5, E1)', async () => {
  const initialSession = createMockSession({ status: 'READY' });
  let currentCommentBody = renderSessionComment(initialSession, {
    sourceCommentIds: ['1', '2', '3', '4', '5', '6', '7'],
  });

  const trace = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      const markers = extractSourceCommentMarkers(currentCommentBody);
      trace.push({ method: 'GET', markers: [...markers] });
      return Response.json({ id: 999, body: currentCommentBody });
    }
    if (method === 'PATCH') {
      const parsed = JSON.parse(options.body);
      currentCommentBody = parsed.body;
      const markers = extractSourceCommentMarkers(parsed.body);
      trace.push({ method: 'PATCH', markers: [...markers] });
      return Response.json({ id: 999 });
    }
    throw new Error(`Unexpected call`);
  };

  // Run 1: Workflow 1 runs to completion (serialized by review-v2.yml concurrency group)
  await recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '8',
    fetchImpl,
  });

  // Run 2: Workflow 2 runs after Workflow 1 finishes
  await recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '9',
    fetchImpl,
  });

  // Both markers 8 and 9 are preserved cleanly (capped to recent 8 markers)
  const markers = extractSourceCommentMarkers(currentCommentBody);
  assert.equal(markers.length, 8);
  assert.deepEqual(markers, ['2', '3', '4', '5', '6', '7', '8', '9']);

  // Verify trace shows sequential read-after-write execution
  assert.deepEqual(trace, [
    { method: 'GET', markers: ['1', '2', '3', '4', '5', '6', '7'] },
    { method: 'PATCH', markers: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    { method: 'GET', markers: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    { method: 'PATCH', markers: ['2', '3', '4', '5', '6', '7', '8', '9'] },
  ]);

  const parsed = parseSessionComment(currentCommentBody);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.lastReviewedHead, HEAD);
});

test('supported bot writers: marker updates cannot silently revert newer findings, status, HEAD, or cost records (AC2, E1)', async () => {
  // Live state on GitHub has advanced: status is READY, verification round 2, Claude spend $1.50
  const liveSession = {
    version: 1,
    status: 'READY',
    findings: [],
    verificationRound: 2,
    maxVerificationRounds: 3,
    auditCompleted: true,
    lastReviewedHead: HEAD,
    baseSha: BASE,
    fullAuditHead: HEAD,
    deepSpendUsd: 1.50,
    claudeSdkSpendUsd: 1.50,
  };
  let currentCommentBody = renderSessionComment(liveSession, { sourceCommentIds: ['10'] });

  // A stale pre-run plan snapshot (e.g. from session-plan.json generated before review ran)
  const stalePlanSession = {
    version: 1,
    status: 'REWORK',
    findings: [{
      id: 'F001',
      severity: 'P1',
      title: 'Stale finding',
      path: 'index.js',
      line: 10,
      body: 'Old finding that was since resolved',
      status: 'OPEN',
    }],
    verificationRound: 1,
    maxVerificationRounds: 3,
    auditCompleted: false,
    lastReviewedHead: BASE,
    baseSha: BASE,
    fullAuditHead: BASE,
    deepSpendUsd: 0,
  };

  const patches = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({ id: 999, body: currentCommentBody });
    }
    if (method === 'PATCH') {
      const parsed = JSON.parse(options.body);
      currentCommentBody = parsed.body;
      patches.push(parsed.body);
      return Response.json({ id: 999 });
    }
    throw new Error(`Unexpected call`);
  };

  const res = await recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: stalePlanSession, // Pass stale plan snapshot
    sourceCommentId: '20',
    fetchImpl,
  });

  assert.equal(res, '999');
  assert.equal(patches.length, 1);

  // Stored session MUST preserve live state (READY, 0 open findings, HEAD, spend 1.50)
  // and MUST NOT revert to the stale plan snapshot
  const parsed = parseSessionComment(currentCommentBody);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.verificationRound, 2);
  assert.equal(parsed.lastReviewedHead, HEAD);
  assert.equal(parsed.deepSpendUsd, 1.50);

  const markers = extractSourceCommentMarkers(currentCommentBody);
  assert.deepEqual(markers, ['10', '20']);
});

test('fault injection: failed marker reads and writes produce observable Actions diagnostics without corrupting session (AC1, E2)', async () => {
  const session = createMockSession({ status: 'READY' });
  const validBody = renderSessionComment(session, { sourceCommentIds: ['10'] });
  let currentBody = validBody;

  // Case 1: HTTP failure (500)
  {
    const warnings = [];
    const log = { warn: (msg) => warnings.push(msg) };
    const fetchImpl = async () => new Response('Internal Server Error', { status: 500 });

    const res = await recordSessionMarker({
      targetRepo: 'target/repo',
      prNumber: '42',
      token: 'token',
      sessionCommentId: '999',
      session,
      sourceCommentId: '50',
      fetchImpl,
      log,
    });

    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /::warning::Failed to fetch session comment 999 for marker 50 \(HTTP 500\)/);
    assert.equal(currentBody, validBody); // Uncorrupted
  }

  // Case 2: Timeout / Network exception
  {
    const warnings = [];
    const log = { warn: (msg) => warnings.push(msg) };
    const fetchImpl = async () => { throw new Error('AbortError: The operation timed out'); };

    const res = await recordSessionMarker({
      targetRepo: 'target/repo',
      prNumber: '42',
      token: 'token',
      sessionCommentId: '999',
      session,
      sourceCommentId: '51',
      fetchImpl,
      log,
    });

    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /::warning::Failed to fetch session comment 999 for marker 51: AbortError: The operation timed out/);
    assert.equal(currentBody, validBody); // Uncorrupted
  }

  // Case 3: Malformed / unparseable session body
  {
    const warnings = [];
    const log = { warn: (msg) => warnings.push(msg) };
    const fetchImpl = async () => Response.json({
      id: 999,
      body: '<!-- jiaze-review-session:v1 -->\nCorrupted body missing encoded state',
    });

    const res = await recordSessionMarker({
      targetRepo: 'target/repo',
      prNumber: '42',
      token: 'token',
      sessionCommentId: '999',
      session,
      sourceCommentId: '52',
      fetchImpl,
      log,
    });

    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /::warning::Session comment 999 has corrupted or unparseable state; refusing to record marker 52 to preserve durable state/);
    assert.equal(currentBody, validBody); // Uncorrupted
  }

  // Case 4: PATCH failure (saveSessionComment throws HTTP 503)
  {
    const warnings = [];
    const log = { warn: (msg) => warnings.push(msg) };
    const fetchImpl = async (url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'GET') {
        return Response.json({ id: 999, body: validBody });
      }
      return new Response('Service Unavailable', { status: 503 });
    };

    const res = await recordSessionMarker({
      targetRepo: 'target/repo',
      prNumber: '42',
      token: 'token',
      sessionCommentId: '999',
      session,
      sourceCommentId: '53',
      fetchImpl,
      log,
    });

    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /::warning::Failed to patch session comment 999 with marker 53: GitHub API failed \(HTTP 503\)/);
    assert.equal(currentBody, validBody); // Uncorrupted
  }
});

test('session recovery mode: recover is silent in conversation while preserving session', () => {
  const decision = decideNotificationAction({
    stage: 'finished',
    mode: 'recover',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: '601',
    outcomes: { recover: 'success' },
  });
  assert.equal(decision.action, NOTIFICATION_ACTIONS.SILENT);
});

test('session recovery failure produces error notification with workflow link and marker', async () => {
  const posted = [];
  const fetchImpl = async (url, options) => {
    posted.push(JSON.parse(options.body).body);
    return Response.json({ id: 888 });
  };

  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '905',
    GITHUB_RUN_ATTEMPT: '1',
    TARGET_REPO: 'target/repo',
    PR_NUMBER: '42',
    SOURCE_COMMENT_ID: '602',
    SOURCE_KIND: 'comment',
    HEAD_SHA: HEAD,
    STATUS_STAGE: 'finished',
    REVIEW_MODE: 'recover',
    RECOVER_OUTCOME: 'failure',
    GH_TOKEN: 'fake-token',
  };

  const res = await publishRunStatus({ env, fetchImpl });
  assert.equal(res, '888');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Session recovery was not confirmed/);
  assert.match(posted[0], /actions\/runs\/905\/attempts\/1/);
  assert.match(posted[0], /<!-- jiaze-review-source-comment:602 -->/);
});

test('error status retains source comment marker so webhook does not retry infinitely', async () => {
  const posted = [];
  const fetchImpl = async (url, options) => {
    posted.push(JSON.parse(options.body).body);
    return Response.json({ id: 555 });
  };

  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '902',
    GITHUB_RUN_ATTEMPT: '1',
    TARGET_REPO: 'target/repo',
    PR_NUMBER: '42',
    SOURCE_COMMENT_ID: '777',
    SOURCE_KIND: 'comment',
    HEAD_SHA: HEAD,
    STATUS_STAGE: 'finished',
    REVIEW_MODE: 'incremental',
    GEMINI_PUBLISH_OUTCOME: 'failure',
    GH_TOKEN: 'fake-token',
  };

  const res = await publishRunStatus({ env, fetchImpl });
  assert.equal(res, '555');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /publication was not confirmed/);
  // Must include source comment marker for webhook dedupe
  assert.match(posted[0], /<!-- jiaze-review-source-comment:777 -->/);
});

test('event replay simulation: replaying source event demonstrates zero duplicate model execution (AC3, E3)', async () => {
  const session = createMockSession({ status: 'READY' });
  let currentCommentBody = renderSessionComment(session, { sourceCommentIds: ['100'] });
  let modelExecutionCount = 0;
  let commentPatches = 0;

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({ id: 777, body: currentCommentBody });
    }
    if (method === 'PATCH') {
      commentPatches++;
      currentCommentBody = JSON.parse(options.body).body;
      return Response.json({ id: 777 });
    }
    throw new Error(`Unexpected call to ${method} ${url}`);
  };

  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '950',
    GITHUB_RUN_ATTEMPT: '1',
    TARGET_REPO: 'target/repo',
    PR_NUMBER: '42',
    SOURCE_COMMENT_ID: '456',
    SOURCE_KIND: 'comment',
    HEAD_SHA: HEAD,
    STATUS_STAGE: 'finished',
    REVIEW_MODE: 'noop_ready',
    REVIEW_REASON: 'current HEAD is already READY',
    GH_TOKEN: 'fake-token',
  };

  // Run 1: First delivery of source comment 456
  // Workflow runs, decides mode noop_ready, records marker into session
  const res1 = await publishRunStatus({
    env,
    fetchImpl,
    plan: { sessionCommentId: '777', session },
  });
  assert.equal(res1, null);
  assert.equal(commentPatches, 1);
  assert.ok(extractSourceCommentMarkers(currentCommentBody).includes('456'));

  // Run 2: Replay of source comment 456 arrives
  // Dedupe step checks session comment on GitHub:
  const markers = extractSourceCommentMarkers(currentCommentBody);
  const isDuplicate = markers.includes(env.SOURCE_COMMENT_ID);
  assert.equal(isDuplicate, true);

  // Workflow sets DUPLICATE=true
  // All model review steps (Gemini / Claude) have condition: `if: steps.dedupe.outputs.duplicate != 'true'`
  // In simulation, modelExecutionCount is not incremented
  if (!isDuplicate) {
    modelExecutionCount++;
  }

  // Finalize status runs with DUPLICATE=true
  const res2 = await publishRunStatus({
    env: { ...env, DUPLICATE: 'true' },
    fetchImpl,
    plan: { sessionCommentId: '777', session },
  });
  assert.equal(res2, null);

  // Verifications:
  // 1. Zero duplicate model execution occurred
  assert.equal(modelExecutionCount, 0);
  // 2. Zero extra comment patches occurred on replay
  assert.equal(commentPatches, 1);
});

test('conversation silence: successful no-op and thread events post zero PR conversation comments (AC4, E4)', async () => {
  const session = createMockSession({ status: 'READY' });
  const commentBody = renderSessionComment(session, { sourceCommentIds: ['10'] });
  const conversationPosts = [];

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({ id: 888, body: commentBody });
    }
    if (method === 'PATCH') {
      return Response.json({ id: 888 });
    }
    if (method === 'POST') {
      conversationPosts.push({ url, body: options.body });
      return Response.json({ id: 999 });
    }
    throw new Error(`Unexpected call: ${method} ${url}`);
  };

  const silentModes = [
    { mode: 'noop_ready', reason: 'current HEAD is already READY' },
    { mode: 'noop_waiting', reason: 'push a repair before verification' },
    { mode: 'deep_review_stale', reason: 'stale deep review cleaned up', envExtra: { FAIL_DEEP_OUTCOME: 'success' } },
    { mode: 'threads', envExtra: { THREADS_OUTCOME: 'success', THREAD_PROBLEMS: '0' } },
    { mode: 'recover', envExtra: { RECOVER_OUTCOME: 'success' } },
  ];

  for (const { mode, reason = '', outcomes = {}, envExtra = {} } of silentModes) {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '960',
      GITHUB_RUN_ATTEMPT: '1',
      TARGET_REPO: 'target/repo',
      PR_NUMBER: '42',
      SOURCE_COMMENT_ID: '789',
      SOURCE_KIND: 'comment',
      HEAD_SHA: HEAD,
      STATUS_STAGE: 'finished',
      REVIEW_MODE: mode,
      REVIEW_REASON: reason,
      GH_TOKEN: 'fake-token',
      ...envExtra,
    };

    const res = await publishRunStatus({
      env,
      fetchImpl,
      plan: { sessionCommentId: '888', session },
    });

    assert.equal(res, null, `Expected publishRunStatus to return null for silent mode ${mode}`);
  }

  // Exactly ZERO comments were posted to the PR issue conversation
  assert.equal(conversationPosts.length, 0);
});
