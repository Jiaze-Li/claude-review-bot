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
import { mergeShardResults, reconcileCoverage } from '../scripts/review-shards.mjs';
import {
  applyDiscoveryResult,
  completeDeepReview,
  planReviewSession,
  sessionCommitStatus,
  renderSessionComment,
  parseSessionComment,
  normalizeReviewResult,
  normalizeVerificationResult,
} from '../scripts/review-session-core.mjs';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('Golden Test A: Gemini succeeds without fallback', async () => {
  let geminiCalls = 0;
  let claudeCalls = 0;

  const outcome = await executeWorkUnit({
    unit: { files: ['src/index.js'], diff: 'diff --git a/src/index.js' },
    providers: ['gemini', 'claude'],
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return {
          ok: true,
          structured: { summary: 'Gemini review clean', findings: [] },
          meta: { resolved_model: 'gemini-flash-latest', num_turns: 1 },
        };
      },
      claude: async () => {
        claudeCalls += 1;
        return { ok: true, structured: { summary: 'Claude review', findings: [] } };
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'gemini');
  assert.equal(geminiCalls, 1);
  assert.equal(claudeCalls, 0);
  assert.equal(outcome.fallbackReason, null);
  assert.equal(outcome.structured.summary, 'Gemini review clean');
});

test('Golden Test B: Gemini 402/429/5xx triggers Claude fallback', async () => {
  for (const status of [402, 429, 503]) {
    let claudeCalled = false;
    const circuitBreaker = new CircuitBreaker();

    const outcome = await executeWorkUnit({
      unit: { files: ['src/app.js'], diff: 'diff --git a/src/app.js' },
      providers: ['gemini', 'claude'],
      geminiCircuitBreaker: circuitBreaker,
      executors: {
        gemini: async () => ({
          ok: false,
          kind: 'unavailable',
          status,
          error: `HTTP ${status} service unavailable`,
        }),
        claude: async ({ lastFailed }) => {
          claudeCalled = true;
          assert.equal(lastFailed.status, status);
          return {
            ok: true,
            structured: { summary: `Claude handled after ${status}`, findings: [] },
            meta: { total_cost_usd: 0.35, cost_source: 'sdk' },
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
    unit: { files: ['src/app.js'], diff: 'diff' },
    providers: ['claude'],
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        throw new Error('Gemini must not be called when Claude is explicitly requested');
      },
      claude: async () => {
        claudeCalls += 1;
        return {
          ok: true,
          structured: { summary: 'Claude direct', findings: [] },
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

  // Shard 1: failure 1
  await executeWorkUnit({
    unit: { diff: 'shard-1' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return { ok: false, kind: 'failed', error: 'transient error 1' };
      },
      claude: async () => ({ ok: true, structured: { summary: 'c1', findings: [] } }),
    },
  });
  assert.equal(geminiCalls, 1);
  assert.equal(circuitBreaker.isOff, false);

  // Shard 2: failure 2 -> trips circuit breaker
  await executeWorkUnit({
    unit: { diff: 'shard-2' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        return { ok: false, kind: 'failed', error: 'transient error 2' };
      },
      claude: async () => ({ ok: true, structured: { summary: 'c2', findings: [] } }),
    },
  });
  assert.equal(geminiCalls, 2);
  assert.equal(circuitBreaker.isOff, true);

  // Shard 3: Gemini skipped without invoking executor
  const outcome3 = await executeWorkUnit({
    unit: { diff: 'shard-3' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        throw new Error('Gemini executor should be bypassed');
      },
      claude: async () => ({ ok: true, structured: { summary: 'c3', findings: [] } }),
    },
  });
  assert.equal(geminiCalls, 2); // Still 2
  assert.equal(outcome3.provider, 'claude');
  assert.match(outcome3.fallbackReason, /transient error 2/);
});

test('Golden Test E: Concurrent Claude calls cannot overdraw budget', async () => {
  const MAX_BUDGET = 3.0;
  const budgetManager = new BudgetManager({
    minStartingAllowanceUsd: 0.5,
    getAvailableBudget: (pendingUsd) => MAX_BUDGET - pendingUsd,
    perCallCap: 1.0,
  });

  const deadlineTracker = new DeadlineTracker({ totalMs: 10, minBufferMs: 100 });
  const reservations = [];
  for (let i = 0; i < 5; i++) {
    const res = await budgetManager.acquireReservation({ deadlineTracker });
    if (res) reservations.push(res);
  }

  // Under $3.0 budget with $1.0 cap, exactly 3 reservations are acquired; 4th and 5th return null
  assert.equal(reservations.length, 3);
  const totalReserved = reservations.reduce((sum, r) => sum + r.cap, 0);
  assert.equal(totalReserved, 3.0);

  // Settle two reservations at $0.4 each
  budgetManager.settleReservation(reservations[0], { actualCostUsd: 0.4 });
  budgetManager.settleReservation(reservations[1], { actualCostUsd: 0.4 });

  // Settled = 0.8, Inflight = 1.0 (res 2). Pending = 1.8. Remaining = 1.2.
  const res4 = await budgetManager.acquireReservation({ deadlineTracker });
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
      claude: async ({ maxBudgetUsd }) => ({
        ok: true,
        structured: { summary: 'Claude ran but SDK gave no cost', findings: [] },
        meta: { total_cost_usd: null, cost_source: null },
      }),
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.totalCostUsd, 1.5);
  assert.equal(outcome.costSource, 'reserve');
  assert.equal(budgetManager.totalSpentUsd, 1.5);
});

test('Golden Test G: Full Review partial coverage stays PARTIAL', () => {
  const shardFiles = ['src/a.js', 'src/b.js'];
  const merged = mergeShardResults({
    shards: [{ files: shardFiles, diff: 'diff' }],
    results: [
      {
        ok: true,
        provider: 'gemini',
        structured: {
          summary: 'Incomplete shard review',
          findings: [],
          coverage: { complete: false, reviewedPaths: ['src/a.js'], unreviewedPaths: ['src/b.js'] },
        },
      },
    ],
    deferred: [],
    allFiles: shardFiles,
    priorReviewed: [],
    ignoredCount: 0,
  });

  assert.equal(merged.coverage.complete, false);
  assert.deepEqual(merged.coverage.reviewedPaths, ['src/a.js']);
  assert.deepEqual(merged.coverage.unreviewedPaths, ['src/b.js']);

  // Complete deep review with partial coverage
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'REVIEW_IN_PROGRESS',
    deepReview: { head: HEAD_A, resumeStatus: 'AUDIT_PENDING' },
    findings: [],
  };

  const updated = completeDeepReview({
    session,
    result: { summary: merged.summary, findings: merged.findings, coverage: merged.coverage },
    headSha: HEAD_A,
  });

  // Must transition to PARTIAL, never READY
  assert.equal(updated.status, 'PARTIAL');
  assert.notEqual(updated.status, 'READY');
});

test('Golden Test H: Remaining files are retried without duplicate review', async () => {
  const shardFiles = ['src/a.js', 'src/b.js'];
  const coverage1 = reconcileCoverage({ reviewedPaths: ['src/a.js'] }, shardFiles);
  assert.deepEqual(coverage1.unreviewedPaths, ['src/b.js']);

  let continuedUnitFiles = null;
  const outcome = await executeWorkUnit({
    unit: { files: shardFiles, diff: 'diff' },
    providers: ['gemini', 'claude'],
    executors: {
      gemini: async () => ({
        ok: true,
        structured: {
          summary: 'Gemini reviewed a.js only',
          findings: [],
          coverage: { complete: false, reviewedPaths: ['src/a.js'], unreviewedPaths: ['src/b.js'] },
        },
      }),
      claude: async ({ unit }) => ({
        ok: true,
        structured: {
          summary: 'Claude reviewed b.js',
          findings: [],
          coverage: { complete: true, reviewedPaths: ['src/b.js'], unreviewedPaths: [] },
        },
      }),
    },
    onPartialCoverage: async ({ result, unit, currentProvider, remainingProviders, notes }) => {
      const coverage = reconcileCoverage(result.structured.coverage, unit.files);
      if (coverage.unreviewedPaths.length && remainingProviders.length) {
        continuedUnitFiles = coverage.unreviewedPaths;
        const secondResult = await executeWorkUnit({
          unit: { files: continuedUnitFiles, diff: 'diff-rest' },
          providers: remainingProviders,
          executors: {
            claude: async () => ({
              ok: true,
              structured: {
                summary: 'Claude finished b.js',
                findings: [],
                coverage: { complete: true, reviewedPaths: ['src/b.js'], unreviewedPaths: [] },
              },
            }),
          },
        });
        const secondReviewed = secondResult.structured.coverage.reviewedPaths;
        return {
          ok: true,
          provider: `${result.provider}+${secondResult.provider}`,
          structured: {
            summary: `${result.structured.summary}\n${secondResult.structured.summary}`,
            findings: [],
            coverage: {
              complete: true,
              reviewedPaths: [...new Set([...coverage.reviewedPaths, ...secondReviewed])],
              unreviewedPaths: [],
            },
          },
        };
      }
      return null;
    },
  });

  assert.deepEqual(continuedUnitFiles, ['src/b.js']); // Handed ONLY remaining files
  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'gemini+claude');
  assert.deepEqual(outcome.structured.coverage.reviewedPaths, ['src/a.js', 'src/b.js']);
});

test('Golden Test I: Incremental does not become Full unexpectedly', () => {
  // A verified READY session on HEAD_A with completed audit
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'READY',
    auditCompleted: true,
    findings: [],
  };

  // When a new commit HEAD_B arrives, planReviewSession must propose incremental candidate
  const decision = planReviewSession({
    session,
    baseSha: BASE_SHA,
    headSha: HEAD_B,
  });

  assert.equal(decision.mode, 'incremental_candidate');
  assert.notEqual(decision.mode, 'full_review');
  assert.match(decision.reason, /classify new delta/);

  // Conversely, an explicit reset or PR change before final audit legitimately requires full review
  const resetDecision = planReviewSession({
    session,
    baseSha: BASE_SHA,
    headSha: HEAD_B,
    reset: true,
  });
  assert.equal(resetDecision.mode, 'full_review');
});

test('Golden Test J: Verification preserves FIXED/STILL_OPEN/UNCERTAIN', () => {
  const rawVerification = {
    summary: 'Verification round 1 complete',
    verifications: [
      {
        findingId: 'F001',
        status: 'FIXED',
        reason: 'Bug was properly resolved',
      },
      {
        findingId: 'F002',
        status: 'STILL_OPEN',
        reason: 'Issue persists in edge cases',
      },
      {
        findingId: 'F003',
        status: 'UNCERTAIN',
        reason: 'Insufficient evidence to verify',
      },
    ],
    findings: [],
  };

  const normalized = normalizeVerificationResult(rawVerification);
  assert.equal(normalized.verifications.length, 3);
  assert.equal(normalized.verifications[0].status, 'FIXED');
  assert.equal(normalized.verifications[1].status, 'STILL_OPEN');
  assert.equal(normalized.verifications[2].status, 'UNCERTAIN');
});

test('Golden Test K: Budget or deadline exhaustion fails closed', async () => {
  // 1. Budget exhaustion fails closed
  const budgetManager = new BudgetManager({
    minStartingAllowanceUsd: 0.5,
    getAvailableBudget: () => 0.1, // Exhausted
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

  // 2. Deadline exhaustion fails closed in worker pool
  const deadlineTracker = new DeadlineTracker({ totalMs: 50, minBufferMs: 100 });
  let stoppedIndex = null;
  const poolResults = await runBoundedPool({
    items: ['shard-1', 'shard-2', 'shard-3'],
    concurrency: 2,
    deadlineTracker,
    minTimeBufferMs: 60,
    workerFn: async (item) => ({ ok: true, item }),
    onStop: (nextIndex) => { stoppedIndex = nextIndex; },
  });

  assert.equal(stoppedIndex, 0);
  assert.equal(poolResults.filter(Boolean).length, 0); // No shard fabricated
});

test('Golden Test L: Failed requests never fabricate READY', () => {
  const failedOutcome = normalizeProviderOutcome({
    ok: false,
    provider: null,
    error: 'All review shards timed out',
    status: 'failed',
  });

  assert.equal(failedOutcome.ok, false);
  assert.equal(failedOutcome.structured, null);
  assert.equal(failedOutcome.status, 'failed');
  assert.notEqual(failedOutcome.status, 'READY');

  // Evaluated against durable commit status
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'HUMAN_REQUIRED',
    findings: [],
  };

  const commitStatus = sessionCommitStatus(session, HEAD_A);
  assert.notEqual(commitStatus.state, 'success');
  assert.equal(commitStatus.state, 'error');
  assert.match(commitStatus.description, /human judgment required/);
});

test('Golden Test M: Existing Session and output schemas are unchanged', () => {
  const reviewResult = {
    summary: 'Discovery review summary',
    findings: [
      {
        title: 'Potential SQL injection',
        path: 'src/db.js',
        line: 100,
        severity: 'P1',
        body: 'Unsanitized user input in query',
        riskClass: 'security',
        failurePath: 'POST /api/user with unsanitized parameters -> concatenated directly into database query',
      },
    ],
  };

  const session = applyDiscoveryResult({
    result: reviewResult,
    baseSha: BASE_SHA,
    headSha: HEAD_A,
    sourceCommentId: '1234567890123',
  });

  // Verify Session Schema Invariants
  assert.equal(session.version, 1);
  assert.equal(session.baseSha, BASE_SHA);
  assert.equal(session.lastReviewedHead, HEAD_A);
  assert.equal(session.status, 'REWORK');
  assert.equal(session.findings.length, 1);
  assert.equal(session.findings[0].id, 'F001');
  assert.equal(session.findings[0].status, 'OPEN');

  // Verify Render/Parse Round-trip
  const comment = renderSessionComment(session);
  assert.match(comment, /<!-- jiaze-review-session:v1/);
  const parsed = parseSessionComment(comment);
  assert.equal(parsed.sessionId, session.sessionId);
  assert.equal(parsed.status, 'REWORK');
  assert.equal(parsed.findings.length, 1);
});

test('Golden Test N: Re-running an already-reviewed HEAD does not duplicate model spend or publication', () => {
  const readySession = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'READY',
    auditCompleted: true,
    findings: [],
  };

  // 1. Planning on same HEAD produces noop_ready without model execution
  const decision = planReviewSession({
    session: readySession,
    baseSha: BASE_SHA,
    headSha: HEAD_A,
  });

  assert.equal(decision.mode, 'noop_ready');
  assert.match(decision.reason, /already READY/);

  // 2. Commit status is immediately success without triggering runners
  const status = sessionCommitStatus(readySession, HEAD_A);
  assert.equal(status.state, 'success');
  assert.match(status.description, /READY/);
});
