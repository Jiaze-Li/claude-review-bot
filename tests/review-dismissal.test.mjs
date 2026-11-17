import { applyFullReview } from './helpers/full-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDiscoveryResult, applyFindingDismissal,
  checkDismissEligibility, encodeSessionState,
  matchesKnownDismissal, openMaterialFindings, parseSessionComment,
  planReviewSession, recordDismissAttempt, renderSessionComment,
} from '../scripts/review-session-core.mjs';
import { parseDismissalRequest, parseReviewTrigger } from '../worker/src/review-trigger.js';
import { planSession } from '../scripts/plan-review-session.mjs';
import { applyManualDismissal } from '../scripts/apply-dismissal.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), B = 'c'.repeat(40);
const AUTHOR = 'jiaze-claude-review-bot[bot]';
const EVIDENCE_URL = 'https://docs.github.com/en/rest/git/refs';
const reason = 'The exact git/ref endpoint does not return matching-refs arrays.';
const command = '@gemini dismiss F001\nReason: ' + reason + '\nEvidence: ' + EVIDENCE_URL;
const issue = (title = 'Ref endpoint array') => ({
  severity: 'P2', title, body: 'The claimed endpoint can yield an array.',
  path: 'scripts/ref.mjs', line: 77, riskClass: 'API',
  failurePath: 'An exact-reference request returns array and falsely blocks HEAD.',
});
const initial = (n = 1) => applyDiscoveryResult({
  result: { summary: 'candidate', findings: Array.from({ length: n }, (_, i) => issue(i ? 'Unrelated bug' : undefined)) },
  baseSha: BASE, headSha: A, sourceCommentId: '9',
});
const dismiss = (session, extras = {}) => applyFindingDismissal({
  session, findingId: 'F001', headSha: A, by: 'maintainer',
  sourceCommentId: '99', reason, evidence: [EVIDENCE_URL],
  now: '2026-10-15T00:00:00Z', ...extras,
});

test('parse only the first-line command and require explicit HTTPS evidence', () => {
  assert.deepEqual(parseReviewTrigger(command), { requestedMode: 'dismiss' });
  assert.deepEqual(parseDismissalRequest(command), { findingId: 'F001', reason, evidence: [EVIDENCE_URL] });
  assert.deepEqual(parseDismissalRequest(command.replace('@gemini', '@jiaze-claude-review-bot')), {
    findingId: 'F001', reason, evidence: [EVIDENCE_URL],
  });
  assert.equal(parseReviewTrigger('> @gemini dismiss F001\nReason: ' + reason), null);
  assert.equal(parseReviewTrigger('@gemini dismiss F001 please'), null);
  assert.equal(parseReviewTrigger('Explanation\n@gemini dismiss F001'), null);
  assert.throws(() => parseDismissalRequest('@gemini dismiss F001\nReason: ' + reason), /Evidence/);
  assert.throws(() => parseDismissalRequest(command.replace('https:', 'http:')), /HTTPS/);
  assert.throws(() => parseDismissalRequest(command + '\nEvidence: ' + EVIDENCE_URL), /Duplicate/);
  assert.throws(() => parseDismissalRequest(command.replace('Reason: ' + reason, 'Reason: trivial')), /30-400/);
  assert.throws(() => parseDismissalRequest(command + '\nArbitrary extra input'), /exactly one/);
});

test('dismiss one finding, preserve other blockers, original state and verification budget', () => {
  const session = initial(2);
  const out = dismiss(session);
  assert.equal(out.status, 'REWORK');
  assert.equal(out.verificationRound, 0);
  assert.equal(out.auditCompleted, false);
  assert.deepEqual(out.findings.map(f => f.status), ['DISMISSED', 'OPEN']);
  assert.equal(out.findings[0].dismissal.by, 'maintainer');
  assert.equal(out.findings[0].dismissal.head, A);
  assert.equal(out.findings[0].dismissal.sourceCommentId, '99');
  assert.deepEqual(out.findings[0].dismissal.evidence, [EVIDENCE_URL]);
  assert.equal(session.findings[0].status, 'OPEN');
  assert.deepEqual(parseSessionComment(renderSessionComment(out)), out);
  assert.match(renderSessionComment(out), /Human-dismissed findings/);
  assert.equal(openMaterialFindings(out).length, 1);
});

