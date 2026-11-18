import test from 'node:test';
import assert from 'node:assert/strict';
import { publishRunStatus, recordSessionMarker } from '../scripts/review-status.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';

const HEAD = '1'.repeat(40);
const BASE = '0'.repeat(40);
const BOT = 'owner-review-bot[bot]';

function createMockSession({ status = 'READY', findings = [], verificationRound = 0, auditCompleted = true } = {}) {
  return {
    version: 1, status, findings, verificationRound, maxVerificationRounds: 3, auditCompleted,
    lastReviewedHead: HEAD, baseSha: BASE, fullAuditHead: HEAD, deepSpendUsd: 0,
  };
}

const runEnv = (extra = {}) => ({
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '900', GITHUB_RUN_ATTEMPT: '1',
  TARGET_REPO: 'target/repo', PR_NUMBER: '42', SOURCE_KIND: 'comment', HEAD_SHA: HEAD, STATUS_STAGE: 'finished',
  GH_TOKEN: 'fake-token', EXPECTED_REVIEW_AUTHOR: BOT, ...extra,
});
const receiptsOf = (pr) => pr.issue.filter((c) => /^### Review Receipt/.test(c.body));

test('idempotency: a silent noop_ready writes a visible receipt and a redelivery is recognised', async () => {
  const session = createMockSession({ status: 'READY' });
  const pr = createFakePr({ author: BOT, number: 42 });
  pr.seed(session);
  const env = runEnv({ SOURCE_COMMENT_ID: '200', REVIEW_MODE: 'noop_ready', REVIEW_REASON: 'current HEAD is already READY' });

  // Run 1: first delivery of source comment 200 is silent in the conversation
  const before = pr.issue.length;
  const result1 = await publishRunStatus({ env, fetchImpl: pr.fetchImpl, plan: { sessionCommentId: '777', session } });
  assert.equal(result1, null);
  assert.equal(pr.issue.length, before + 1);
  assert.equal(receiptsOf(pr).length, 1);
  assert.match(receiptsOf(pr)[0].body, /Handled: comment 200 \(version created\)/);

  // Run 2: the workflow dedupe step marks the redelivery as a duplicate; nothing more is written
  const result2 = await publishRunStatus({ env: { ...env, DUPLICATE: 'true' }, fetchImpl: pr.fetchImpl, plan: { sessionCommentId: '777', session } });
  assert.equal(result2, null);
  assert.equal(pr.issue.length, before + 1);

  // Even without the workflow's dedupe, the receipt already on the PR stops a second one
  await publishRunStatus({ env, fetchImpl: pr.fetchImpl, plan: { sessionCommentId: '777', session } });
  assert.equal(receiptsOf(pr).length, 1);
});

test('idempotency: a zero-change thread resolution records its receipt silently without conversation spam', async () => {
  const session = createMockSession({ status: 'REWORK' });
  const pr = createFakePr({ author: BOT, number: 42 });
  pr.seed(session);
  const env = runEnv({ SOURCE_COMMENT_ID: '20', REVIEW_MODE: 'threads', THREADS_OUTCOME: 'success', THREAD_PROBLEMS: '0' });
  const res = await publishRunStatus({ env, fetchImpl: pr.fetchImpl, plan: { sessionCommentId: '888', session } });
  assert.equal(res, null);
  assert.equal(receiptsOf(pr).length, 1);
  assert.match(receiptsOf(pr)[0].body, /Handled: comment 20/);
  assert.doesNotMatch(pr.issue.map((c) => c.body).join('\n'), /Review-thread decisions applied/);
  assert.equal(pr.session().status, 'REWORK');
});

test('deterministic concurrency: two actors recording different commands at the same time both survive (AC5, E1)', async () => {
  const pr = createFakePr({ author: BOT, number: 42 });
  pr.seed(createMockSession({ status: 'READY' }));
  const base = { targetRepo: 'target/repo', prNumber: '42', token: 't', botLogin: BOT, fetchImpl: pr.fetchImpl, log: { warn() {} } };
  // Both read the same prior ledger before either writes: the old single-comment marker lost one of them.
  await Promise.all([
    recordSessionMarker({ ...base, sourceCommentId: '8' }),
    recordSessionMarker({ ...base, sourceCommentId: '9' }),
  ]);
  const handled = receiptsOf(pr).map((c) => /comment (\d+)/.exec(c.body)[1]).sort();
  assert.deepEqual(handled, ['8', '9']);
  assert.equal(pr.ledger().state, 'ok');
});

test('a command that was already receipted is not receipted again, even by a racing duplicate', async () => {
  const pr = createFakePr({ author: BOT, number: 42 });
  pr.seed(createMockSession({ status: 'READY' }));
  const base = { targetRepo: 'target/repo', prNumber: '42', token: 't', botLogin: BOT, fetchImpl: pr.fetchImpl, log: { warn() {} } };
  await recordSessionMarker({ ...base, sourceCommentId: '8' });
  await recordSessionMarker({ ...base, sourceCommentId: '8' });
  assert.equal(receiptsOf(pr).length, 1);
});

test('the workflow dedupe step recognises the visible receipt as well as the old hidden marker', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Check source comment idempotency'), yml.indexOf('- name:', yml.indexOf('- name: Check source comment idempotency') + 10));
  assert.match(step, /marker_receipt="Handled: comment \$\{SOURCE_COMMENT_ID\} \(version"/);
  assert.match(step, /contains\(\$m3\)/);
  assert.match(step, /jiaze-review-source-comment/); // PRs reviewed before the change are still deduplicated
});
