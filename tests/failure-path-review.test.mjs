import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectReviewRisk } from '../scripts/detect-review-risk.mjs';
import { failurePathProcedure, stateIntegrityProcedure } from '../scripts/review-prompts.mjs';
import { FAILURE_PATH_SUMMARY_PREFIX, formatFailurePathSummaryLine, mergeShardResults } from '../scripts/review-shards.mjs';
import { STAGED_REVIEW_MAX_TURNS, buildGeminiRequest, runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { combineUnits } from '../scripts/run-review.mjs';
import { parseRecord, renderHandoffParts, runSpendFromCharges } from '../scripts/review-ledger.mjs';
import {
  NEGATIVE_CONTROL_DIFFS,
  PR60_BOOLEAN_MCP_ROLLBACK_DIFF,
  PR60_CHMOD_TEST_DIFF,
  PR60_TRISTATE_MCP_ROLLBACK_DIFF,
} from './fixtures/pr60-failure-recovery.mjs';
import './fixtures/register-mock-provider.mjs';

// ---- L1: Classifier offline tests (PR #60 fixtures + negative controls) ----

test('L1: failureRecovery triggers on PR #60 boolean MCP rollback, tri-state MCP rollback, and chmod fault-injection test', () => {
  const r1 = detectReviewRisk({ diff: PR60_BOOLEAN_MCP_ROLLBACK_DIFF });
  assert.equal(r1.failureRecovery, true);
  assert.ok(r1.signals.recovery.length > 0);
  assert.ok(r1.signals.externalCall.length > 0);

  const r2 = detectReviewRisk({ diff: PR60_TRISTATE_MCP_ROLLBACK_DIFF });
  assert.equal(r2.failureRecovery, true);
  assert.ok(r2.signals.recovery.length > 0);
  assert.ok(r2.signals.externalCall.length > 0);

  const r3 = detectReviewRisk({ diff: PR60_CHMOD_TEST_DIFF });
  assert.equal(r3.failureRecovery, true);
  assert.ok(r3.signals.faultInjection.length > 0);
});

test('L1: negative controls do not trigger failureRecovery and stateIntegrity remains unchanged', () => {
  for (const [name, diff] of Object.entries(NEGATIVE_CONTROL_DIFFS)) {
    const risk = detectReviewRisk({ diff });
    assert.equal(risk.failureRecovery, false, `${name} should not trigger failureRecovery`);
    assert.equal(risk.stateIntegrity, false, `${name} should not trigger stateIntegrity`);
  }
});

// ---- L2: Prompt assembly & byte-for-byte invariance ----

test('L2: low-risk and missing riskProfile produce empty procedure and byte-for-byte identical staged prompts', () => {
  assert.equal(failurePathProcedure(null), '');
  assert.equal(failurePathProcedure({ version: 1, stateIntegrity: false, failureRecovery: false }), '');
  assert.equal(failurePathProcedure({ version: 1, stateIntegrity: true }), '');
  assert.equal(STAGED_REVIEW_MAX_TURNS, 8);

  const session = {
    version: 1,
    status: 'REWORK',
    baseSha: '0'.repeat(40),
    lastReviewedHead: '0'.repeat(40),
    findings: [{ id: 'F001', severity: 'P2', title: 't', body: 'b', path: 'a.js', line: 1, riskClass: 'bug', status: 'OPEN' }],
  };
  for (const mode of ['incremental', 'verification']) {
    for (const hasTools of [false, true]) {
      const base = buildGeminiRequest({
        mode,
        repo: 'Jiaze-Li/pr-bot',
        prNumber: 107,
        headSha: 'a'.repeat(40),
        prJson: '{"number":107}',
        diff: '+const x = 1;',
        session,
        hasTools,
      });
      const lowRisk = buildGeminiRequest({
        mode,
        repo: 'Jiaze-Li/pr-bot',
        prNumber: 107,
        headSha: 'a'.repeat(40),
        prJson: '{"number":107}',
        diff: '+const x = 1;',
        session,
        hasTools,
        riskProfile: { version: 1, stateIntegrity: false, failureRecovery: false },
      });
      assert.equal(lowRisk.prompt, base.prompt);
      assert.deepEqual(lowRisk.schema, base.schema);
    }
  }
});

test('L2: failureRecovery=true injects 3-state semantics, horizontal sibling check, and failurePathNote into all prompt modes', () => {
  const riskProfile = { version: 1, stateIntegrity: false, failureRecovery: true };
  const full = failurePathProcedure(riskProfile, { mode: 'full' });
  assert.match(full, /FAILURE-RECOVERY RISK/);
  assert.match(full, /present \/ confirmed-absent \/ unknown/);
  assert.match(full, /Bounded horizontal sibling check/);
  assert.ok(Buffer.byteLength(full, 'utf8') <= 1536);

  const session = {
    version: 1,
    status: 'REWORK',
    baseSha: '0'.repeat(40),
    lastReviewedHead: '0'.repeat(40),
    findings: [{ id: 'F001', severity: 'P2', title: 't', body: 'b', path: 'a.js', line: 1, riskClass: 'bug', status: 'OPEN' }],
  };
  const inc = buildGeminiRequest({
    mode: 'incremental',
    repo: 'Jiaze-Li/pr-bot',
    prNumber: 107,
    headSha: 'a'.repeat(40),
    prJson: '{"number":107}',
    diff: '+const x = 1;',
    session,
    hasTools: true,
    riskProfile,
  });
  assert.match(inc.prompt, /FAILURE-RECOVERY RISK/);
  assert.ok(inc.schema.properties.failurePathNote);

  const ver = buildGeminiRequest({
    mode: 'verification',
    repo: 'Jiaze-Li/pr-bot',
    prNumber: 107,
    headSha: 'a'.repeat(40),
    prJson: '{"number":107}',
    diff: '+const x = 1;',
    session,
    hasTools: true,
    riskProfile,
  });
  assert.match(ver.prompt, /FAILURE-RECOVERY RISK/);
  assert.match(ver.prompt, /NOT "unrelated pre-existing issues"/);
  assert.ok(ver.schema.properties.failurePathNote);

  // stateIntegrityProcedure remains independent and unaffected.
  assert.equal(stateIntegrityProcedure(riskProfile), '');
});

// ---- L3: Multi-shard aggregation, truncation priority, mock-provider E2E, ledger invariance ----

test('L3: mergeShardResults is byte-for-byte identical when failureRecovery=false and preserves unverified warnings under truncation when true', () => {
  const shards = [{ files: ['a.js'] }, { files: ['b.js'] }, { files: ['c.js'] }];
  const results = [
    {
      ok: true,
      provider: 'claude',
      structured: {
        summary: 'Shard 1 ok',
        findings: [],
        coverage: { complete: true, reviewedPaths: ['a.js'], unreviewedPaths: [], note: '' },
        failurePathNote: 'Checked execFileSync mcpState across install-plugin.js and verified all callers handle unknown safely without deleting registrations. '.repeat(2),
      },
    },
    {
      ok: true,
      provider: 'claude',
      structured: {
        summary: 'Shard 2 ok',
        findings: [],
        coverage: { complete: true, reviewedPaths: ['b.js'], unreviewedPaths: [], note: '' },
      },
    },
    {
      ok: false,
      error: 'turn limit',
    },
  ];
  const base = mergeShardResults({ shards, results, deferred: ['d.js'], allFiles: ['a.js', 'b.js', 'c.js', 'd.js'] });
  const lowRisk = mergeShardResults({ shards, results, deferred: ['d.js'], allFiles: ['a.js', 'b.js', 'c.js', 'd.js'], failureRecovery: false });
  assert.deepEqual(lowRisk, base);
  assert.equal(lowRisk.summary.includes(FAILURE_PATH_SUMMARY_PREFIX), false);

  const highRisk = mergeShardResults({ shards, results, deferred: ['d.js'], allFiles: ['a.js', 'b.js', 'c.js', 'd.js'], failureRecovery: true });
  assert.deepEqual(highRisk.coverage, base.coverage);
  assert.match(highRisk.summary, /Failure-path checks \(separate from file coverage; not a proof that every failure path is safe\):/);
  assert.match(highRisk.summary, /\[Unverified: shard 2\/3 not reported; shard 3\/3 failed; 1 deferred file\(s\) not checked\]/);

  // All shards omitting failurePathNote produces explicit not-reported wording.
  const allMissing = mergeShardResults({
    shards: [{ files: ['a.js'] }],
    results: [{
      ok: true,
      provider: 'claude',
      structured: {
        summary: 'ok',
        findings: [],
        coverage: { complete: true, reviewedPaths: ['a.js'], unreviewedPaths: [], note: '' },
      },
    }],
    allFiles: ['a.js'],
    failureRecovery: true,
  });
  assert.match(allMissing.summary, /not reported — exception paths were not verified/);
  assert.equal(formatFailurePathSummaryLine({ notes: [] }).includes('Coverage:'), false);
  assert.equal(formatFailurePathSummaryLine({ notes: [] }).includes('Ready:'), false);
});

test('L3: runGeminiReview with mock-runner-provider emits failure-path scope line only when failureRecovery=true', async () => {
  async function runWithRisk(failureRecovery) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-mock-'));
    const ctxDir = path.join(tmpDir, '.review-context');
    fs.mkdirSync(ctxDir, { recursive: true });
    fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({
      decision: { mode: 'incremental' },
      requestedMode: 'auto',
      session: { version: 1, threadId: 't', status: 'OPEN', findings: [] },
    }));
    fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'T', base: { ref: 'main' } }));
    fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+x\n');
    fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({
      version: 1,
      stateIntegrity: false,
      failureRecovery,
      signals: { synchronization: [], durableState: [], multiActor: [], recovery: [], externalCall: [], faultInjection: [] },
    }));
    try {
      return await runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        fetchImpl: null,
        logImpl: () => {},
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const low = await runWithRisk(false);
  assert.equal(low.summary.includes(FAILURE_PATH_SUMMARY_PREFIX), false);

  const high = await runWithRisk(true);
  assert.match(high.summary, /Failure-path checks \(separate from file coverage; not a proof that every failure path is safe\): not reported — exception paths were not verified/);
});