test('last dismissed blocker enters AUDIT_PENDING rather than skipping Final Audit', () => {
  const out = dismiss(initial());
  assert.equal(out.status, 'AUDIT_PENDING');
  assert.equal(out.auditCompleted, false);
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: A }).mode, 'full_review');
  const ready = applyFullReview({ session: out, result: { summary: 'clean audit', findings: [] }, headSha: A });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.auditCompleted, true);
  assert.equal(planReviewSession({ session: ready, baseSha: BASE, headSha: A }).mode, 'noop_ready');
});

test('after the one final full review has run, no second full review is owed', () => {
  const waiting = dismiss(initial()); // every finding settled, the final full review is next
  assert.equal(waiting.status, 'AUDIT_PENDING');
  const audited = applyFullReview({
    session: waiting, result: { summary: 'late bug', findings: [issue('A late bug the earlier reviews missed')] }, headSha: A,
  });
  assert.equal(audited.status, 'REWORK');
  assert.equal(audited.auditCompleted, true);
  const out = dismiss(audited, { findingId: 'F002' });
  assert.equal(out.status, 'READY');
  assert.equal(out.auditCompleted, true);
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: A }).mode, 'noop_ready');
});

test('dismissal refuses stale, duplicate, unknown and non-blocking findings', () => {
  const session = initial();
  assert.throws(() => dismiss(session, { headSha: B }), /exact last-reviewed HEAD/);
  assert.throws(() => dismiss(session, { findingId: 'F999' }), /must be an OPEN or UNCERTAIN/);
  assert.throws(() => dismiss(dismiss(session)), /REWORK or HUMAN_REQUIRED/);
  assert.throws(() => dismiss(session, { reason: 'short' }), /at least 30/);
  assert.throws(() => dismiss(session, { evidence: ['http://invalid.test/'] }), /invalid dismissal evidence/);
  assert.throws(() => dismiss({ ...session, status: 'READY' }), /REWORK or HUMAN_REQUIRED/);
});

test('after verification budget exhaustion, a valid dismissal can still resume audit', () => {
  const s = { ...initial(), status: 'HUMAN_REQUIRED', verificationRound: 2 };
  const out = dismiss(s);
  assert.equal(out.status, 'AUDIT_PENDING');
  assert.equal(out.verificationRound, 2);
  assert.equal(out.auditCompleted, false);
});

test('known-issue guard rejects exact dismissed premise, not a distinct real bug', () => {
  const s = dismiss(initial());
  assert.equal(matchesKnownDismissal(issue(), s), true);
  assert.equal(matchesKnownDismissal(issue('Different premise on same endpoint'), s), false);
  assert.equal(matchesKnownDismissal({
    ...issue(), failurePath: 'A DIFFERENT REACHABLE PATH triggers the wrong response.',
  }, s), false);
});

const SAMPLE_CODE = [
  'export async function getExactRef(target, ref) {',
  '  // Exact git/ref lookup returns a single object, never an array.',
  '  return fetchJson(`/repos/${target}/git/ref/${ref}`);',
  '}',
].join('\n');

function setupSafeRepo(root) {
  const safeDir = path.join(root, 'safe-target');
  fs.mkdirSync(path.join(safeDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(safeDir, 'scripts/ref.mjs'), SAMPLE_CODE + '\n');
  return safeDir;
}

const env = (root, extras = {}) => ({
  GH_TOKEN: 'synthetic-token', THREAD_TOKEN: 'synthetic-thread-token',
  GEMINI_API_KEY: 'synthetic-gemini-key', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-claude-token',
  TARGET_REPO: 'acme/project', PR_NUMBER: '7',
  BASE_SHA: BASE, HEAD_SHA: A, SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '99',
  TRIGGER_USER: 'maintainer', EXPECTED_REVIEW_AUTHOR: AUTHOR,
  REVIEW_CONTEXT_DIR: root, SAFE_REPO_DIR: path.join(root, 'safe-target'),
  ...extras,
});
const writePlan = (root, session = initial()) => {
  setupSafeRepo(root);
  fs.writeFileSync(path.join(root, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'dismiss' }, session, sessionCommentId: '5',
  }));
};

