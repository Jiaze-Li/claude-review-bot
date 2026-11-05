import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProviderAdapter,
  GeminiProviderAdapter,
  ClaudeProviderAdapter,
  PROVIDER_KINDS,
  OUTCOME_KINDS,
  ERROR_KINDS,
  COST_SOURCES,
} from '../scripts/provider-adapter.mjs';

const basicSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object' } },
  },
  required: ['summary'],
};

test('Gemini adapter normalizes successful structured response and token usage', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
  assert.ok(adapter instanceof GeminiProviderAdapter);

  const mockFetch = async () =>
    Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'all clean', findings: [] }) }] } }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 45,
        thoughtsTokenCount: 15,
        totalTokenCount: 180,
      },
      modelVersion: 'gemini-2.0-flash-exp',
    });

  const outcome = await adapter.execute({
    prompt: 'review this diff',
    schema: basicSchema,
    env: { GEMINI_API_KEY: 'test-key' },
    fetchImpl: mockFetch,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, OUTCOME_KINDS.OK);
  assert.equal(outcome.errorKind, ERROR_KINDS.NONE);
  assert.equal(outcome.provider, 'gemini');
  assert.equal(outcome.structured.summary, 'all clean');
  assert.deepEqual(outcome.structured.findings, []);

  // Provenance & Metadata
  assert.equal(outcome.meta.provider, 'gemini');
  assert.equal(outcome.meta.resolved_model, 'gemini-2.0-flash-exp');
  assert.equal(outcome.meta.total_cost_usd, 0);
  assert.equal(outcome.meta.cost_source, COST_SOURCES.ZERO);
  assert.equal(outcome.meta.usage.input_tokens, 120);
  assert.equal(outcome.meta.usage.output_tokens, 45);
  assert.equal(outcome.meta.usage.thoughts_tokens, 15);
  assert.equal(outcome.meta.usage.total_tokens, 180);
});

test('Gemini adapter classifies unavailable HTTP statuses (402, 429, 500, 503)', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);

  for (const status of [402, 429, 500, 503]) {
    const mockFetch = async () => new Response('out of service', { status });
    const outcome = await adapter.execute({
      prompt: 'p',
      schema: basicSchema,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, OUTCOME_KINDS.UNAVAILABLE, `Status ${status} should be unavailable`);
    assert.equal(outcome.errorKind, ERROR_KINDS.UNAVAILABLE);
    assert.equal(outcome.status, status);
  }
});

test('Gemini adapter classifies configuration errors (missing key, 400, 401, 403, 404)', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);

  // Missing key
  const missingKey = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: {},
  });
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.kind, OUTCOME_KINDS.CONFIG);
  assert.equal(missingKey.errorKind, ERROR_KINDS.CONFIG);
  assert.match(missingKey.error, /GEMINI_API_KEY is not set/);

  // HTTP config errors
  for (const status of [400, 401, 403, 404]) {
    const mockFetch = async () => new Response('bad config', { status });
    const outcome = await adapter.execute({
      prompt: 'p',
      schema: basicSchema,
      env: { GEMINI_API_KEY: 'bad-key' },
      fetchImpl: mockFetch,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, OUTCOME_KINDS.CONFIG, `Status ${status} should be config error`);
    assert.equal(outcome.errorKind, ERROR_KINDS.CONFIG);
  }
});

test('Gemini adapter handles network errors, timeouts, and retries malformed output', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);

  // Network error
  const netError = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(netError.ok, false);
  assert.equal(netError.kind, OUTCOME_KINDS.FAILED);
  assert.match(netError.error, /ECONNRESET/);

  // Timeout
  const timeoutError = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
    timeoutMs: 10,
  });
  assert.equal(timeoutError.ok, false);
  assert.equal(timeoutError.kind, OUTCOME_KINDS.FAILED);
  assert.equal(timeoutError.errorKind, ERROR_KINDS.TIMEOUT);
  assert.match(timeoutError.error, /timed out after 10ms/);

  // Flaky malformed output recovered on 2nd attempt
  let attempts = 0;
  const flakyFetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return Response.json({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'recovered' }) }] } }],
    });
  };
  const recovered = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { GEMINI_API_KEY: 'k' },
    fetchImpl: flakyFetch,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.structured.summary, 'recovered');
  assert.equal(attempts, 2);

  // Persistent malformed output fails after 2 attempts
  let badAttempts = 0;
  const persistentBadFetch = async () => {
    badAttempts += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: 'never json' }] } }] });
  };
  const failedMalformed = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { GEMINI_API_KEY: 'k' },
    fetchImpl: persistentBadFetch,
  });
  assert.equal(failedMalformed.ok, false);
  assert.equal(failedMalformed.kind, OUTCOME_KINDS.FAILED);
  assert.equal(failedMalformed.errorKind, ERROR_KINDS.MALFORMED);
  assert.equal(badAttempts, 2);
});

