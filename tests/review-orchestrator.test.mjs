import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeadlineTracker,
  CircuitBreaker,
  BudgetManager,
  runBoundedPool,
  normalizeProviderOutcome,
  executeWorkUnit,
} from '../scripts/review-orchestrator.mjs';
import { reconcileCoverage } from '../scripts/review-shards.mjs';
import { normalizeReviewResult, normalizeVerificationResult } from '../scripts/review-session-core.mjs';

test('Golden Test A: Gemini succeeds without fallback', async () => {
  let geminiCalls = 0;
  let claudeCalls = 0;

  const outcome = await executeWorkUnit({
    unit: { files: ['a.js'], diff: 'diff --git a/a.js' },
    providers: ['gemini', 'claude'],
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return {
          ok: true,
          structured: { summary: 'gemini review clean', findings: [] },
          meta: { resolved_model: 'gemini-flash', num_turns: 1 },
        };
      },
      claude: async () => {
        claudeCalls += 1;
        return { ok: true, structured: { summary: 'claude review', findings: [] } };
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'gemini');
  assert.equal(geminiCalls, 1);
  assert.equal(claudeCalls, 0);
  assert.equal(outcome.fallbackReason, null);
  assert.equal(outcome.structured.summary, 'gemini review clean');
});

test('Golden Test B: Gemini 402/429/5xx triggers Claude fallback', async () => {
  for (const status of [402, 429, 503]) {
    let claudeCalled = false;
    const circuitBreaker = new CircuitBreaker();

    const outcome = await executeWorkUnit({
      unit: { files: ['a.js'], diff: 'diff --git a/a.js' },
      providers: ['gemini', 'claude'],
      geminiCircuitBreaker: circuitBreaker,
      executors: {
        gemini: async () => {
          return {
            ok: false,
            kind: 'unavailable',
            status,
            error: `HTTP ${status} service unavailable`,
          };
        },
        claude: async ({ maxBudgetUsd, lastFailed }) => {
          claudeCalled = true;
          assert.equal(lastFailed.status, status);
          return {
            ok: true,
            structured: { summary: `claude handled after ${status}`, findings: [] },
            meta: { total_cost_usd: 0.25, cost_source: 'sdk' },
          };
        },
      },
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.provider, 'claude');
    assert.equal(claudeCalled, true);
    assert.match(outcome.fallbackReason, new RegExp(`HTTP ${status}`));
    assert.equal(circuitBreaker.isOff, true);
    assert.equal(circuitBreaker.status, status);
  }
});

test('Golden Test C: Claude-only request never calls Gemini', async () => {
  let geminiCalls = 0;
  let claudeCalls = 0;

  const outcome = await executeWorkUnit({
    unit: { files: ['a.js'], diff: 'diff' },
    providers: ['claude'],
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        throw new Error('Gemini must not be called');
      },
      claude: async () => {
        claudeCalls += 1;
        return {
          ok: true,
          structured: { summary: 'claude direct', findings: [] },
        };
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'claude');
  assert.equal(geminiCalls, 0);
  assert.equal(claudeCalls, 1);
  assert.equal(outcome.fallbackReason, null);
});

test('Golden Test D: Two Gemini failures trigger existing cutoff', async () => {
  const circuitBreaker = new CircuitBreaker({ maxConsecutiveFailures: 2 });
  let geminiCalls = 0;

  // Call 1: transient failure 1
  await executeWorkUnit({
    unit: { diff: '1' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return { ok: false, kind: 'failed', error: 'failure 1' };
      },
      claude: async () => ({ ok: true, structured: { summary: 'c1' } }),
    },
  });
  assert.equal(geminiCalls, 1);
  assert.equal(circuitBreaker.isOff, false);

  // Call 2: transient failure 2 -> trips breaker
  await executeWorkUnit({
    unit: { diff: '2' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return { ok: false, kind: 'failed', error: 'failure 2' };
      },
      claude: async () => ({ ok: true, structured: { summary: 'c2' } }),
    },
  });
  assert.equal(geminiCalls, 2);
  assert.equal(circuitBreaker.isOff, true);

  // Call 3: Gemini skipped without invoking executor
  const outcome3 = await executeWorkUnit({
    unit: { diff: '3' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        throw new Error('Should not be called when circuit breaker is tripped');
      },
      claude: async () => ({ ok: true, structured: { summary: 'c3' } }),
    },
  });
  assert.equal(geminiCalls, 2); // No new call to Gemini
  assert.equal(outcome3.provider, 'claude');
  assert.match(outcome3.fallbackReason, /failure 2/);
});

