import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DeadlineTracker,
  CircuitBreaker,
  BudgetManager,
  runBoundedPool,
  normalizeProviderOutcome,
  executeWorkUnit,
} from '../scripts/review-orchestrator.mjs';
import { ProviderRegistry, ProviderAdapter } from '../scripts/provider-adapter.mjs';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
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

// ---- Test Helpers for runGeminiReview ----

function setupGeminiContext({ mode = 'incremental', diff = null, session = null, requestedMode = 'auto' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-review-test-'));
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ number: 1, title: 'PR 1' }));
  const sampleDiff = diff ?? 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n+console.log("hello");\n';
  fs.writeFileSync(path.join(dir, 'repair.diff'), sampleDiff);
  fs.writeFileSync(path.join(dir, 'pr.diff'), sampleDiff);
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode },
    session,
    requestedMode,
  }));
  return dir;
}

function makeEnv(dir, extra = {}) {
  return {
    GEMINI_API_KEY: 'mock-gemini-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'mock-claude-token',
    TARGET_REPO: 'owner/repo',
    PR_NUMBER: '1',
    HEAD_SHA: HEAD_A,
    REVIEW_CONTEXT_DIR: dir,
    SOURCE_KIND: 'comment',
    ...extra,
  };
}

function mockGeminiReply(reply) {
  return async (url, init) => {
    if (reply?.status) {
      return new Response(JSON.stringify({ error: { message: `HTTP ${reply.status}` } }), { status: reply.status });
    }
    return Response.json({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(reply) }],
        },
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      modelVersion: 'gemini-flash-latest',
    });
  };
}

function mockClaudeQuery(reply, { cost = 0.25 } = {}) {
  return async function* (args) {
    yield { type: 'system', subtype: 'init', model: 'claude-3-7-sonnet' };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: cost,
      structured_output: reply,
      usage: { input_tokens: 200, output_tokens: 100 },
    };
  };
}

// ---- Test Helpers for run-review.mjs (Full Review) ----

const FAKE_AGENT_SDK = `
import fs from 'node:fs';
let call = 0;
export async function* query({ prompt, options }) {
  call += 1;
  const myCall = call;
  const mode = process.env.FAKE_MODE || 'ok';
  let files = [...prompt.matchAll(/^- (\\S+)$/gm)].map((m) => m[1]).filter((f) => !f.endsWith('.txt') && !f.endsWith('.diff') && !f.endsWith('.json'));
  if (!files.length) files = fs.readFileSync('.review-context/changed-files.txt', 'utf8').split('\\n').filter(Boolean);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ call: myCall, files, budget: options.maxBudgetUsd }) + '\\n');
  yield { type: 'system', subtype: 'init', model: 'claude-fake' };
  if (mode === 'second-fails' && myCall === 2) {
    yield { type: 'result', subtype: 'error_max_turns', num_turns: options.maxTurns, total_cost_usd: 0.4, errors: ['turn limit'] };
    return;
  }
  if (mode === 'one-at-a-time') {
    const credited = files.slice(0, 1);
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.2,
      structured_output: {
        summary: 'partial pass ' + myCall,
        findings: [],
        coverage: { complete: credited.length === files.length, reviewedPaths: credited, unreviewedPaths: files.filter((f) => !credited.includes(f)), note: '' },
      },
    };
    return;
  }
  yield {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.2,
    structured_output: {
      summary: 'shard ' + myCall + ' ok',
      findings: [],
      coverage: { complete: true, reviewedPaths: files, unreviewedPaths: [], note: '' },
    },
  };
}
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
export function createSdkMcpServer({ name, tools }) {
  return { type: 'sdk', name, instance: { _registeredTools: Object.fromEntries((tools || []).map((t) => [t.name, t])) } };
}
`;

