import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultProviderRegistry,
  ProviderAdapter,
  createHostToolAuthorizer,
  OUTCOME_KINDS,
  ERROR_KINDS,
} from '../scripts/provider-adapter.mjs';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { runReview } from '../scripts/run-review.mjs';
import { executeWorkUnit, BudgetManager } from '../scripts/review-orchestrator.mjs';
import { ReadOnlyToolGateway } from '../scripts/tool-gateway.mjs';
import './fixtures/register-mock-provider.mjs';

test('Production Runner Integration: runGeminiReview routes through registered mock third provider', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-runner-test-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });

  const sessionPlan = {
    decision: { mode: 'incremental' },
    requestedMode: 'auto',
    session: {
      version: 1,
      threadId: 'test-thread',
      status: 'OPEN',
      findings: [],
    },
  };
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify(sessionPlan));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } }));

  try {
    const env = {
      REVIEW_PROVIDERS: 'mock-runner-provider',
      PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
      TARGET_REPO: 'test/repo',
      PR_NUMBER: '10',
      HEAD_SHA: 'a'.repeat(40),
      REVIEW_CONTEXT_DIR: ctxDir,
    };

    const logs = [];
    const result = await runGeminiReview({
      env,
      fetchImpl: null,
      logImpl: (msg) => logs.push(msg),
    });

    assert.ok(result);
    assert.equal(result._meta.provider, 'mock-runner-provider');
    assert.equal(result._meta.requested_model, 'mock-runner-v1');
    assert.equal(result._meta.total_cost_usd, undefined);
    assert.equal(result._meta.provider_costs['mock-runner-provider'], 0.04);
    assert.ok(result._meta.provider_usage['mock-runner-provider']);
    assert.match(result.summary, /Mock third provider/);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'P2');
    assert.equal(result.findings[0].path, 'a.swift');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Production Runner Integration: runGeminiReview verification mode handles third provider structured verifications', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-verification-test-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });

  class MockVerificationProviderAdapter extends ProviderAdapter {
    constructor(options = {}) {
      super({ provider: 'mock-verification-provider', descriptor: options.descriptor });
    }

    async execute({ prompt, schema, timeoutMs }) {
      return {
        ok: true,
        kind: OUTCOME_KINDS.OK,
        errorKind: ERROR_KINDS.NONE,
        provider: 'mock-verification-provider',
        status: 200,
        structured: {
          summary: 'Verification review completed',
          verifications: [
            {
              findingId: 'F001',
              status: 'FIXED',
              reason: 'Proper boundary validation was implemented',
            },
          ],
          findings: [],
        },
        meta: {
          provider: 'mock-verification-provider',
          requested_model: 'mock-verif-v1',
          resolved_model: 'mock-verif-v1',
          total_cost_usd: 0.01,
          cost_source: 'sdk',
          duration_ms: 30,
          usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
        },
      };
    }
  }

  defaultProviderRegistry.register('mock-verification-provider', MockVerificationProviderAdapter, {
    description: 'Mock Verification Provider',
    capabilities: { tools: false, structuredOutput: true },
    policy: { budgetType: 'none', defaultTimeoutMs: 30000 },
  });

  const sessionPlan = {
    decision: { mode: 'verification' },
    requestedMode: 'auto',
    session: {
      version: 1,
      threadId: 'test-thread',
      baseSha: '0'.repeat(40),
      lastReviewedHead: '1'.repeat(40),
      status: 'REWORK',
      findings: [
        {
          id: 'F001',
          severity: 'P1',
          title: 'Buffer overflow vulnerability',
          path: 'src/net.c',
          line: 20,
        },
      ],
    },
  };
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify(sessionPlan));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 11, title: 'Fix overflow', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/src/net.c b/src/net.c\n--- a/src/net.c\n+++ b/src/net.c\n@@ -1 +1 @@\n+fixed\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } }));

  try {
    const env = {
      REVIEW_PROVIDERS: 'mock-verification-provider',
      TARGET_REPO: 'test/repo',
      PR_NUMBER: '11',
      HEAD_SHA: 'b'.repeat(40),
      REVIEW_CONTEXT_DIR: ctxDir,
    };

    const result = await runGeminiReview({
      env,
      fetchImpl: null,
      logImpl: () => {},
    });

    assert.ok(result);
    assert.equal(result._meta.provider, 'mock-verification-provider');
    assert.equal(result.verifications.length, 1);
    assert.equal(result.verifications[0].status, 'FIXED');
    assert.equal(result.verifications[0].findingId, 'F001');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Production Runner Integration: run-review.mjs entrypoint completes with registered mock third provider', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-runner-test-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  const shardsDir = path.join(ctxDir, 'shards');
  fs.mkdirSync(shardsDir, { recursive: true });

  fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), 'a.swift\n');
  fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), '1 file changed, 1 insertion(+)\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+line one\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 12, title: 'Full review PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } }));

  const repoRoot = path.resolve('.');
  const fixturePath = path.join(repoRoot, 'tests/fixtures/register-mock-provider.mjs');
  const runReviewPath = path.join(repoRoot, 'scripts/run-review.mjs');

  try {
    const child = spawnSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(fixturePath)}).then(() => import(${JSON.stringify(runReviewPath)})).then(m => m.runReview ? m.runReview() : null)`],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '12',
          HEAD_SHA: 'c'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
          REVIEW_OUTPUT_PATH: path.join(ctxDir, 'review.json'),
        },
      }
    );

    assert.equal(child.status, 0, `Process failed: ${child.stderr}\n${child.stdout}`);
    const outJsonPath = path.join(ctxDir, 'review.json');
    assert.ok(fs.existsSync(outJsonPath), 'review.json must be generated');
    const doc = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));

    assert.equal(doc._meta.providers['mock-runner-provider'], 1);
    assert.equal(doc._meta.total_cost_usd, 0);
    assert.equal(doc._meta.provider_costs['mock-runner-provider'], 0.04);
    assert.ok(doc._meta.provider_usage['mock-runner-provider']);
    assert.equal(doc.coverage.complete, true);
    assert.deepEqual(doc.coverage.reviewedPaths, ['a.swift']);
    assert.equal(doc.findings.length, 1);
    assert.equal(doc.findings[0].severity, 'P2');
    assert.match(doc.summary, /Mock third provider/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Explicit budget enforcement: usd-ledger provider without budget configuration fails closed', async () => {
  class UsdLedgerMockAdapter extends ProviderAdapter {
    constructor(options = {}) {
      super({ provider: 'usd-mock', descriptor: options.descriptor });
    }
    async execute() {
      return { ok: true, structured: { summary: 'Should not run', findings: [] } };
    }
  }

  defaultProviderRegistry.register('usd-mock', UsdLedgerMockAdapter, {
    description: 'USD Ledger Mock Provider',
    capabilities: { tools: false, structuredOutput: true },
    policy: { budgetType: 'usd-ledger', defaultTimeoutMs: 10000 },
  });

  const outcome = await executeWorkUnit({
    unit: { diff: 'test-diff' },
    providers: ['usd-mock'],
    budgetManager: null, // explicit null
    executors: {
      'usd-mock': async () => {
        assert.fail('usd-mock executor must not be called when budgetManager is missing');
      },
    },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /budget configuration required for usd-ledger provider but none was provided/);
});

test('Host security boundary enforcement: createHostToolAuthorizer strictly denies unauthorized native tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-boundary-test-'));
  const safeRoot = path.join(tmpDir, 'safe');
  const contextRoot = path.join(tmpDir, 'context');
  fs.mkdirSync(safeRoot, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  fs.writeFileSync(path.join(safeRoot, 'sample.txt'), 'safe content');

  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot,
      contextRoot,
      cwd: tmpDir,
    });

    const authorizer = createHostToolAuthorizer({
      toolGateway: gateway,
      serverName: 'gateway',
    });

    // Authorized Host Gateway tool calls are permitted
    const allowRes = await authorizer('mcp__gateway__Read', { file_path: 'sample.txt' });
    assert.equal(allowRes.behavior, 'allow');

    // Native host/agent tools are strictly forbidden
    const nativeBashRes = await authorizer('Bash', { command: 'rm -rf /' });
    assert.equal(nativeBashRes.behavior, 'deny');
    assert.match(nativeBashRes.message, /forbidden.*use Host Gateway tools/);

    const nativeEditRes = await authorizer('Edit', { file_path: 'sample.txt' });
    assert.equal(nativeEditRes.behavior, 'deny');

    const nativeWriteRes = await authorizer('Write', { file_path: 'sample.txt' });
    assert.equal(nativeWriteRes.behavior, 'deny');

    // Without gateway, authorizer denies all tools
    const noGatewayAuthorizer = createHostToolAuthorizer({ toolGateway: null });
    const denied = await noGatewayAuthorizer('Read', {});
    assert.equal(denied.behavior, 'deny');
    assert.match(denied.message, /no Host Gateway available/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Runner REVIEW_PROVIDERS validation: unknown provider fails explicitly in runGeminiReview', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-unknown-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental' }, requestedMode: 'auto' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));
  try {
    await assert.rejects(
      runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'unknown-provider',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
      }),
      /Unknown review provider "unknown-provider"/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Runner REVIEW_PROVIDERS validation: unknown provider fails explicitly in runReview', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-unknown-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), 'a.swift\n');
  fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), '1 file changed\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.diff'), 'diff --git a/a.swift b/a.swift\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 12, title: 'Full review PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));
  try {
    await assert.rejects(
      runReview({
        env: {
          REVIEW_PROVIDERS: 'unknown-provider',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '12',
          HEAD_SHA: 'c'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        cwd: tmpDir,
      }),
      /Unknown review provider "unknown-provider"/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Runner REVIEW_PROVIDERS validation: duplicated providers deduplicated in runGeminiReview', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-dedupe-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental' }, requestedMode: 'auto' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));
  try {
    const result = await runGeminiReview({
      env: {
        REVIEW_PROVIDERS: 'mock-runner-provider,mock-runner-provider',
        PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
        TARGET_REPO: 'test/repo',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        REVIEW_CONTEXT_DIR: ctxDir,
      },
      logImpl: () => {},
    });
    assert.ok(result);
    assert.equal(result._meta.provider, 'mock-runner-provider');
    assert.equal(result._meta.provider_costs['mock-runner-provider'], 0.04);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Runner REVIEW_PROVIDERS validation: duplicated providers deduplicated in runReview', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-dedupe-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(path.join(ctxDir, 'shards'), { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), 'a.swift\n');
  fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), '1 file changed, 1 insertion(+)\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+line one\n');
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 12, title: 'Full review PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));
  try {
    const doc = await runReview({
      env: {
        REVIEW_PROVIDERS: 'mock-runner-provider,mock-runner-provider',
        PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
        TARGET_REPO: 'test/repo',
        PR_NUMBER: '12',
        HEAD_SHA: 'c'.repeat(40),
        REVIEW_CONTEXT_DIR: ctxDir,
        REVIEW_OUTPUT_PATH: path.join(ctxDir, 'review.json'),
      },
      cwd: tmpDir,
    });
    assert.ok(doc);
    assert.equal(doc._meta.providers['mock-runner-provider'], 1);
    assert.equal(doc._meta.provider_costs['mock-runner-provider'], 0.04);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Explicit @claude review remains Claude-only even when REVIEW_PROVIDERS includes third providers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-claude-only-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'incremental' },
    requestedMode: 'claude',
    session: { version: 1, threadId: 'test-thread', status: 'OPEN', findings: [] },
  }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));

  try {
    // In runGeminiReview:
    await assert.rejects(
      runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
      }),
      /CLAUDE_CODE_OAUTH_TOKEN|Claude budget|safe-target/
    );

    // In runReview:
    fs.mkdirSync(path.join(ctxDir, 'shards'), { recursive: true });
    fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), 'a.swift\n');
    fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), '1 file changed\n');
    fs.writeFileSync(path.join(ctxDir, 'pr.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+line one\n');
    await assert.rejects(
      runReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        cwd: tmpDir,
      }),
      /CLAUDE_CODE_OAUTH_TOKEN|Claude budget|safe-target/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Explicit budget enforcement: usd-ledger provider without budget configuration fails closed in runners', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-budget-runners-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental' }, requestedMode: 'auto' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));

  try {
    // runGeminiReview fails closed
    await assert.rejects(
      runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
      }),
      /budget configuration required for usd-ledger provider but none was provided/
    );

    // runReview fails closed
    fs.mkdirSync(path.join(ctxDir, 'shards'), { recursive: true });
    fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), 'a.swift\n');
    fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), '1 file changed\n');
    fs.writeFileSync(path.join(ctxDir, 'pr.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+line one\n');
    await assert.rejects(
      runReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        cwd: tmpDir,
      }),
      /budget configuration required for usd-ledger provider but none was provided/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Third-party failure accounting: failure settles reservation without corrupting Claude session', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-accounting-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental' }, requestedMode: 'auto' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));

  try {
    // When FAIL_MOCK is set, mock-runner-provider fails
    await assert.rejects(
      runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '5.00',
          FAIL_MOCK: 'true',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        logImpl: () => {},
      }),
      /mock-runner-provider simulated failure|mock-runner-provider failed/
    );

    // Verify Claude usage file was not created or modified with spurious charges
    const claudeUsagePath = path.join(ctxDir, 'claude-usage.json');
    assert.equal(fs.existsSync(claudeUsagePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Production Runner Integration: runGeminiReview shares third-party BudgetManager across multi-part diffs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-multipart-budget-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental' }, requestedMode: 'auto' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Multi-part PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, signals: {} }));

  // Two files each exceeding chunking thresholds to generate 2 parts (>300,000 bytes total)
  const bigFile1 = `diff --git a/f1.swift b/f1.swift\n--- a/f1.swift\n+++ b/f1.swift\n@@ -1 +1 @@\n+${'x'.repeat(160000)}\n`;
  const bigFile2 = `diff --git a/f2.swift b/f2.swift\n--- a/f2.swift\n+++ b/f2.swift\n@@ -1 +1 @@\n+${'y'.repeat(160000)}\n`;
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), bigFile1 + bigFile2);

  try {
    // 1. With insufficient budget for 2 parts ($0.05 budget when each part costs $0.04), it must fail on budget exhaustion
    await assert.rejects(
      runGeminiReview({
        env: {
          REVIEW_PROVIDERS: 'mock-runner-provider',
          PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '0.05',
          TARGET_REPO: 'test/repo',
          PR_NUMBER: '10',
          HEAD_SHA: 'a'.repeat(40),
          REVIEW_CONTEXT_DIR: ctxDir,
        },
        logImpl: () => {},
      }),
      /budget.*is exhausted/
    );

    // 2. With sufficient budget ($0.20), both parts complete and total cost $0.08 is recorded in _meta.provider_costs
    const result = await runGeminiReview({
      env: {
        REVIEW_PROVIDERS: 'mock-runner-provider',
        PROVIDER_MOCK_RUNNER_PROVIDER_BUDGET_USD: '0.20',
        TARGET_REPO: 'test/repo',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        REVIEW_CONTEXT_DIR: ctxDir,
      },
      logImpl: () => {},
    });

    assert.ok(result);
    assert.equal(result._meta.provider, 'mock-runner-provider');
    assert.equal(result._meta.parts, 2);
    assert.equal(result._meta.total_cost_usd, undefined);
    assert.equal(result._meta.provider_costs['mock-runner-provider'], 0.08);
    assert.ok(result._meta.provider_usage['mock-runner-provider']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Missing Gemini key handling: runGeminiReview falls back to Claude when GEMINI_API_KEY is missing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-missing-key-'));
  const ctxDir = path.join(tmpDir, '.review-context');
  fs.mkdirSync(ctxDir, { recursive: true });

  const sessionPlan = {
    decision: { mode: 'incremental' },
    requestedMode: 'auto',
    session: {
      version: 1,
      threadId: 'test-thread',
      status: 'OPEN',
      findings: [],
    },
  };
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify(sessionPlan));
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 10, title: 'Test PR', base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), 'diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n+test change\n');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify({ version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } }));

  try {
    let geminiCalled = false;
    const fetchImpl = async () => {
      geminiCalled = true;
      throw new Error('Gemini fetch should not be called when GEMINI_API_KEY is missing');
    };

    const claudeCalls = [];
    const queryImpl = async function* (args) {
      claudeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { summary: 'fallback to claude on missing key', findings: [] },
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.05,
      };
    };

    const env = {
      TARGET_REPO: 'test/repo',
      PR_NUMBER: '10',
      HEAD_SHA: 'a'.repeat(40),
      REVIEW_CONTEXT_DIR: ctxDir,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      GH_TOKEN: 'test-gh-token',
      // GEMINI_API_KEY is omitted
    };

    const logs = [];
    const result = await runGeminiReview({
      env,
      fetchImpl,
      queryImpl,
      logImpl: (msg) => logs.push(msg),
    });

    assert.equal(geminiCalled, false, 'Gemini fetch must not be invoked');
    assert.equal(claudeCalls.length, 1, 'Claude must be invoked as fallback');
    assert.ok(result);
    assert.equal(result._meta.provider, 'claude');
    assert.equal(result._meta.fallback_from, 'gemini');
    assert.equal(result._meta.fallback_reason, 'GEMINI_API_KEY is not configured');
    assert.equal(result.summary, 'fallback to claude on missing key');

    // Also test: when only Gemini is configured and GEMINI_API_KEY is missing, fails closed with CONFIG/UNAVAILABLE
    await assert.rejects(
      runGeminiReview({
        env: {
          ...env,
          REVIEW_PROVIDERS: 'gemini',
        },
        fetchImpl,
        queryImpl,
        logImpl: () => {},
      }),
      /GEMINI_API_KEY is not configured/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GitHub Actions workflow propagation: review-v2.yml propagates REVIEW_PROVIDERS to production runners', () => {
  const ymlPath = path.resolve('.github/workflows/review-v2.yml');
  const yml = fs.readFileSync(ymlPath, 'utf8');

  // Verify inputs defined
  assert.match(yml, /workflow_dispatch:[\s\S]*?review_providers:\s*\n\s*description:/);
  assert.match(yml, /workflow_call:[\s\S]*?review_providers:\s*\n\s*required: false/);

  // Verify job level environment propagation
  assert.match(yml, /jobs:\s*\n\s*review:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*env:\s*\n\s*REVIEW_PROVIDERS:/);

  // Verify step level propagation to begin-deep and gemini-run
  const beginDeepBlock = yml.slice(yml.indexOf('- name: Begin Claude deep review'), yml.indexOf('- name: Recover published session'));
  assert.match(beginDeepBlock, /REVIEW_PROVIDERS: \$\{\{ inputs\.review_providers \|\| vars\.REVIEW_PROVIDERS \|\| '' \}\}/);

  const geminiRunBlock = yml.slice(yml.indexOf('- name: Run Gemini bounded review'), yml.indexOf('- name: Record provider-unavailable delta review'));
  assert.match(geminiRunBlock, /REVIEW_PROVIDERS: \$\{\{ inputs\.review_providers \|\| vars\.REVIEW_PROVIDERS \|\| '' \}\}/);

  const claudeRunBlock = yml.slice(yml.indexOf('- name: Run Claude explicit deep review'), yml.indexOf('- name: Publish Claude explicit deep review'));
  assert.match(claudeRunBlock, /REVIEW_PROVIDERS: \$\{\{ steps\.begin-deep\.outputs\.providers \}\}/);
});
