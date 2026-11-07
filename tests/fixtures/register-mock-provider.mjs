import { defaultProviderRegistry, ProviderAdapter, OUTCOME_KINDS, ERROR_KINDS } from '../../scripts/provider-adapter.mjs';

export class MockRunnerProviderAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({ provider: 'mock-runner-provider', descriptor: options.descriptor });
  }

  async execute({ prompt, schema, toolGateway, timeoutMs, maxBudgetUsd, env }) {
    if (env?.FAIL_MOCK === 'true') {
      return {
        ok: false,
        kind: OUTCOME_KINDS.FAIL,
        errorKind: ERROR_KINDS.DOWNSTREAM,
        error: 'mock-runner-provider simulated failure',
      };
    }

    return {
      ok: true,
      kind: OUTCOME_KINDS.OK,
      errorKind: ERROR_KINDS.NONE,
      provider: 'mock-runner-provider',
      status: 200,
      structured: {
        summary: 'Mock third provider completed shard review successfully',
        findings: [
          {
            severity: 'P2',
            title: 'Mock finding from registered third provider',
            body: 'Details of mock third provider finding',
            path: 'a.swift',
            line: 12,
            failurePath: 'Simulated failure path',
          },
        ],
        coverage: {
          complete: true,
          reviewedPaths: ['a.swift'],
          unreviewedPaths: [],
          note: 'all files reviewed',
        },
      },
      meta: {
        provider: 'mock-runner-provider',
        requested_model: 'mock-runner-v1',
        resolved_model: 'mock-runner-v1',
        total_cost_usd: 0.04,
        cost_source: 'sdk',
        duration_ms: 45,
        usage: {
          input_tokens: 120,
          output_tokens: 60,
          total_tokens: 180,
        },
      },
    };
  }
}

if (!defaultProviderRegistry.has('mock-runner-provider')) {
  defaultProviderRegistry.register('mock-runner-provider', MockRunnerProviderAdapter, {
    description: 'Mock Third Provider for Production Runners',
    capabilities: {
      tools: false,
      structuredOutput: true,
      multiturnTools: false,
      hostSecurity: 'host-enforced',
    },
    policy: {
      budgetType: 'usd-ledger',
      defaultTimeoutMs: 30000,
      credentialsRequired: [],
      circuitBreaker: { maxFailures: 2 },
      requiresStructuredOutput: true,
    },
  });
}