test('L3: adding Failure-path checks line to handoff intro does not alter parsed coverage or ready state', () => {
  const session = {
    version: 1,
    status: 'READY',
    auditCompleted: true,
    lastReviewedHead: 'a'.repeat(40),
    deepSpendUsd: 0.25,
    coverage: { complete: true, unreviewedCount: 0 },
    findings: [],
  };
  const runSpend = runSpendFromCharges([{ amount: 0.25, source: 'sdk' }]);
  const baseBody = renderHandoffParts({ session, stage: 'closing', seq: 1, runSpend })[0];
  const withLineBody = renderHandoffParts({
    session,
    stage: 'closing',
    seq: 1,
    runSpend,
    intro: [formatFailurePathSummaryLine({ notes: ['Checked mcpState tri-state callers'] })],
  })[0];

  const parsedBase = parseRecord(baseBody);
  const parsedWithLine = parseRecord(withLineBody);
  assert.deepEqual(parsedWithLine.session, parsedBase.session);
});

test('L3: combineUnits preserves failurePathNote from partial-shard providers', () => {
  const first = {
    ok: true,
    provider: 'gemini',
    structured: {
      summary: 'Part 1',
      findings: [],
      coverage: { complete: false, reviewedPaths: ['a.js'], unreviewedPaths: ['b.js'], note: 'partial' },
      failurePathNote: 'Checked a.js mcpState',
    },
  };
  const second = {
    ok: true,
    provider: 'claude',
    structured: {
      summary: 'Part 2',
      findings: [],
      coverage: { complete: true, reviewedPaths: ['b.js'], unreviewedPaths: [], note: '' },
      failurePathNote: 'Checked b.js chmod guard',
    },
  };
  const combined = combineUnits(first, first.structured.coverage, second, ['gemini partial'], ['b.js']);
  assert.equal(combined.structured.failurePathNote, 'Checked a.js mcpState; Checked b.js chmod guard');
});

test('L3: multi-part runGeminiReview emits exactly one aggregated Failure-path checks line', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-multipart-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  const bigFile = (name) => [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -1,1 +1,1 @@',
    `+${'x'.repeat(28000)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'incremental' },
    requestedMode: 'auto',
    session: { version: 1, threadId: 't', status: 'OPEN', findings: [] },
  }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'T', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), bigFile('p1.js') + bigFile('p2.js'));
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({
    version: 1,
    stateIntegrity: false,
    failureRecovery: true,
    signals: { synchronization: [], durableState: [], multiActor: [], recovery: [], externalCall: [], faultInjection: [] },
  }));
  try {
    const res = await runGeminiReview({
      env: {
        REVIEW_PROVIDERS: 'mock-runner-provider',
        PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
        TARGET_REPO: 'test/repo',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        REVIEW_CONTEXT_DIR: ctxDir,
      },
      fetchImpl: null,
      logImpl: () => {},
    });
    const matches = res.summary.match(/Failure-path checks \(separate from file coverage; not a proof that every failure path is safe\):/g) ?? [];
    assert.equal(matches.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