function geminiJsonResponse(payload) {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
  });
}

function mockGitHub(session, { actor = 'maintainer', permission = 'write', head = A,
  sourceBody = command, commentBody = renderSessionComment(session),
  threads = [], mutateOnSessionRead = null, mutateHeadAfterReads = null } = {}) {
  const calls = [];
  let sessionReads = 0;
  let prReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const method = init.method || 'GET';
    calls.push({ pathname, method, body: init.body });
    if (pathname === '/repos/acme/project/pulls/7') {
      prReads += 1;
      const effectiveHead = mutateHeadAfterReads && prReads >= mutateHeadAfterReads ? B : head;
      return Response.json({ state: 'open', base: { sha: BASE }, head: { sha: effectiveHead } });
    }
    if (pathname === '/repos/acme/project/issues/comments/99') {
      return Response.json({
        id: 99, user: { login: actor },
        issue_url: 'https://api.github.com/repos/acme/project/issues/7',
        body: sourceBody,
      });
    }
    if (pathname === '/repos/acme/project/collaborators/maintainer/permission') return Response.json({ permission });
    if (pathname === '/repos/acme/project/issues/7/comments' && method === 'POST') return Response.json({ id: 6 });
    if (pathname === '/repos/acme/project/pulls/7/comments/101/replies' && method === 'POST') {
      return Response.json({ id: 202 });
    }
    if (pathname === '/graphql' && method === 'POST') {
      return Response.json({
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } },
      });
    }
    if (pathname === '/repos/acme/project/issues/comments/5') {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (method === 'PATCH') return Response.json({ id: 5 });
      sessionReads += 1;
      const effectiveBody = mutateOnSessionRead && sessionReads >= 2 ? mutateOnSessionRead : commentBody;
      return Response.json({ user: { login: AUTHOR }, body: effectiveBody });
    }
    assert.fail('Unexpected API call: ' + pathname);
  };
  return { calls, fetchImpl };
}

test('workflow verifies rebuttal with model, writes evidence and produces final-audit handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session);
  let modelCalls = 0;
  const modelFetchImpl = async () => {
    modelCalls += 1;
    return geminiJsonResponse({
      verdict: 'DISMISSED',
      reason: 'Line 3 calls /git/ref/ for an exact ref, which returns a single object rather than an array.',
      nextStep: '',
      sourceAnchors: [{ path: 'scripts/ref.mjs', line: 3, quote: 'return fetchJson(`/repos/${target}/git/ref/${ref}`);' }],
    });
  };
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl });
  assert.equal(modelCalls, 1);
  assert.equal(out.status, 'AUDIT_PENDING');
  assert.equal(out.findings[0].dismissal.verifiedBy, 'gemini');
  const posted = mock.calls.find(c => c.method === 'POST' && c.pathname === '/repos/acme/project/issues/7/comments');
  assert.ok(posted);
  assert.equal(mock.calls.find(c => c.method === 'DELETE').pathname, '/repos/acme/project/issues/comments/5');
  const written = JSON.parse(posted.body).body;
  assert.match(written, /jiaze-review-source-comment:99/);
  assert.match(written, /Dismissed findings \(bot-verified\):/);
  assert.equal(parseSessionComment(written).findings[0].status, 'DISMISSED');
  const handoff = JSON.parse(fs.readFileSync(path.join(root, 'published-session.json'), 'utf8'));
  assert.equal(handoff.session.status, 'AUDIT_PENDING');
  assert.equal(handoff.verdict, 'DISMISSED');
  assert.equal(handoff.sessionCommentId, '6');
  assert.equal(handoff.mode, 'dismiss');
});

for (const [name, opts, error] of [
  ['non-writer', { permission: 'read' }, /write permission/],
  ['wrong author', { actor: 'attacker' }, /does not belong/],
  ['missing evidence', { sourceBody: '@gemini dismiss F001' }, /Evidence/],
  ['moved HEAD', { head: B }, /PR moved/],
  ['stale bot session', { commentBody: renderSessionComment(dismiss(initial())) }, /changed since planning/],
]) {
  test('workflow refuses ' + name + ' before any model call or session mutation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
    const s = initial(); writePlan(root, s);
    const mock = mockGitHub(s, opts);
    let modelCalls = 0;
    await assert.rejects(
      applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl: async () => { modelCalls += 1; throw new Error('should not run'); } }),
      error,
    );
    assert.equal(modelCalls, 0);
    assert.equal(mock.calls.filter(c => ['PATCH', 'POST', 'DELETE'].includes(c.method)).length, 0);
    assert.equal(fs.existsSync(path.join(root, 'published-session.json')), false);
  });
}

