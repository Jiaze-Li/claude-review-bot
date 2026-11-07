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
      ['-e', `import(${JSON.stringify(fixturePath)}).then(() => import(${JSON.stringify(runReviewPath)}))`],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          REVIEW_PROVIDERS: 'mock-runner-provider',
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
