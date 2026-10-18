import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyAuditResult, applyDiscoveryResult, applyIncrementalResult,
  applyVerificationResult, parseSessionComment, planReviewSession,
  renderSessionComment, sessionCommitStatus, stopUnavailableReviewSession,
} from '../scripts/review-session-core.mjs';
import {
  classifyIncrementalDelta, prepareIncrementalDelta,
} from '../scripts/select-incremental-review.mjs';
import { buildGeminiRequest } from '../scripts/run-gemini-review.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), BASE = 'd'.repeat(40);
const empty = { summary: 'No confirmed defects in this delta', findings: [] };
const issue = (title = 'Regression') => ({
  severity: 'P1', title, path: 'src/ui.js', line: 5, riskClass: 'regression',
  body: 'Changing the label causes the active view to show stale information.',
  failurePath: 'When the view updates its label, a stale value is displayed in the active view.',
});
function ready() {
  const first = applyDiscoveryResult({ result: empty, baseSha: BASE, headSha: A, sourceCommentId: '91' });
  return applyAuditResult({ session: first, result: empty, headSha: A });
}
const patch = 'diff --git a/src/ui.js b/src/ui.js\n--- a/src/ui.js\n+++ b/src/ui.js\n@@ -1 +1 @@\n-oldLabel\n+newLabel\n';
const changed = (extra = {}) => ({
  session: ready(), numstat: '1\t1\tsrc/ui.js\0', nameStatus: 'M\0src/ui.js\0', patch, ...extra,
});

test('clean small delta is classified incremental, while risk and ambiguous metadata go full', () => {
  assert.equal(classifyIncrementalDelta(changed()).mode, 'incremental');
  assert.equal(classifyIncrementalDelta(changed({ numstat: '51\t0\tsrc/ui.js\0' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ numstat: '1\t1\t.github/workflows/build.yml\0',
    nameStatus: 'M\0.github/workflows/build.yml\0' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ patch: patch + '+mutex.lock()\n' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ nameStatus: 'D\0src/ui.js\0' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ numstat: '1\t1\tproject.pbxproj\0',
    nameStatus: 'M\0project.pbxproj\0' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ numstat: '-\t-\tsrc/ui.js\0' })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ session: { ...ready(), override: { by: 'human' } } })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ session: { ...ready(), incrementalReviewCount: 15 } })).mode, 'discovery');
  assert.equal(classifyIncrementalDelta(changed({ nameStatus: 'R100\0src/a.js\0src/ui.js\0' })).mode, 'discovery');
});

test('READY changes are candidates; successful delta advances exact HEAD without a full audit', () => {
  const old = ready();
  assert.equal(planReviewSession({ session: old, baseSha: BASE, headSha: B }).mode, 'incremental_candidate');
  assert.equal(planReviewSession({ session: old, baseSha: BASE, headSha: B }).previousHead, A);
  const next = applyIncrementalResult({ session: old, result: empty, headSha: B });
  assert.equal(next.status, 'READY');
  assert.equal(next.lastReviewedHead, B);
  assert.equal(next.fullAuditHead, A);
  assert.equal(next.incrementalReviewCount, 1);
  assert.equal(next.auditCompleted, true);
  assert.equal(planReviewSession({ session: next, baseSha: BASE, headSha: C }).previousHead, B);
  assert.equal(sessionCommitStatus(next, C).state, 'pending');
  assert.equal(sessionCommitStatus(next, B).state, 'success');
  assert.deepEqual(parseSessionComment(renderSessionComment(next)), next);
});