test('rejected dismissal keeps finding OPEN and replies in the original bot review thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const threads = [{
    id: 'T1', isResolved: false, resolvedBy: null,
    comments: { nodes: [{ databaseId: 101, author: { login: 'jiaze-claude-review-bot' }, body: `${findingMarker('scripts/ref.mjs', 'Ref endpoint array')}\nFinding body` }] },
  }];
  const mock = mockGitHub(session, { threads });
  const modelFetchImpl = async () => geminiJsonResponse({
    verdict: 'REJECTED',
    reason: 'Prefix refs still return an array when ref is not fully qualified.',
    nextStep: 'Validate or encode the ref path before calling fetchJson.',
    sourceAnchors: [{ path: 'scripts/ref.mjs', line: 3, quote: 'return fetchJson(`/repos/${target}/git/ref/${ref}`);' }],
  });
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl });
  assert.equal(out.status, 'REWORK');
  assert.equal(out.findings[0].status, 'OPEN');
  const reply = mock.calls.find((c) => c.pathname === '/repos/acme/project/pulls/7/comments/101/replies' && c.method === 'POST');
  assert.ok(reply);
  assert.match(JSON.parse(reply.body).body, /F001 dismissal rejected/);
  assert.match(JSON.parse(reply.body).body, /Prefix refs still return an array/);
});

test('rejected dismissal falls back to PR discussion labeled with finding ID when no original thread exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session, { threads: [] });
  const modelFetchImpl = async () => geminiJsonResponse({
    verdict: 'REJECTED',
    reason: 'The failure path remains reachable.',
    nextStep: 'Push a fix.',
    sourceAnchors: [],
  });
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl });
  assert.equal(out.status, 'REWORK');
  const commentPost = mock.calls.find((c) => c.pathname === '/repos/acme/project/issues/7/comments' && c.method === 'POST');
  assert.ok(commentPost);
  assert.match(JSON.parse(commentPost.body).body, /\*\*F001 dismissal rejected\*\*/);
});

test('ungrounded DISMISSED verdict is downgraded to INCONCLUSIVE and fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session, { threads: [] });
  const modelFetchImpl = async () => geminiJsonResponse({
    verdict: 'DISMISSED',
    reason: 'Fabricated dismissal without a real quote.',
    nextStep: '',
    sourceAnchors: [{ path: 'scripts/ref.mjs', line: 3, quote: 'nonexistent code line that is not in repo' }],
  });
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl });
  assert.equal(out.status, 'REWORK');
  assert.equal(out.findings[0].status, 'OPEN');
  const handoff = JSON.parse(fs.readFileSync(path.join(root, 'published-session.json'), 'utf8'));
  assert.equal(handoff.verdict, 'INCONCLUSIVE');
});

test('Gemini 429 falls back to Claude within automatic budget; exhausted budget fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session, { threads: [] });
  const modelFetchImpl = async () => new Response('quota exceeded', { status: 429 });
  const queryImpl = () => (async function* () {
    yield {
      type: 'result', subtype: 'success', total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 40 },
      structured_output: {
        verdict: 'REJECTED',
        reason: 'Claude verified the bug is still present.',
        nextStep: 'Fix the ref validation.',
        sourceAnchors: [{ path: 'scripts/ref.mjs', line: 3, quote: 'return fetchJson(`/repos/${target}/git/ref/${ref}`);' }],
      },
    };
  })();
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl, queryImpl });
  assert.equal(out.status, 'REWORK');
  assert.equal(out.deepSpendUsd, 0.25);

  // Exhausted Claude budget must fail closed with 0 Claude calls
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const exhausted = { ...initial(), deepSpendUsd: 5.8 };
  writePlan(root2, exhausted);
  const mock2 = mockGitHub(exhausted, { threads: [] });
  let claudeCalls = 0;
  const out2 = await applyManualDismissal({
    env: env(root2), fetchImpl: mock2.fetchImpl, modelFetchImpl,
    queryImpl: () => { claudeCalls += 1; throw new Error('must not run'); },
  });
  assert.equal(claudeCalls, 0);
  assert.equal(out2.status, 'REWORK');
  assert.equal(out2.findings[0].status, 'OPEN');
});

