import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyAuditResult,
  applyDiscoveryResult,
  applyOverride,
  applyVerificationResult,
  knownIssuesPromptBlock,
  normalizeReviewResult,
  openMaterialFindings,
  parseSessionComment,
  planReviewSession,
  recordDismissed,
  renderSessionComment,
  similarity,
} from '../scripts/review-session-core.mjs';
import { buildGeminiRequest } from '../scripts/run-gemini-review.mjs';
import { applyManualOverride } from '../scripts/apply-override.mjs';
import { planSession } from '../scripts/plan-review-session.mjs';
import { parseReviewTrigger } from '../worker/src/review-trigger.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), BASE = 'd'.repeat(40);
const PATH_OK = 'Calling save() twice with the same id keeps the stale copy, so the second write is lost.';
const finding = (over = {}) => ({
  severity: 'P1', title: 'Lost update in save', body: 'Trigger X causes Y; expected Z.',
  path: 'src/a.js', line: 10, riskClass: 'state', failurePath: PATH_OK, ...over,
});
const session = (findings = []) => applyDiscoveryResult({
  result: { summary: 's', findings }, baseSha: BASE, headSha: A, sourceCommentId: '9',
});

// ---- evidence rule -------------------------------------------------------

test('material finding with a weak failurePath is demoted to non-blocking P3', () => {
  const r = normalizeReviewResult({ summary: 's', findings: [finding({ failurePath: 'might fail' })] });
  assert.equal(r.findings[0].severity, 'P3');
  assert.equal(r.findings[0].downgradedFrom, 'P1');
  const s = session(r.findings);
  assert.equal(openMaterialFindings(s).length, 0);
  assert.equal(s.status, 'AUDIT_PENDING');
});

test('material finding with a concrete failurePath stays blocking', () => {
  const r = normalizeReviewResult({ summary: 's', findings: [finding()] });
  assert.equal(r.findings[0].severity, 'P1');
  assert.equal(session(r.findings).status, 'REWORK');
});

test('legacy findings without a failurePath field keep their severity', () => {
  const legacy = finding();
  delete legacy.failurePath;
  assert.equal(normalizeReviewResult({ summary: 's', findings: [legacy] }).findings[0].severity, 'P1');
});

test('Gemini schema requires failurePath on every finding', () => {
  const req = buildGeminiRequest({
    mode: 'discovery', repo: 'a/b', prNumber: 1, headSha: A, prJson: '{}', diff: 'd', session: null,
  });
  assert.ok(req.schema.properties.findings.items.required.includes('failurePath'));
});

// ---- known-issue ledger --------------------------------------------------

const dismissal = (over = {}) => ({
  candidateId: 'D001', verdict: 'REJECTED', reason: 'guard in load() blocks it',
  path: 'src/a.js', line: 10, title: 'Lost update in save path', riskClass: 'state', ...over,
});

test('recordDismissed keeps only rejected/uncertain candidates and caps the list', () => {
  const base = session();
  const s = recordDismissed(base, [
    dismissal(), dismissal({ verdict: 'CONFIRMED', title: 'other' }), dismissal({ verdict: 'UNCERTAIN', title: 'unsure thing here' }),
  ], A);
  assert.deepEqual(s.dismissed.map((d) => d.verdict), ['REJECTED', 'UNCERTAIN']);
  let big = base;
  for (let i = 0; i < 30; i += 1) big = recordDismissed(big, [dismissal({ title: `unique concern number ${i}` })], A);
  assert.equal(big.dismissed.length, 20);
});

test('final audit drops a reworded repeat of a dismissed concern but keeps genuinely new ones', () => {
  const s = { ...recordDismissed(session(), [dismissal()], A), status: 'AUDIT_PENDING' };
  const out = applyAuditResult({
    session: s, headSha: A,
    result: { summary: 'a', findings: [
      finding({ title: 'Save path suffers a lost update' }),
      finding({ title: 'Token never expires', path: 'src/auth.js' }),
    ] },
  });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].path, 'src/auth.js');
});

test('same title in a different file is not suppressed', () => {
  const s = { ...recordDismissed(session(), [dismissal()], A), status: 'AUDIT_PENDING' };
  const out = applyAuditResult({
    session: s, headSha: A,
    result: { summary: 'a', findings: [finding({ path: 'src/b.js' })] },
  });
  assert.equal(out.findings.length, 1);
});

test('repair regressions matching a dismissed concern are dropped during verification', () => {
  const open = session([finding()]);
  const s = recordDismissed(open, [dismissal({ title: 'Cache never invalidated on write', path: 'src/c.js' })], A);
  const out = applyVerificationResult({
    session: s, headSha: B,
    result: { summary: 'v', verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'ok' }],
      findings: [finding({ title: 'Cache is never invalidated after write', path: 'src/c.js' })] },
  });
  assert.equal(out.findings.length, 1);
});