function setupFullReviewContext(fileSizes, session = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-test-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of fs.readdirSync(new URL('../scripts', import.meta.url))) {
    if (f.endsWith('.mjs')) fs.copyFileSync(new URL(`../scripts/${f}`, import.meta.url), path.join(root, 'scripts', f));
  }
  const sdk = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), FAKE_AGENT_SDK);
  const zodDir = fs.realpathSync.native(new URL('../node_modules/zod', import.meta.url));
  fs.symlinkSync(zodDir, path.join(root, 'node_modules/zod'), 'junction');
  fs.mkdirSync(path.join(root, 'safe-target'));
  fs.mkdirSync(path.join(root, '.review-context'));
  if (session) fs.writeFileSync(path.join(root, '.review-context/session-plan.json'), JSON.stringify({ session }));
  const names = Object.keys(fileSizes);
  fs.writeFileSync(path.join(root, '.review-context/changed-files.txt'), names.join('\n') + '\n');
  fs.writeFileSync(path.join(root, '.review-context/pr.diff'), names.map((n) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1 +1 @@\n+${'x'.repeat(fileSizes[n])}\n`).join(''));
  return root;
}

function runFullReview(root, mode = 'ok') {
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  const result = spawnSync(process.execPath, ['scripts/run-review.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TARGET_REPO: 'owner/repo',
      PR_NUMBER: '1',
      HEAD_SHA: HEAD_A,
      DEEP_REVIEW_MAX_BUDGET_USD: '5',
      FAKE_MODE: mode,
      FAKE_LOG: log,
      PROVIDERS: 'claude',
    },
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const outPath = path.join(root, '.review-context/review.json');
  return {
    status: result.status,
    calls,
    review: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null,
  };
}

// =========================================================================
// Golden Tests A through N (exercising production runners and orchestrator)
// =========================================================================

test('Golden Test A: Gemini succeeds without fallback via runGeminiReview', async () => {
  const dir = setupGeminiContext({ mode: 'incremental' });
  let claudeCalled = false;

  const result = await runGeminiReview({
    env: makeEnv(dir),
    logImpl: () => {},
    fetchImpl: mockGeminiReply({ summary: 'Gemini clean review', findings: [] }),
    queryImpl: async function* () { claudeCalled = true; },
  });

  assert.equal(result._meta.provider, 'gemini');
  assert.equal(claudeCalled, false);
  assert.equal(result._meta.fallback_from, undefined);
  assert.match(result.summary, /Gemini clean review/);
});

test('Golden Test B: Gemini 402/429/5xx triggers Claude fallback via runGeminiReview', async () => {
  for (const status of [402, 429, 503]) {
    const dir = setupGeminiContext({ mode: 'incremental' });
    let claudeCalled = false;

    const result = await runGeminiReview({
      env: makeEnv(dir),
      logImpl: () => {},
      fetchImpl: mockGeminiReply({ status }),
      queryImpl: mockClaudeQuery({ summary: `Claude fallback after ${status}`, findings: [] }),
    });

    assert.equal(result._meta.provider, 'claude');
    assert.equal(result._meta.fallback_from, 'gemini');
    assert.match(result._meta.fallback_reason, new RegExp(`HTTP ${status}`));
    assert.match(result.summary, new RegExp(`Claude fallback after ${status}`));
  }
});

test('Golden Test C: Claude-only request never calls Gemini via runGeminiReview', async () => {
  const dir = setupGeminiContext({ mode: 'incremental', requestedMode: 'claude' });
  let geminiCalled = false;

  const result = await runGeminiReview({
    env: makeEnv(dir),
    logImpl: () => {},
    fetchImpl: async () => {
      geminiCalled = true;
      throw new Error('Gemini must not be called when Claude is requested');
    },
    queryImpl: mockClaudeQuery({ summary: 'Claude direct request', findings: [] }),
  });

  assert.equal(geminiCalled, false);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.fallback_from, undefined);
  assert.match(result.summary, /Claude direct request/);
});

test('Golden Test D: Two Gemini failures trigger existing cutoff', async () => {
  const circuitBreaker = new CircuitBreaker({ maxConsecutiveFailures: 2 });
  let geminiCalls = 0;

  // Failure 1: increments failure count, breaker stays on
  circuitBreaker.recordFailure('HTTP 500 server error', 500);
  assert.equal(circuitBreaker.isOff, false);

  // Success in between does not reset cumulative failure count
  circuitBreaker.recordSuccess();

  // Failure 2: trips circuit breaker
  circuitBreaker.recordFailure('HTTP 500 server error', 500);
  assert.equal(circuitBreaker.isOff, true);

  // Subsequent call through executeWorkUnit skips Gemini
  const outcome = await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['gemini', 'claude'],
    geminiCircuitBreaker: circuitBreaker,
    budgetManager: new BudgetManager({ minStartingAllowanceUsd: 1.0, getAvailableBudget: () => 5.0, perCallCap: 1.0 }),
    executors: {
      gemini: async () => {
        geminiCalls += 1;
        throw new Error('Gemini should be skipped');
      },
      claude: async () => ({
        ok: true,
        structured: { summary: 'Claude took over after cutoff', findings: [] },
      }),
    },
  });

  assert.equal(geminiCalls, 0);
  assert.equal(outcome.provider, 'claude');
  assert.match(outcome.fallbackReason, /500/);
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

  // Exactly 3 reservations of $1.0 acquired under $3.0 budget; 4th and 5th return null
  assert.equal(reservations.length, 3);
  assert.equal(budgetManager.totalPendingUsd, 3.0);

  // Settle two reservations at $0.4 each
  budgetManager.settleReservation(reservations[0], { actualCostUsd: 0.4 });
  budgetManager.settleReservation(reservations[1], { actualCostUsd: 0.4 });

  // Settled = 0.8, Inflight = 1.0. Pending = 1.8. Remaining = 1.2.
  const res4 = await budgetManager.acquireReservation({ deadlineTracker });
  assert.ok(res4);
  assert.equal(res4.cap, 1.0);
});

test('Golden Test F: Missing SDK cost is conservatively reserved via runGeminiReview', async () => {
  const dir = setupGeminiContext({ mode: 'incremental' });

  const result = await runGeminiReview({
    env: makeEnv(dir),
    logImpl: () => {},
    fetchImpl: mockGeminiReply({ status: 503 }),
    queryImpl: mockClaudeQuery({ summary: 'No SDK cost', findings: [] }, { cost: null }),
  });

  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.total_cost_usd, 0.5); // Reserved allowance cap charged conservatively
  assert.equal(result._meta.cost_source, 'reserve');
});

test('Golden Test G: Full Review partial coverage stays PARTIAL via run-review.mjs and completeDeepReview', () => {
  const root = setupFullReviewContext({ 'src/a.js': 100_000, 'src/b.js': 100_000, 'src/c.js': 100_000 });
  const { status, review } = runFullReview(root, 'second-fails');

  assert.equal(status, 0);
  assert.equal(review.coverage.complete, false);
  assert.ok(review.coverage.unreviewedPaths.length > 0);

  // Complete deep review with partial coverage outcome
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
    result: { summary: review.summary, findings: review.findings, coverage: review.coverage },
    headSha: HEAD_A,
  });

  assert.equal(updated.status, 'PARTIAL');
  assert.notEqual(updated.status, 'READY');
});

test('Golden Test H: Remaining files are retried without duplicate review via run-review.mjs', () => {
  const root = setupFullReviewContext({ 'src/first.js': 500, 'src/second.js': 500 });
  const { status, calls, review } = runFullReview(root, 'one-at-a-time');

  assert.equal(status, 0);
  assert.ok(calls.length >= 2, `Expected >= 2 calls, got ${calls.length}`);
  // First call is given both files in shard
  assert.equal(calls[0].files.length, 2);
  // Second continuation call is assigned ONLY the remaining unreviewed file
  assert.equal(calls[1].files.length, 1);
  // Total review combines both without duplicating
  assert.deepEqual(review.coverage.reviewedPaths.sort(), ['src/first.js', 'src/second.js']);
  assert.equal(review.coverage.complete, true);
});

test('Golden Test I: Incremental does not become Full unexpectedly via planReviewSession & runGeminiReview', async () => {
  // 1. Session planning verifies incremental_candidate
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'READY',
    auditCompleted: true,
    findings: [],
  };

  const decision = planReviewSession({
    session,
    baseSha: BASE_SHA,
    headSha: HEAD_B,
  });
  assert.equal(decision.mode, 'incremental_candidate');
  assert.notEqual(decision.mode, 'full_review');

  // 2. runGeminiReview executes the incremental mode without escalating
  const dir = setupGeminiContext({ mode: 'incremental', session });
  const result = await runGeminiReview({
    env: makeEnv(dir, { HEAD_SHA: HEAD_B }),
    logImpl: () => {},
    fetchImpl: mockGeminiReply({ summary: 'Incremental delta clean', findings: [] }),
  });

  assert.equal(result._meta.mode, 'incremental');
  assert.match(result.summary, /Incremental delta clean/);
});

test('Golden Test J: Verification preserves FIXED/STILL_OPEN/UNCERTAIN via runGeminiReview', async () => {
  const validSession = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'REWORK',
    findings: [{ id: 'F001', title: 'Open bug', path: 'src/app.js', severity: 'P1', status: 'OPEN', body: 'b' }],
  };
  const dir = setupGeminiContext({ mode: 'verification', session: validSession });

  const verificationPayload = {
    summary: 'Verification round 1 complete',
    verifications: [
      { findingId: 'F001', status: 'FIXED', reason: 'Properly patched' },
      { findingId: 'F002', status: 'STILL_OPEN', reason: 'Still reproducible in tests' },
      { findingId: 'F003', status: 'UNCERTAIN', reason: 'Insufficient assertions' },
    ],
    findings: [],
  };

  const result = await runGeminiReview({
    env: makeEnv(dir),
    logImpl: () => {},
    fetchImpl: mockGeminiReply(verificationPayload),
  });

  assert.equal(result._meta.mode, 'verification');
  assert.equal(result.verifications.length, 3);
  assert.equal(result.verifications[0].status, 'FIXED');
  assert.equal(result.verifications[1].status, 'STILL_OPEN');
  assert.equal(result.verifications[2].status, 'UNCERTAIN');
});

test('Golden Test K: Budget or deadline exhaustion fails closed via runGeminiReview', async () => {
  // 1. DeadlineTracker with bufferMs=0 trips when expired
  let fakeNow = 1000;
  const tracker = new DeadlineTracker({ totalMs: 500, minBufferMs: 0, nowFn: () => fakeNow });
  assert.equal(tracker.isNearExpiry(0), false);
  fakeNow = 1500; // Exact deadline
  assert.equal(tracker.isNearExpiry(0), true);
  fakeNow = 1600; // Past deadline
  assert.equal(tracker.isNearExpiry(0), true);

  // 2. executeWorkUnit without defaultTimeoutMs preserves available deadline tracker time (not capped to 180s)
  let receivedTimeout = null;
  const longTracker = new DeadlineTracker({ totalMs: 1_000_000, nowFn: () => 0 });
  await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['claude'],
    budgetManager: new BudgetManager({ minStartingAllowanceUsd: 1.0, getAvailableBudget: () => 5.0, perCallCap: 1.0 }),
    deadlineTracker: longTracker,
    executors: {
      claude: async ({ timeoutMs }) => {
        receivedTimeout = timeoutMs;
        return { ok: true, structured: { summary: 'ok', findings: [] } };
      },
    },
  });
  assert.equal(receivedTimeout, 970_000); // 1_000_000 - 30_000, not clamped to 180_000

  // 3. Budget exhaustion fails closed
  const exhaustedSession = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'REWORK',
    deepSpendUsd: 6.0,
    fallbackSpendUsd: 6.0,
    findings: [],
  };
  const dir = setupGeminiContext({ mode: 'incremental', session: exhaustedSession });
  const stopMarkerPath = path.join(dir, 'fallback-unavailable.json');

  // Exhausted Claude fallback budget throws and writes fallback-unavailable.json
  await assert.rejects(
    runGeminiReview({
      env: makeEnv(dir, {
        CLAUDE_CODE_OAUTH_TOKEN: 'token',
        SOURCE_KIND: 'pull_request', // Non-manual cannot exceed budget
      }),
      logImpl: () => {},
      fetchImpl: mockGeminiReply({ status: 503 }),
      queryImpl: mockClaudeQuery({ summary: 'ok', findings: [] }),
    }),
    /Claude fallback/
  );

  assert.ok(fs.existsSync(stopMarkerPath));
  const marker = JSON.parse(fs.readFileSync(stopMarkerPath, 'utf8'));
  assert.equal(marker.headSha, HEAD_A);
  assert.match(marker.reason, /Claude budget exhausted/);
});

test('Golden Test L: Failed requests never fabricate READY via sessionCommitStatus', async () => {
  const dir = setupGeminiContext({ mode: 'incremental' });

  // Failed runner request must reject rather than fabricate a successful/READY review
  await assert.rejects(
    runGeminiReview({
      env: makeEnv(dir, { CLAUDE_CODE_OAUTH_TOKEN: '' }), // Missing Claude credential
      logImpl: () => {},
      fetchImpl: mockGeminiReply({ status: 503 }),
    }),
    /CLAUDE_CODE_OAUTH_TOKEN/
  );

  // Failed state evaluated against commit status
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: HEAD_A,
    status: 'HUMAN_REQUIRED',
    findings: [],
  };

  const status = sessionCommitStatus(session, HEAD_A);
  assert.notEqual(status.state, 'success');
  assert.equal(status.state, 'error');
  assert.match(status.description, /human judgment required/);
});

test('Golden Test M: Existing Session and output schemas are unchanged via applyDiscoveryResult and renderSessionComment', () => {
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

  // Verify Schema Keys and Invariants
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

test('Generic provider cascade: executeWorkUnit executes arbitrary providers and routes fallbacks by normalized error types', async () => {
  const customRegistry = new ProviderRegistry();
  customRegistry.register('provider-alpha', class Alpha extends ProviderAdapter {
    constructor(o) { super({ provider: 'provider-alpha', descriptor: o.descriptor }); }
  }, {
    policy: { budgetType: 'none', defaultTimeoutMs: 5000 },
    capabilities: { tools: true, structuredOutput: true },
  });
  customRegistry.register('provider-beta', class Beta extends ProviderAdapter {
    constructor(o) { super({ provider: 'provider-beta', descriptor: o.descriptor }); }
  }, {
    policy: { budgetType: 'usd-ledger', defaultTimeoutMs: 10000 },
    capabilities: { tools: false, structuredOutput: true },
  });

  const executed = [];
  const betaBudgetMgr = new BudgetManager({
    minStartingAllowanceUsd: 1.0,
    getAvailableBudget: () => 5.0,
    perCallCap: 2.0,
  });

  // Alpha fails with unavailable -> cascades to Beta
  const outcome = await executeWorkUnit({
    unit: { diff: 'alpha-to-beta' },
    providers: ['provider-alpha', 'provider-beta'],
    providerRegistry: customRegistry,
    budgetManagers: {
      'provider-beta': betaBudgetMgr,
    },
    executors: {
      'provider-alpha': async ({ unit, timeoutMs }) => {
        executed.push({ provider: 'provider-alpha', timeoutMs });
        return { ok: false, kind: 'unavailable', error: 'HTTP 429 rate limit', status: 429 };
      },
      'provider-beta': async ({ unit, timeoutMs, maxBudgetUsd, reservation }) => {
        executed.push({ provider: 'provider-beta', timeoutMs, maxBudgetUsd, hasReservation: Boolean(reservation) });
        return {
          ok: true,
          structured: { summary: 'Beta review succeeded after Alpha rate limit', findings: [] },
          totalCostUsd: 0.75,
        };
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'provider-beta');
  assert.equal(outcome.structured.summary, 'Beta review succeeded after Alpha rate limit');
  assert.equal(outcome.totalCostUsd, 0.75);
  assert.match(outcome.fellBackFrom, /provider-alpha: HTTP 429 rate limit/);
  assert.equal(executed.length, 2);
  assert.equal(executed[0].provider, 'provider-alpha');
  assert.equal(executed[1].provider, 'provider-beta');
  assert.equal(executed[1].hasReservation, true);
  assert.equal(executed[1].maxBudgetUsd, 2.0);
});

test('Explicit budget enforcement: usd-ledger provider without budget configuration fails closed', async () => {
  let invoked = false;
  const outcome = await executeWorkUnit({
    unit: { diff: 'diff' },
    providers: ['claude'],
    // Note: no budgetManager or budgetManagers provided!
    executors: {
      claude: async () => {
        invoked = true;
        return { ok: true, structured: { summary: 'Should not run', findings: [] } };
      },
    },
  });

  assert.equal(invoked, false, 'usd-ledger provider must not be invoked without budget configuration');
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /budget configuration required for usd-ledger provider/);
});