test('TOCTOU guard aborts write if PR HEAD or durable session changes during verification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session, { mutateHeadAfterReads: 2 });
  const modelFetchImpl = async () => geminiJsonResponse({
    verdict: 'DISMISSED',
    reason: 'Valid rebuttal.',
    nextStep: '',
    sourceAnchors: [{ path: 'scripts/ref.mjs', line: 3, quote: 'return fetchJson(`/repos/${target}/git/ref/${ref}`);' }],
  });
  await assert.rejects(
    applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl, modelFetchImpl }),
    /PR moved/,
  );
  assert.equal(mock.calls.filter(c => ['PATCH', 'POST', 'DELETE'].includes(c.method)).length, 0);

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  writePlan(root2, session);
  const mock2 = mockGitHub(session, { mutateOnSessionRead: renderSessionComment(dismiss(session)) });
  await assert.rejects(
    applyManualDismissal({ env: env(root2), fetchImpl: mock2.fetchImpl, modelFetchImpl }),
    /changed during dismissal verification/,
  );
  assert.equal(mock2.calls.filter(c => ['PATCH', 'POST', 'DELETE'].includes(c.method)).length, 0);
});

test('idempotency and per-HEAD attempt cap block repeated rebuttals (including INCONCLUSIVE) without model calls', () => {
  let s = initial();
  s = recordDismissAttempt({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '51', inputHash: 'h1', verdict: 'INCONCLUSIVE', reason: 'ungrounded' });
  assert.equal(checkDismissEligibility({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '51', inputHash: 'h1' }).kind, 'duplicate_comment');
  assert.equal(checkDismissEligibility({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '52', inputHash: 'h1' }).kind, 'duplicate_rebuttal');
  assert.equal(checkDismissEligibility({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '52', inputHash: 'h2' }).eligible, true);
  s = recordDismissAttempt({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '52', inputHash: 'h2', verdict: 'REJECTED', reason: 'r2' });
  assert.equal(checkDismissEligibility({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '53', inputHash: 'h3' }).kind, 'attempt_limit');
  // Provider-unavailable INCONCLUSIVE does not consume the rebuttal attempt cap
  let s2 = initial();
  s2 = recordDismissAttempt({ session: s2, findingId: 'F001', headSha: A, sourceCommentId: '61', inputHash: 'h1', verdict: 'INCONCLUSIVE', unavailable: true, reason: '429' });
  assert.equal(checkDismissEligibility({ session: s2, findingId: 'F001', headSha: A, sourceCommentId: '62', inputHash: 'h1' }).eligible, true);
  // More than 8 entries on the same HEAD never evict older dedup/limit entries
  let s3 = initial(5);
  for (let i = 1; i <= 10; i += 1) {
    const fid = `F${String(((i - 1) % 5) + 1).padStart(3, '0')}`;
    s3 = recordDismissAttempt({ session: s3, findingId: fid, headSha: A, sourceCommentId: String(100 + i), inputHash: `hash-${i}`, verdict: 'REJECTED', reason: 'r' });
  }
  assert.equal(checkDismissEligibility({ session: s3, findingId: 'F001', headSha: A, sourceCommentId: '101', inputHash: 'hash-1' }).kind, 'duplicate_comment');
  assert.equal(checkDismissEligibility({ session: s3, findingId: 'F001', headSha: A, sourceCommentId: '201', inputHash: 'hash-1' }).kind, 'duplicate_rebuttal');
  assert.ok(encodeSessionState(s).length > 0);
  assert.ok(encodeSessionState(s3).length > 0);
});