test('prompt block lists dismissed and settled items, and is empty when none exist', () => {
  assert.equal(knownIssuesPromptBlock(session()), '');
  const block = knownIssuesPromptBlock(recordDismissed(session(), [dismissal()], A));
  assert.match(block, /ALREADY EXAMINED/);
  assert.match(block, /\[REJECTED\] src\/a\.js/);
  const audit = buildGeminiRequest({
    mode: 'audit', repo: 'a/b', prNumber: 1, headSha: A, prJson: '{}', diff: 'd',
    session: recordDismissed(session(), [dismissal()], A),
  });
  assert.match(audit.prompt, /ALREADY EXAMINED/);
});

test('similarity ignores case and short words', () => {
  assert.ok(similarity('Lost Update in save', 'lost update in SAVE path') > 0.5);
  assert.equal(similarity('', 'x'), 0);
});

test('dismissed ledger survives the session-comment round trip', () => {
  const s = recordDismissed(session(), [dismissal()], A);
  assert.equal(parseSessionComment(renderSessionComment(s)).dismissed.length, 1);
});

// ---- manual override -----------------------------------------------------

test('override waives open findings and ends the session as READY on the current HEAD', () => {
  const s = session([finding()]);
  const out = applyOverride({ session: s, headSha: B, by: 'alice' });
  assert.equal(out.status, 'READY');
  assert.equal(out.lastReviewedHead, B);
  assert.equal(out.findings[0].status, 'WAIVED');
  assert.deepEqual(out.override.waived, ['F001']);
  assert.equal(openMaterialFindings(out).length, 0);
  assert.match(renderSessionComment(out), /manually overridden by @alice/);
});

test('after an override the same HEAD is a no-op and a new commit starts a fresh session', () => {
  const out = applyOverride({ session: session([finding()]), headSha: B, by: 'alice' });
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: B }).mode, 'noop_ready');
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: C }).mode, 'discovery');
});

test('override rejects READY sessions and unsafe user names', () => {
  const ready = applyOverride({ session: session([finding()]), headSha: A, by: 'alice' });
  assert.throws(() => applyOverride({ session: ready, headSha: A, by: 'alice' }), /already READY/);
  assert.throws(() => applyOverride({ session: session([finding()]), headSha: A, by: 'x -->' }), /invalid override user/);
});

test('override command parses only as a standalone first-line command', () => {
  assert.deepEqual(parseReviewTrigger('@jiaze-claude-review-bot override review'), { requestedMode: 'override' });
  assert.equal(parseReviewTrigger('please @jiaze-claude-review-bot override review'), null);
  assert.equal(parseReviewTrigger('> @jiaze-claude-review-bot override review'), null);
  assert.equal(parseReviewTrigger('@jiaze-claude-review-bot override'), null);
});

const author = 'jiaze-claude-review-bot[bot]';
const planEnv = (extra = {}) => ({
  GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
  REQUESTED_MODE: 'override', EXPECTED_REVIEW_AUTHOR: author, ...extra,
});
const listFetch = (comments) => async (url) => {
  if (/issues\/7\/comments/.test(url)) return Response.json(comments);
  if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
  assert.fail('unexpected ' + url);
};

test('planner chooses override only for an unfinished session', async () => {
  const body = renderSessionComment(session([finding()]));
  const plan = await planSession({ env: planEnv(), fetchImpl: listFetch([{ id: 5, user: { login: author }, body }]) });
  assert.equal(plan.decision.mode, 'override');
  const none = await planSession({ env: planEnv(), fetchImpl: listFetch([]) });
  assert.equal(none.decision.mode, 'noop_waiting');
  const ready = renderSessionComment(applyOverride({ session: session([finding()]), headSha: A, by: 'bob' }));
  const done = await planSession({ env: planEnv(), fetchImpl: listFetch([{ id: 5, user: { login: author }, body: ready }]) });
  assert.equal(done.decision.mode, 'noop_waiting');
});

test('apply-override rewrites the session comment with the processed-source marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
  const s = session([finding()]);
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'override' }, session: s, sessionCommentId: '5',
  }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (!init.method) return Response.json({ base: { sha: BASE }, head: { sha: B } });
    return Response.json({ id: 5 });
  };
  const out = await applyManualOverride({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
      TRIGGER_USER: 'alice', SOURCE_COMMENT_ID: '77', REVIEW_CONTEXT_DIR: dir },
    fetchImpl,
  });
  assert.equal(out.status, 'READY');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.match(patch.url, /issues\/comments\/5$/);
  const body = JSON.parse(patch.body).body;
  assert.match(body, /jiaze-review-source-comment:77/);
  assert.equal(parseSessionComment(body).status, 'READY');
});

test('apply-override refuses when the PR HEAD moved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'override' }, session: session([finding()]), sessionCommentId: '5',
  }));
  await assert.rejects(() => applyManualOverride({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
      TRIGGER_USER: 'alice', SOURCE_COMMENT_ID: '77', REVIEW_CONTEXT_DIR: dir },
    fetchImpl: async () => Response.json({ base: { sha: BASE }, head: { sha: C } }),
  }), /PR moved/);
});