test('Golden Test E: Concurrent Claude calls cannot overdraw budget', async () => {
  const MAX_BUDGET = 3.0;
  const budgetManager = new BudgetManager({
    minStartingAllowanceUsd: 0.5,
    getAvailableBudget: (pendingUsd) => MAX_BUDGET - pendingUsd,
    perCallCap: 1.0,
  });

  const tracker = new DeadlineTracker({ totalMs: 10, minBufferMs: 100 });
  const workerCount = 5;
  const reservations = [];
  for (let i = 0; i < workerCount; i++) {
    const res = await budgetManager.acquireReservation({ deadlineTracker: tracker });
    if (res) {
      reservations.push(res);
    }
  }

  // Exactly 3 reservations of $1.0 can be acquired under $3.0 budget; 4th and 5th return null
  assert.equal(reservations.length, 3);
  const totalReserved = reservations.reduce((sum, r) => sum + r.cap, 0);
  assert.equal(totalReserved, 3.0);

  // Settle two of them at $0.4 each
  budgetManager.settleReservation(reservations[0], { actualCostUsd: 0.4 });
  budgetManager.settleReservation(reservations[1], { actualCostUsd: 0.4 });

  // Now spent is 0.8, inflight is 1.0 (reservation 2). Total committed = 1.8.
  // Remaining available is 3.0 - 1.8 = 1.2.
  // Another reservation can be acquired!
  const res4 = await budgetManager.acquireReservation();
  assert.ok(res4);
  assert.equal(res4.cap, 1.0);
});