test('limit-rejected comment is recorded in dismissLedger and Claude spend is preserved on TOCTOU abort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  let s = initial();
  s = recordDismissAttempt({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '51', inputHash: 'h1', verdict: 'REJECTED', reason: 'r1' });
  s = recordDismissAttempt({ session: s, findingId: 'F001', headSha: A, sourceCommentId: '52', inputHash: 'h2', verdict: 'REJECTED', reason: 'r2' });
  writePlan(root, s);
  const mock = mockGitHub(s, { threads: [] });
  const out = await applyManualDismissal({
    env: env(root), fetchImpl: mock.fetchImpl,
    modelFetchImpl: async () => { throw new Error('must not call model'); },
  });
  assert.ok(out.dismissLedger.some((entry) => entry.commentId === '99'));

  // Claude spend preserved when PR HEAD moves during Claude fallback
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const s2 = initial(); writePlan(root2, s2);
  const mock2 = mockGitHub(s2, { mutateHeadAfterReads: 2 });
  await assert.rejects(
    applyManualDismissal({
      env: env(root2),
      fetchImpl: mock2.fetchImpl,
      modelFetchImpl: async () => new Response('quota', { status: 429 }),
      queryImpl: () => (async function* () {
        yield {
          type: 'result', subtype: 'success', total_cost_usd: 0.31,
          usage: { input_tokens: 50, output_tokens: 20 },
          structured_output: { verdict: 'REJECTED', reason: 'Still buggy.', nextStep: 'Fix it.', sourceAnchors: [] },
        };
      })(),
    }),
    /PR moved/,
  );
  const patchCall = mock2.calls.find((c) => c.method === 'PATCH' && c.pathname === '/repos/acme/project/issues/comments/5');
  assert.ok(patchCall);
  assert.equal(parseSessionComment(JSON.parse(patchCall.body).body).deepSpendUsd, 0.31);
});

test('planner selects dismissal only for a blocking OPEN/UNCERTAIN finding on the same reviewed HEAD', async () => {
  const comment = { id: 5, user: { login: AUTHOR }, body: renderSessionComment(initial()) };
  const fetchImpl = async (url) => {
    if (url.includes('/issues/7/comments')) return Response.json([comment]);
    if (url.includes('/pulls/7/reviews')) return Response.json([]);
    assert.fail('Unexpected planner URL ' + url);
  };
  const base = { GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7',
    BASE_SHA: BASE, HEAD_SHA: A, EXPECTED_REVIEW_AUTHOR: AUTHOR, REQUESTED_MODE: 'dismiss' };
  assert.equal((await planSession({ env: base, fetchImpl })).decision.mode, 'dismiss');
  assert.equal((await planSession({ env: { ...base, HEAD_SHA: B }, fetchImpl })).decision.mode, 'noop_waiting');
  const downgradedP3 = applyDiscoveryResult({
    result: { summary: 'p3', findings: [{ severity: 'P3', downgradedFrom: 'P2', title: 'Weak', body: 'Weak', path: 'a.js', line: 1, riskClass: 'API' }] },
    baseSha: BASE, headSha: A, sourceCommentId: '9',
  });
  const nonBlockingRes = await planSession({ env: base,
    fetchImpl: async (url) => url.includes('/issues/7/comments')
      ? Response.json([{ ...comment, body: renderSessionComment(downgradedP3) }])
      : Response.json([]),
  });
  assert.equal(nonBlockingRes.decision.mode, 'noop_waiting');
  const done = await planSession({ env: base,
    fetchImpl: async (url) => url.includes('/issues/7/comments')
      ? Response.json([{ ...comment, body: renderSessionComment(dismiss(initial())) }])
      : Response.json([]),
  });
  assert.equal(done.decision.mode, 'noop_waiting');
});

test('the dismissal step uses safe-target and model credentials, and the final review remains a continuation', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.match(yml, /id: dismiss/);
  assert.match(yml, /run: node scripts\/apply-dismissal\.mjs/);
  const block = yml.slice(yml.indexOf('- name: Apply evidence-based finding dismissal'),
    yml.indexOf('- name: Run Claude explicit deep review'));
  assert.match(block, /GEMINI_API_KEY/);
  assert.match(block, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(block, /SAFE_REPO_DIR: safe-target/);
  assert.doesNotMatch(yml, /auto-audit|final-gemini-run/);
});
