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

test('concurrent markers: maintains up to 8 recent markers without corrupting session state', async () => {
  const initialSession = createMockSession({ status: 'READY' });
  let currentCommentBody = renderSessionComment(initialSession, {
    sourceCommentIds: ['1', '2', '3', '4', '5', '6', '7'],
  });

  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return Response.json({ id: 999, body: currentCommentBody });
    }
    if (method === 'PATCH') {
      const parsed = JSON.parse(options.body);
      currentCommentBody = parsed.body;
      return Response.json({ id: 999 });
    }
    throw new Error(`Unexpected call`);
  };

  // Adding marker 8
  await recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '8',
    fetchImpl,
  });

  let markers = extractSourceCommentMarkers(currentCommentBody);
  assert.equal(markers.length, 8);
  assert.deepEqual(markers, ['1', '2', '3', '4', '5', '6', '7', '8']);

  // Adding marker 9: slices the last 8
  await recordSessionMarker({
    targetRepo: 'target/repo',
    prNumber: '42',
    token: 'token',
    sessionCommentId: '999',
    session: initialSession,
    sourceCommentId: '9',
    fetchImpl,
  });

  markers = extractSourceCommentMarkers(currentCommentBody);
  assert.equal(markers.length, 8);
  assert.deepEqual(markers, ['2', '3', '4', '5', '6', '7', '8', '9']);

  // Session state is preserved and intact
  const parsed = parseSessionComment(currentCommentBody);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.lastReviewedHead, HEAD);
});

test('session recovery mode: recover is silent in conversation while preserving session', () => {
  const decision = decideNotificationAction({
    stage: 'finished',
    mode: 'recover',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: '601',
    outcomes: { geminiPublish: 'success' },
  });
  // recover mode does not post duplicate conversation noise
  assert.equal(decision.action, NOTIFICATION_ACTIONS.SILENT);
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