test('Claude adapter normalizes successful structured response and SDK cost', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE);
  assert.ok(adapter instanceof ClaudeProviderAdapter);

  const fakeQuery = async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-3-7-sonnet-20250219' };
    yield {
      type: 'result',
      subtype: 'success',
      num_turns: 4,
      duration_ms: 1200,
      total_cost_usd: 0.145,
      usage: { input_tokens: 500, output_tokens: 150, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      modelUsage: {
        'claude-3-7-sonnet-20250219': { inputTokens: 500, outputTokens: 150, costUSD: 0.145 },
      },
      structured_output: { summary: 'claude pass', findings: [] },
    };
  };

  const outcome = await adapter.execute({
    prompt: 'review this diff',
    schema: basicSchema,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
    queryImpl: fakeQuery,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, OUTCOME_KINDS.OK);
  assert.equal(outcome.provider, 'claude');
  assert.equal(outcome.structured.summary, 'claude pass');
  assert.equal(outcome.meta.resolved_model, 'claude-3-7-sonnet-20250219');
  assert.equal(outcome.meta.num_turns, 4);
  assert.equal(outcome.meta.total_cost_usd, 0.145);
  assert.equal(outcome.meta.cost_source, COST_SOURCES.SDK);
  assert.equal(outcome.meta.usage.input_tokens, 500);
  assert.equal(outcome.meta.usage.output_tokens, 150);
  assert.equal(outcome.meta.usage.cache_read_input_tokens, 200);
  assert.equal(outcome.meta.usage.cache_creation_input_tokens, 50);
});

test('Claude adapter falls back to conservative reserve cost when SDK reports no cost', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE);

  const fakeQueryNoCost = async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet' };
    yield {
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      total_cost_usd: null,
      usage: { input_tokens: 100, output_tokens: 20 },
      structured_output: { summary: 'pass with no sdk cost' },
    };
  };

  const outcome = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    queryImpl: fakeQueryNoCost,
    fallbackUnknownCostUsd: 0.5,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.meta.total_cost_usd, 0.5);
  assert.equal(outcome.meta.cost_source, COST_SOURCES.RESERVE);
});

test('Claude adapter enforces environment isolation and tool denial', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE);
  let capturedOptions = null;

  const fakeQuery = async function* ({ options }) {
    capturedOptions = options;
    yield {
      type: 'result',
      subtype: 'success',
      structured_output: { summary: 'ok' },
    };
  };

  await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-claude',
      GH_TOKEN: 'leaked-gh-token',
      GEMINI_API_KEY: 'leaked-gemini-key',
      PATH: '/bin',
      HOME: '/home',
      TMPDIR: '/tmp',
    },
    queryImpl: fakeQuery,
    isolateEnv: true,
  });

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.env.CLAUDE_CODE_OAUTH_TOKEN, 'secret-claude');
  assert.equal(capturedOptions.env.GH_TOKEN, undefined);
  assert.equal(capturedOptions.env.GEMINI_API_KEY, undefined);
  assert.deepEqual(Object.keys(capturedOptions.env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TMPDIR']);

  // Tool authorization callback
  const toolResult = await capturedOptions.canUseTool('Read', { file_path: 'foo' });
  assert.equal(toolResult.behavior, 'deny');
});

test('Claude adapter classifies failure modes: turn limit, budget exhausted, missing output', async () => {
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE);

  // Turn limit
  const turnLimitQuery = async function* () {
    yield {
      type: 'result',
      subtype: 'error_max_turns',
      num_turns: 14,
      total_cost_usd: 0.4,
      errors: ['exceeded turn limit'],
    };
  };
  const turnLimit = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    queryImpl: turnLimitQuery,
  });
  assert.equal(turnLimit.ok, false);
  assert.equal(turnLimit.kind, OUTCOME_KINDS.FAILED);
  assert.equal(turnLimit.errorKind, ERROR_KINDS.EXECUTION);
  assert.equal(turnLimit.subtype, 'error_max_turns');

  // Budget exhausted
  const budgetQuery = async function* () {
    yield {
      type: 'result',
      subtype: 'error_max_budget',
      total_cost_usd: 2.0,
      errors: ['budget cap reached'],
    };
  };
  const budgetExhausted = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    queryImpl: budgetQuery,
  });
  assert.equal(budgetExhausted.ok, false);
  assert.equal(budgetExhausted.kind, OUTCOME_KINDS.UNAVAILABLE);
  assert.equal(budgetExhausted.errorKind, ERROR_KINDS.UNAVAILABLE);

  // Missing structured output
  const missingOutputQuery = async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      structured_output: null,
    };
  };
  const missingOutput = await adapter.execute({
    prompt: 'p',
    schema: basicSchema,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    queryImpl: missingOutputQuery,
  });
  assert.equal(missingOutput.ok, false);
  assert.equal(missingOutput.kind, OUTCOME_KINDS.FAILED);
  assert.equal(missingOutput.errorKind, ERROR_KINDS.MALFORMED);
});
