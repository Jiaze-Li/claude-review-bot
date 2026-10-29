import { applyFullReview } from './helpers/full-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDiscoveryResult, applyFindingDismissal,
  matchesKnownDismissal, openMaterialFindings, parseSessionComment,
  planReviewSession, renderSessionComment,
} from '../scripts/review-session-core.mjs';
import { parseDismissalRequest, parseReviewTrigger } from '../worker/src/review-trigger.js';
import { planSession } from '../scripts/plan-review-session.mjs';
import { applyManualDismissal } from '../scripts/apply-dismissal.mjs';

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

const env = (root) => ({
  GH_TOKEN: 'synthetic-token', TARGET_REPO: 'acme/project', PR_NUMBER: '7',
  BASE_SHA: BASE, HEAD_SHA: A, SOURCE_KIND: 'comment', SOURCE_COMMENT_ID: '99',
  TRIGGER_USER: 'maintainer', EXPECTED_REVIEW_AUTHOR: AUTHOR, REVIEW_CONTEXT_DIR: root,
});
const writePlan = (root, session = initial()) => {
  fs.writeFileSync(path.join(root, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'dismiss' }, session, sessionCommentId: '5',
  }));
};
function mockGitHub(session, { actor = 'maintainer', permission = 'write', head = A,
  sourceBody = command, commentBody = renderSessionComment(session) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const method = init.method || 'GET';
    calls.push({ pathname, method, body: init.body });
    if (pathname === '/repos/acme/project/pulls/7') {
      return Response.json({ state: 'open', base: { sha: BASE }, head: { sha: head } });
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
    if (pathname === '/repos/acme/project/issues/comments/5') {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return method === 'PATCH' ? Response.json({ id: 5 }) : Response.json({
        user: { login: AUTHOR }, body: commentBody,
      });
    }
    assert.fail('Unexpected API call: ' + pathname);
  };
  return { calls, fetchImpl };
}

test('workflow confirms permissions, writes evidence and produces final-audit handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
  const session = initial(); writePlan(root, session);
  const mock = mockGitHub(session);
  const out = await applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl });
  assert.equal(out.status, 'AUDIT_PENDING');
  // REWORK -> AUDIT_PENDING is a new result: posted as the newest comment, the old one removed
  const posted = mock.calls.find(c => c.method === 'POST');
  assert.equal(posted.pathname, '/repos/acme/project/issues/7/comments');
  assert.equal(mock.calls.find(c => c.method === 'DELETE').pathname, '/repos/acme/project/issues/comments/5');
  const written = JSON.parse(posted.body).body;
  assert.match(written, /jiaze-review-source-comment:99/);
  assert.equal(parseSessionComment(written).findings[0].status, 'DISMISSED');
  const handoff = JSON.parse(fs.readFileSync(path.join(root, 'published-session.json'), 'utf8'));
  assert.equal(handoff.session.status, 'AUDIT_PENDING');
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
  test('workflow refuses ' + name + ' without mutating session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-dismiss-'));
    const s = initial(); writePlan(root, s);
    const mock = mockGitHub(s, opts);
    await assert.rejects(applyManualDismissal({ env: env(root), fetchImpl: mock.fetchImpl }), error);
    assert.equal(mock.calls.filter(c => ['PATCH', 'POST', 'DELETE'].includes(c.method)).length, 0);
    assert.equal(fs.existsSync(path.join(root, 'published-session.json')), false);
  });
}

test('planner selects dismissal only for an OPEN blocker on the same reviewed HEAD', async () => {
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
  const done = await planSession({ env: base,
    fetchImpl: async (url) => url.includes('/issues/7/comments')
      ? Response.json([{ ...comment, body: renderSessionComment(dismiss(initial())) }])
      : Response.json([]),
  });
  assert.equal(done.decision.mode, 'noop_waiting');
});

test('the dismissal step holds no provider credentials, and the final review that follows is a continuation, not a second pipeline', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.match(yml, /id: dismiss/);
  assert.match(yml, /run: node scripts\/apply-dismissal\.mjs/);
  const block = yml.slice(yml.indexOf('- name: Apply evidence-based finding dismissal'),
    yml.indexOf('- name: Apply review-thread decisions'));
  assert.doesNotMatch(block, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(yml, /auto-audit|final-gemini-run/);
});