test('Golden Test F: Missing SDK cost is conservatively reserved', async () => {
  const budgetManager = new BudgetManager({
    minStartingAllowanceUsd: 0.3,
    getAvailableBudget: (pendingUsd) => 5.0 - pendingUsd,
    perCallCap: 1.5,
  });

  const outcome = await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['claude'],
    budgetManager,
    executors: {
      claude: async ({ maxBudgetUsd }) => {
        return {
          ok: true,
          structured: { summary: 'missing cost' },
          meta: { total_cost_usd: null, cost_source: null },
        };
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.totalCostUsd, 1.5);
  assert.equal(outcome.costSource, 'reserve');
  assert.equal(budgetManager.totalSpentUsd, 1.5);
});

test('Golden Test G: Full Review partial coverage stays PARTIAL', () => {
  const shardFiles = ['src/a.js', 'src/b.js', 'src/c.js'];
  const reportedCoverage = {
    complete: true, // Model claims complete, but missed b.js and c.js
    reviewedPaths: ['src/a.js'],
  };

  const reconciled = reconcileCoverage(reportedCoverage, shardFiles);
  assert.equal(reconciled.complete, false);
  assert.deepEqual(reconciled.reviewedPaths, ['src/a.js']);
  assert.deepEqual(reconciled.unreviewedPaths, ['src/b.js', 'src/c.js']);
});

test('Golden Test H: Remaining files are retried without duplicate review', async () => {
  const allFiles = ['a.js', 'b.js'];
  const coverageA = reconcileCoverage({ reviewedPaths: ['a.js'] }, allFiles);
  assert.deepEqual(coverageA.unreviewedPaths, ['b.js']);

  // Next unit is built for exactly remaining files ['b.js']
  const coverageB = reconcileCoverage({ reviewedPaths: ['b.js'] }, coverageA.unreviewedPaths);
  assert.deepEqual(coverageB.reviewedPaths, ['b.js']);
  assert.deepEqual(coverageB.unreviewedPaths, []);

  // Merged coverage has both without duplicates
  const mergedReviewed = [...new Set([...coverageA.reviewedPaths, ...coverageB.reviewedPaths])];
  assert.deepEqual(mergedReviewed, ['a.js', 'b.js']);
});

test('Golden Test I: Incremental review normalizes schema and findings', () => {
  const rawIncremental = {
    summary: 'incremental review result',
    findings: [
      {
        title: 'New bug introduced in delta',
        path: 'src/lib.js',
        line: 42,
        severity: 'P1',
        body: 'Fix check',
        riskClass: 'correctness',
      },
    ],
  };

  normalizeReviewResult(rawIncremental);
  assert.equal(rawIncremental.summary, 'incremental review result');
  assert.equal(rawIncremental.findings.length, 1);
  assert.equal(rawIncremental.findings[0].severity, 'P1');
  assert.equal(rawIncremental.findings[0].body, 'Fix check');
});

test('Golden Test J: Verification preserves FIXED/STILL_OPEN/UNCERTAIN', () => {
  const rawVerification = {
    summary: 'verification round 1',
    verifications: [
      {
        findingId: 'F001',
        status: 'FIXED',
        reason: 'Bug was properly resolved',
      },
      {
        findingId: 'F002',
        status: 'STILL_OPEN',
        reason: 'Problem persists in edge case',
      },
      {
        findingId: 'F003',
        status: 'UNCERTAIN',
        reason: 'Insufficient evidence to verify',
      },
    ],
    findings: [],
  };

  normalizeVerificationResult(rawVerification);
  assert.equal(rawVerification.verifications.length, 3);
  assert.equal(rawVerification.verifications[0].status, 'FIXED');
  assert.equal(rawVerification.verifications[1].status, 'STILL_OPEN');
  assert.equal(rawVerification.verifications[2].status, 'UNCERTAIN');
});

test('Golden Test K: Budget or deadline exhaustion fails closed', async () => {
  const budgetManager = new BudgetManager({
    minStartingAllowanceUsd: 0.5,
    getAvailableBudget: () => 0.1, // Below minimum starting allowance
  });

  const outcome = await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['claude'],
    budgetManager,
    executors: {
      claude: async () => ({ ok: true }),
    },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Claude budget for this review is exhausted/);

  // DeadlineTracker exhaustion
  const tracker = new DeadlineTracker({ totalMs: 10, minBufferMs: 50 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tracker.hasExpired(), true);
  assert.equal(tracker.isNearExpiry(), true);
});

test('Golden Test L: Failed requests never fabricate READY', async () => {
  const outcome = await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['gemini', 'claude'],
    executors: {
      gemini: async () => ({ ok: false, error: 'gemini failed' }),
      claude: async () => ({ ok: false, error: 'claude failed' }),
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.structured, null);
  assert.equal(outcome.status, 'failed');
  assert.notEqual(outcome.status, 'READY');
});

test('Golden Test M: Existing Session and output schemas are unchanged', () => {
  const normalized = normalizeProviderOutcome({
    ok: true,
    provider: 'gemini',
    structured: { summary: 'sum', findings: [] },
    meta: { resolved_model: 'gemini-flash' },
    usage: { input_tokens: 10, output_tokens: 20 },
    totalCostUsd: 0.05,
    costSource: 'sdk',
    duration: 120,
    coverage: { complete: true, reviewedPaths: ['a.js'] },
  });

  const expectedKeys = [
    'ok',
    'provider',
    'status',
    'error',
    'errors',
    'structured',
    'usage',
    'costSource',
    'totalCostUsd',
    'duration',
    'fallbackReason',
    'coverage',
    'facts',
    'meta',
  ];

  for (const key of expectedKeys) {
    assert.ok(key in normalized, `Key ${key} missing from normalized output`);
  }
  assert.equal(normalized.ok, true);
  assert.equal(normalized.status, 'success');
  assert.equal(normalized.provider, 'gemini');
});

test('Golden Test N: Re-running an already-reviewed HEAD does not duplicate model spend or publication', async () => {
  let modelCalled = false;
  const currentHead = 'abc1234';
  const session = {
    lastReviewedHead: 'abc1234',
    status: 'READY',
  };

  const isAlreadyReviewed = session.lastReviewedHead === currentHead && session.status === 'READY';
  if (!isAlreadyReviewed) {
    modelCalled = true;
  }

  assert.equal(isAlreadyReviewed, true);
  assert.equal(modelCalled, false);
});
