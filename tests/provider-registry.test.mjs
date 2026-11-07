import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderRegistry,
  ProviderAdapter,
  defaultProviderRegistry,
  registerProvider,
  getProviderDescriptor,
  listProviders,
  getProviderAdapter,
  PROVIDER_KINDS,
  OUTCOME_KINDS,
  ERROR_KINDS,
  validateStructuredReview,
} from '../scripts/provider-adapter.mjs';
import {
  executeWorkUnit,
  CircuitBreaker,
  BudgetManager,
  normalizeProviderOutcome,
} from '../scripts/review-orchestrator.mjs';
import { ReadOnlyToolGateway } from '../scripts/tool-gateway.mjs';

test('Provider extensibility: adding a third provider requires zero Review Engine or Orchestrator changes', async () => {
  // 1. Create and register a custom third provider: mock-llm
  class MockThirdProviderAdapter extends ProviderAdapter {
    constructor(options = {}) {
      super({ provider: 'mock-llm', descriptor: options.descriptor });
      this.apiKey = options.env?.MOCK_API_KEY || 'default-mock-key';
    }

    async execute({ prompt, schema, toolGateway, timeoutMs, maxBudgetUsd }) {
      if (!this.apiKey) {
        return {
          ok: false,
          kind: OUTCOME_KINDS.CONFIG,
          errorKind: ERROR_KINDS.CONFIG,
          error: 'MOCK_API_KEY is not set',
        };
      }

      // If tool gateway is provided, verify Host security by calling safe and unsafe paths
      if (toolGateway) {
        // Safe tool call
        const safeRead = await toolGateway.executeTool('Read', { file_path: 'src/app.js' });
        assert.equal(safeRead.ok, true);

        // Host security check: gateway denies path traversal to outside root
        const traversalRead = await toolGateway.executeTool('Read', { file_path: path.join(outsideRoot, 'secret.key') });
        assert.equal(traversalRead.ok, false);
        assert.match(traversalRead.error, /escapes authorized boundaries/i);

        // Host security check: gateway forbids control files
        const controlRead = await toolGateway.executeTool('Read', { file_path: '.git/config' });
        assert.equal(controlRead.ok, false);
        assert.match(controlRead.error, /control path is forbidden/i);
      }

      const structured = {
        summary: 'Mock third provider identified 1 architecture issue',
        findings: [
          {
            severity: 'P1',
            title: 'Unbounded memory buffer allocation',
            body: 'Buffer allocation does not check size against maximum threshold.',
            path: 'src/app.js',
            line: 42,
            failurePath: 'Memory exhaustion under high load',
          },
        ],
        coverage: {
          complete: true,
          reviewedPaths: ['src/app.js'],
          unreviewedPaths: [],
          note: 'Full coverage by mock third provider',
        },
      };

      const valid = validateStructuredReview(structured, schema);
      assert.equal(valid.ok, true);

      return {
        ok: true,
        kind: OUTCOME_KINDS.OK,
        errorKind: ERROR_KINDS.NONE,
        provider: this.provider,
        status: 200,
        structured,
        meta: {
          provider: this.provider,
          requested_model: 'mock-v1',
          resolved_model: 'mock-v1',
          total_cost_usd: 0.05,
          cost_source: 'sdk',
          duration_ms: 120,
          usage: {
            input_tokens: 350,
            output_tokens: 120,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            thoughts_tokens: null,
            total_tokens: 470,
          },
        },
      };
    }
  }

  const customRegistry = new ProviderRegistry();
  customRegistry.register('mock-llm', MockThirdProviderAdapter, {
    description: 'Custom Third-Party LLM Provider Adapter',
    capabilities: {
      tools: true,
      structuredOutput: true,
      multiturnTools: true,
      hostSecurity: 'host-enforced',
    },
    policy: {
      budgetType: 'usd-ledger',
      defaultTimeoutMs: 120_000,
      credentialsRequired: ['MOCK_API_KEY'],
      circuitBreaker: { maxFailures: 3 },
      requiresStructuredOutput: true,
    },
  });

  assert.equal(customRegistry.has('mock-llm'), true);
  const desc = customRegistry.getDescriptor('mock-llm');
  assert.equal(desc.capabilities.tools, true);
  assert.equal(desc.capabilities.hostSecurity, 'host-enforced');
  assert.equal(desc.policy.budgetType, 'usd-ledger');
  assert.equal(desc.policy.requiresStructuredOutput, true);

  // Setup temporary safe workspace for tool gateway
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'third-provider-test-'));
  const safeRoot = path.join(tmpDir, 'repo');
  const outsideRoot = path.join(tmpDir, 'outside');
  const contextRoot = path.join(tmpDir, 'context');
  fs.mkdirSync(path.join(safeRoot, 'src'), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  fs.writeFileSync(path.join(safeRoot, 'src', 'app.js'), 'console.log("hello safe code");\n');
  fs.writeFileSync(path.join(outsideRoot, 'secret.key'), 'SUPER_SECRET_KEY\n');

  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot,
      contextRoot,
      cwd: tmpDir,
    });

    const budgetMgr = new BudgetManager({
      minStartingAllowanceUsd: 1.0,
      getAvailableBudget: () => 10.0,
      perCallCap: 2.0,
    });

    // 2. Execute via executeWorkUnit without any Review Engine / Orchestrator code changes
    const outcome = await executeWorkUnit({
      unit: { diff: 'diff --git a/src/app.js b/src/app.js' },
      providers: ['mock-llm'],
      providerRegistry: customRegistry,
      budgetManagers: {
        'mock-llm': budgetMgr,
      },
      executors: {
        'mock-llm': async ({ unit, timeoutMs, maxBudgetUsd, reservation }) => {
          assert.ok(reservation, 'Reservation must be acquired for usd-ledger provider');
          const adapter = customRegistry.createAdapter('mock-llm', {
            env: { MOCK_API_KEY: 'test-mock-key' },
          });
          return adapter.execute({
            prompt: unit.diff,
            toolGateway: gateway,
            timeoutMs,
            maxBudgetUsd,
          });
        },
      },
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.provider, 'mock-llm');
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.totalCostUsd, 0.05);
    assert.equal(outcome.costSource, 'sdk');
    assert.equal(outcome.structured.findings.length, 1);
    assert.equal(outcome.structured.findings[0].severity, 'P1');
    assert.equal(outcome.coverage.complete, true);
    assert.deepEqual(outcome.coverage.reviewedPaths, ['src/app.js']);

    // Budget was properly settled
    assert.equal(budgetMgr.charges.length, 1);
    assert.equal(budgetMgr.charges[0].amount, 0.05);
    assert.equal(budgetMgr.charges[0].source, 'sdk');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Generic fallback cascade: third provider failure automatically cascades to secondary provider', async () => {
  const customRegistry = new ProviderRegistry();
  customRegistry.register('failing-third', class FailingThird extends ProviderAdapter {
    constructor(o) { super({ provider: 'failing-third', descriptor: o.descriptor }); }
    async execute() {
      return { ok: false, kind: OUTCOME_KINDS.UNAVAILABLE, errorKind: ERROR_KINDS.UNAVAILABLE, error: 'HTTP 503 Service Unavailable', status: 503 };
    }
  }, {
    policy: { budgetType: 'none', defaultTimeoutMs: 30000, circuitBreaker: { maxFailures: 2 } },
    capabilities: { tools: false, structuredOutput: true },
  });

  customRegistry.register('fallback-third', class FallbackThird extends ProviderAdapter {
    constructor(o) { super({ provider: 'fallback-third', descriptor: o.descriptor }); }
    async execute() {
      return {
        ok: true,
        kind: OUTCOME_KINDS.OK,
        errorKind: ERROR_KINDS.NONE,
        status: 200,
        structured: { summary: 'Fallback provider rescued the review', findings: [] },
      };
    }
  }, {
    policy: { budgetType: 'none', defaultTimeoutMs: 30000 },
    capabilities: { tools: false, structuredOutput: true },
  });

  const breaker = new CircuitBreaker({ maxFailures: 1, breakerName: 'failing-third' });

  const outcome = await executeWorkUnit({
    unit: { diff: 'cascade-test' },
    providers: ['failing-third', 'fallback-third'],
    providerRegistry: customRegistry,
    circuitBreakers: {
      'failing-third': breaker,
    },
    executors: {
      'failing-third': async () => {
        const adapter = customRegistry.createAdapter('failing-third');
        return adapter.execute({});
      },
      'fallback-third': async () => {
        const adapter = customRegistry.createAdapter('fallback-third');
        return adapter.execute({});
      },
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.provider, 'fallback-third');
  assert.equal(outcome.structured.summary, 'Fallback provider rescued the review');
  assert.match(outcome.fellBackFrom, /failing-third: HTTP 503 Service Unavailable/);
  assert.equal(breaker.isOff, true, 'Circuit breaker tripped on 503 unavailable');
});