test('incremental finding remains blocking with stable prior ledger and a fresh repair budget', () => {
  const old = ready();
  const next = applyIncrementalResult({ session: old, result: { summary: 'regression', findings: [issue()] }, headSha: B });
  assert.equal(next.status, 'REWORK');
  assert.equal(next.findings[0].id, 'F001');
  assert.equal(next.findings[0].origin, 'INCREMENTAL');
  assert.equal(next.findings[0].status, 'OPEN');
  assert.equal(next.verificationRound, 0);
  assert.equal(planReviewSession({ session: next, baseSha: BASE, headSha: C }).mode, 'verification');
  const repaired = applyVerificationResult({ session: next, result: {
    summary: 'Fixed', verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'Confirmed' }], findings: [],
  }, headSha: C });
  assert.equal(repaired.status, 'READY');
  assert.equal(repaired.auditCompleted, true);
  assert.equal(repaired.fullAuditHead, A);
  assert.equal(repaired.findings[0].status, 'FIXED');
});

test('previous fixed findings and Claude spend survive subsequent incremental review', () => {
  const old = { ...ready(), deepSpendUsd: 2.1, fallbackSpendUsd: 0.4,
    findings: [{ id: 'F001', ...issue('Old fixed issue'), status: 'FIXED', origin: 'FINAL_AUDIT' }],
    nextFindingNumber: 2 };
  const next = applyIncrementalResult({ session: old, result: empty, headSha: B });
  assert.equal(next.findings.length, 1);
  assert.equal(next.findings[0].status, 'FIXED');
  assert.equal(next.nextFindingNumber, 2);
  assert.equal(next.deepSpendUsd, 2.1);
  assert.equal(next.fallbackSpendUsd, 0.4);
});

test('provider failure never turns an unreviewed incremental HEAD green; exact retry works', () => {
  const old = ready();
  const failed = stopUnavailableReviewSession({
    session: old, baseSha: BASE, headSha: B, sourceCommentId: '92',
    mode: 'incremental', reason: 'Gemini quota exceeded',
  });
  assert.equal(failed.status, 'HUMAN_REQUIRED');
  assert.equal(failed.reviewFailure.previousHead, A);
  assert.notEqual(sessionCommitStatus(failed, B).state, 'success');
  const retry = planReviewSession({ session: failed, baseSha: BASE, headSha: B, retryUnavailable: true });
  assert.equal(retry.mode, 'incremental');
  assert.equal(retry.previousHead, A);
  // A maintainer can explicitly retry a moved HEAD; the old incremental delta
  // no longer describes that tree, so run a new full discovery instead.
  assert.equal(planReviewSession({ session: failed, baseSha: BASE, headSha: C, retryUnavailable: true }).mode, 'discovery');
  assert.equal(planReviewSession({ session: failed, baseSha: BASE, headSha: C }).mode, 'human_required');
  const reviewed = applyIncrementalResult({ session: failed, headSha: B, result: empty });
  assert.equal(reviewed.status, 'READY');
  assert.equal(reviewed.reviewFailure, undefined);
  assert.equal(reviewed.fullAuditHead, A);
});

test('incremental prompt consumes the HEAD delta and still checks unchanged contracts', () => {
  const req = buildGeminiRequest({
    mode: 'incremental', repo: 'acme/repo', prNumber: 101, headSha: B,
    prJson: '{}', diff: patch, session: ready(),
  });
  assert.match(req.prompt, /INCREMENTAL REVIEW/);
  assert.match(req.prompt, /callers/);
  assert.match(req.prompt, /newLabel/);
  assert.doesNotMatch(req.prompt, /FINAL PR diff/);
  assert.deepEqual(req.schema.required, ['summary', 'findings']);
});

test('exact Git tree delta is materialized without sending old cumulative PR commits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), context = path.join(dir, 'context');
  fs.mkdirSync(repo); fs.mkdirSync(context);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com' },
  }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'src.js'), 'const label = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src.js'), 'const label = 2;\n');
  git('add', '.'); git('commit', '-qm', 'one change');
  const second = git('rev-parse', 'HEAD');
  const result = prepareIncrementalDelta({
    repoDir: repo, contextDir: context, previousHead: first, headSha: second, session: ready(),
  });
  assert.equal(result.mode, 'incremental', result.reason);
  const actual = fs.readFileSync(path.join(context, 'repair.diff'), 'utf8');
  assert.match(actual, /const label = 2;/);
  assert.doesNotMatch(actual, /old commits are re-reviewed/);
});
