import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSession, fullReviewDecision } from '../scripts/plan-review-session.mjs';
import {
  CLAUDE_AUTO_MIN_BUDGET_USD, DEEP_REVIEW_MANUAL_RUN_BUDGET_USD, DEEP_REVIEW_PR_BUDGET_USD, DEEP_REVIEW_RUN_BUDGET_USD,
  applyDiscoveryResult, beginDeepReview, failDeepReview, isFullMode, isManualBudgetExemptReview,
  providerPolicyFor, providerPolicyOf, renderSessionComment, scopeOfMode, sessionCommitStatus,
} from '../scripts/review-session-core.mjs';
import { continuationMode } from '../scripts/continue-review.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), C = 'c'.repeat(40);
const author = 'jiaze-claude-review-bot[bot]';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (extra = {}) => ({
  GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
  REQUESTED_MODE: 'auto', EXPECTED_REVIEW_AUTHOR: author, ...extra,
});
function fetchWith(session) {
  const pr = createFakePr({ author, number: 7 });
  if (session) {
    pr.seed(session);
    pr.addIssue(renderSessionComment(session), { id: 7, user: author, type: 'Bot' });
  }
  return pr.fetchImpl;
}
const clean = (head = A) => applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: head, sourceCommentId: '1' });
const withBug = (head = A) => applyDiscoveryResult({ result: { summary: 'bug', findings: [{ severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' }] }, baseSha: BASE, headSha: head, sourceCommentId: '1' });
const ready = () => ({ ...clean(), status: 'READY', auditCompleted: true });
const sessions = {
  none: [null, A],
  awaitingAuditSameHead: [clean(), A],
  awaitingAuditNewHead: [clean(), C],
  inProgressSameHead: [{ ...clean(), status: 'REVIEW_IN_PROGRESS', deepReview: { head: A, startedAt: new Date().toISOString(), state: 'IN_PROGRESS', resumeStatus: 'AUDIT_PENDING' } }, A],
  readySameHead: [ready(), A],
  readyNewHead: [ready(), C],
  reworkNewHead: [withBug(), C],
  partialSameHead: [{ ...clean(), status: 'PARTIAL', coverage: { complete: false, head: A, reviewedKeys: [], unreviewedPaths: ['x'], unreviewedCount: 1 } }, A],
  humanRequiredUnavailableRetry: [failDeepReview({ session: beginDeepReview({ session: clean(), baseSha: BASE, headSha: A }), headSha: A, reason: 'quota' }), A],
};

test('I1: auto and claude get the same scope and route for every session state; only the provider policy differs', async () => {
  for (const [name, [session, head]] of Object.entries(sessions)) {
    for (const sourceKind of ['comment', 'pull_request']) {
      const run = (mode) => planSession({ env: env({ REQUESTED_MODE: mode, SOURCE_KIND: sourceKind, HEAD_SHA: head }), fetchImpl: fetchWith(session) });
      const [auto, claude] = [await run('auto'), await run('claude')];
      const label = `${name}/${sourceKind}`;
      assert.equal(claude.decision.mode, auto.decision.mode, label);
      assert.equal(claude.decision.scope, auto.decision.scope, label);
      assert.equal(claude.decision.scope, scopeOfMode(claude.decision.mode), label);
      assert.equal(auto.providerPolicy, 'default', label);
      assert.equal(claude.providerPolicy, 'claude_only', label);
    }
  }
});

test('scope is full for the whole-PR route, targeted for delta reviews, none otherwise', () => {
  assert.equal(scopeOfMode('full'), 'full');
  assert.equal(scopeOfMode('claude'), 'full'); // old route name still means a full review
  assert.equal(scopeOfMode('verification'), 'targeted');
  assert.equal(scopeOfMode('incremental'), 'targeted');
  for (const mode of ['noop_waiting', 'noop_ready', 'human_required', 'recover', 'override', 'dismiss', 'threads', 'stale']) {
    assert.equal(scopeOfMode(mode), null, mode);
  }
  assert.equal(isFullMode('full'), true);
  assert.equal(isFullMode('claude'), true);
  assert.equal(isFullMode('verification'), false);
});

test('provider policy comes from the plan, and an older plan without one falls back to the request', () => {
  assert.equal(providerPolicyOf({ providerPolicy: 'claude_only', requestedMode: 'auto' }), 'claude_only');
  assert.equal(providerPolicyOf({ requestedMode: 'claude' }), 'claude_only');
  assert.equal(providerPolicyOf({ requestedMode: 'auto' }), 'default');
  assert.equal(providerPolicyOf(null), 'default');
  assert.equal(providerPolicyFor('reset'), 'default');
  assert.equal(continuationMode('claude'), 'claude');
  assert.equal(continuationMode('auto'), 'auto');
});

test('full review reason names the model policy but the route name is the same for both', () => {
  const e = { REVIEW_CONTEXT_DIR: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'scope-')) };
  const a = fullReviewDecision(e, 'auto', 'why');
  const c = fullReviewDecision(e, 'claude', 'why');
  assert.equal(a.mode, 'full');
  assert.equal(c.mode, 'full');
  assert.match(a.reason, /Gemini first/);
  assert.match(c.reason, /Claude only/);
});

test('I3: budget numbers and the manual-review rule are unchanged', () => {
  assert.deepEqual(
    { CLAUDE_AUTO_MIN_BUDGET_USD, DEEP_REVIEW_MANUAL_RUN_BUDGET_USD, DEEP_REVIEW_PR_BUDGET_USD, DEEP_REVIEW_RUN_BUDGET_USD },
    { CLAUDE_AUTO_MIN_BUDGET_USD: 0.5, DEEP_REVIEW_MANUAL_RUN_BUDGET_USD: 5, DEEP_REVIEW_PR_BUDGET_USD: 6, DEEP_REVIEW_RUN_BUDGET_USD: 2 },
  );
  const table = {};
  for (const sourceKind of ['comment', 'pull_request']) {
    for (const requestedMode of ['auto', 'reset', 'claude', 'threads', 'dismiss', 'override', 'stale']) {
      table[`${sourceKind}/${requestedMode}`] = isManualBudgetExemptReview({ sourceKind, requestedMode });
    }
  }
  assert.deepEqual(table, {
    'comment/auto': true, 'comment/reset': true, 'comment/claude': true, 'comment/threads': true, 'comment/dismiss': false, 'comment/override': false, 'comment/stale': false,
    'pull_request/auto': false, 'pull_request/reset': false, 'pull_request/claude': false, 'pull_request/threads': true, 'pull_request/dismiss': false, 'pull_request/override': false, 'pull_request/stale': false,
  });
});

function sourceFiles(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(full, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [full] : [];
  });
}

test('I4: only the provider-policy helpers decide the model from requestedMode', () => {
  // Allowed: the helpers themselves, the trigger parser, and the planner's pass-through request checks.
  const allowed = new Set(['scripts/review-session-core.mjs', 'worker/src/review-trigger.js']);
  const pattern = /(requestedMode|requested)\s*===\s*'claude'/;
  const offenders = [];
  for (const file of [...sourceFiles(path.join(root, 'scripts'), ['.mjs']), ...sourceFiles(path.join(root, 'worker/src'), ['.js'])]) {
    const rel = path.relative(root, file);
    if (allowed.has(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (pattern.test(line)) offenders.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

test('the same-HEAD wait check in the planner keeps its original condition', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/plan-review-session.mjs'), 'utf8');
  assert.match(source, /if\(\['claude','reset'\]\.includes\(requested\) && session && session\.lastReviewedHead===headSha && session\.status==='REVIEW_IN_PROGRESS' && !isDeepReviewStale\(session\)\)\{/);
});

test('a plan file written before this change (route "claude", no policy fields) is still understood', () => {
  const legacy = { requestedMode: 'claude', decision: { mode: 'claude', previousHead: null, reason: 'x' } };
  assert.equal(isFullMode(legacy.decision.mode), true);
  assert.equal(scopeOfMode(legacy.decision.mode), 'full');
  assert.equal(providerPolicyOf(legacy), 'claude_only');
});

test('the final plan from runSessionPlanner always carries a scope that matches its route', async () => {
  const { runSessionPlanner } = await import('../scripts/plan-review-session.mjs');
  const e = env({ REVIEW_CONTEXT_DIR: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'scope-')), REQUESTED_MODE: 'claude' });
  const plan = await runSessionPlanner({ env: e, fetchImpl: fetchWith(null), log: { log() {}, warn() {} } });
  assert.equal(plan.decision.mode, 'full');
  assert.equal(plan.decision.scope, 'full');
  assert.equal(plan.providerPolicy, 'claude_only');
});

test('I6: the status text and comments a person sees never say "deep review"', () => {
  const awaiting = clean();
  const inProgress = { ...awaiting, status: 'REVIEW_IN_PROGRESS', deepReview: { head: A, startedAt: new Date().toISOString(), state: 'IN_PROGRESS', resumeStatus: 'AUDIT_PENDING' } };
  const failed = failDeepReview({ session: beginDeepReview({ session: awaiting, baseSha: BASE, headSha: A }), headSha: A, reason: 'quota' });
  const texts = [
    sessionCommitStatus(inProgress, A).description,
    renderSessionComment(inProgress),
    renderSessionComment(failed),
    failed.lastSummary,
    sessionCommitStatus(failed, A).description,
  ];
  for (const text of texts) assert.doesNotMatch(String(text), /deep[ -]review/i);
});

test('I6: no user-facing string in scripts, README or workflow step names says "deep review"', () => {
  const files = [
    ...sourceFiles(path.join(root, 'scripts'), ['.mjs']),
    path.join(root, 'README.md'),
    ...sourceFiles(path.join(root, '.github'), ['.yml']),
  ];
  const offenders = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // Identifiers (deepReview, deep-review.mjs, DEEP_REVIEW_*, deep_review_stale) are stored names, not wording.
      const prose = line.replace(/[\w./-]*deep[-_]?review[\w./-]*/gi, '');
      if (/deep[ -]review/i.test(prose)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('workflow routes the full review on mode "full" and keeps no leftover "claude" route', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/review-v2.yml'), 'utf8');
  assert.match(yml, /steps\.plan\.outputs\.mode == 'full'/);
  assert.doesNotMatch(yml, /steps\.plan\.outputs\.mode == 'claude'/);
});

test('Assumption 2: the required status check name is a constant that no wording change touches', async () => {
  const { STATUS_CONTEXT } = await import('../scripts/sync-commit-status.mjs');
  assert.equal(STATUS_CONTEXT, 'claude-review-bot/review');
  const source = fs.readFileSync(path.join(root, 'scripts/sync-commit-status.mjs'), 'utf8');
  assert.match(source, /context: STATUS_CONTEXT, description: status\.description/);
});
