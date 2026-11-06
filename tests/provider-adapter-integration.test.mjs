import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview, buildGeminiRequest } from '../scripts/run-gemini-review.mjs';
import { runGeminiShard } from '../scripts/gemini-shard.mjs';
import { runClaudeStructured } from '../scripts/claude-fallback.mjs';
import { getProviderAdapter, PROVIDER_KINDS, OUTCOME_KINDS, COST_SOURCES } from '../scripts/provider-adapter.mjs';

const HEAD_A = 'a'.repeat(40);
const BASE_B = 'b'.repeat(40);

function createReviewContext(mode = 'incremental', extraSession = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-integ-'));
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ number: 1, title: 'Test PR' }));
  fs.writeFileSync(
    path.join(dir, 'repair.diff'),
    'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n+const fixed = true;\n',
  );
  fs.writeFileSync(
    path.join(dir, 'session-plan.json'),
    JSON.stringify({
      decision: { mode },
      session: {
        version: 1,
        baseSha: BASE_B,
        lastReviewedHead: HEAD_A,
        status: 'READY',
        findings: [
          {
            id: 'F001',
            severity: 'P1',
            title: 'SQL injection',
            body: 'Unsanitized input in query',
            path: 'src/app.js',
            line: 1,
            riskClass: 'security',
          },
        ],
        ...extraSession,
      },
      requestedMode: 'auto',
    }),
  );
  return dir;
}

test('Integration E2: Full shard review via adapter retains structured schema and metadata', async () => {
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'object' } },
      coverage: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'] },
    },
    required: ['summary', 'findings', 'coverage'],
  };

  const mockFetch = async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  summary: 'Full shard ok',
                  findings: [],
                  coverage: { complete: true, reviewedPaths: ['src/app.js'], unreviewedPaths: [], note: '' },
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 60, totalTokenCount: 210 },
      modelVersion: 'gemini-2.5-flash',
    });

  const outcome = await runGeminiShard({
    prompt: 'Full shard review prompt',
    schema,
    env: { GEMINI_API_KEY: 'test-key' },
    fetchImpl: mockFetch,
  });

  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.structured.summary, 'Full shard ok');
  assert.equal(outcome.structured.coverage.complete, true);
  assert.deepEqual(outcome.structured.findings, []);
  assert.equal(outcome.meta.provider, 'gemini');
  assert.equal(outcome.meta.resolved_model, 'gemini-2.5-flash');
  assert.equal(outcome.meta.total_cost_usd, 0);
  assert.equal(outcome.meta.usage.input_tokens, 150);
  assert.equal(outcome.meta.usage.output_tokens, 60);
});

test('Integration E2: Incremental Delta review through adapter preserves normalized result & metadata', async () => {
  const dir = createReviewContext('incremental');
  const mockFetch = async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  summary: 'Incremental delta clean',
                  findings: [],
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 250 },
      modelVersion: 'gemini-flash-latest',
    });

  const result = await runGeminiReview({
    env: {
      GEMINI_API_KEY: 'test-key',
      TARGET_REPO: 'owner/repo',
      PR_NUMBER: '1',
      HEAD_SHA: HEAD_A,
      REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl: mockFetch,
    logImpl: () => {},
  });

  assert.equal(result.summary, 'Incremental delta clean');
  assert.deepEqual(result.findings, []);
  assert.equal(result._meta.provider, 'gemini');
  assert.equal(result._meta.mode, 'incremental');
  assert.equal(result._meta.usage.input_tokens, 200);
  assert.equal(result._meta.usage.output_tokens, 40);
  assert.equal(result._meta.usage.thoughts_tokens, 10);
  assert.equal(result._meta.usage.total_tokens, 250);
});

test('Integration E2: Verification review through adapter properly rules on open findings', async () => {
  const dir = createReviewContext('verification');
  const mockFetch = async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  summary: 'Verification complete',
                  verifications: [
                    {
                      findingId: 'F001',
                      status: 'FIXED',
                      reason: 'Sanitization function added in app.js',
                    },
                  ],
                  findings: [],
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80, totalTokenCount: 380 },
    });

  const result = await runGeminiReview({
    env: {
      GEMINI_API_KEY: 'test-key',
      TARGET_REPO: 'owner/repo',
      PR_NUMBER: '1',
      HEAD_SHA: HEAD_A,
      REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl: mockFetch,
    logImpl: () => {},
  });

  assert.equal(result.summary, 'Verification complete');
  assert.equal(result.verifications.length, 1);
  assert.equal(result.verifications[0].findingId, 'F001');
  assert.equal(result.verifications[0].status, 'FIXED');
  assert.equal(result._meta.mode, 'verification');
  assert.equal(result._meta.provider, 'gemini');
});

test('Integration E2: Provider failure fallback to Claude maintains identical downstream shape and facts', async () => {
  const dir = createReviewContext('incremental');
  const mockFetch402 = async () => new Response('{"error":{"message":"credits exhausted"}}', { status: 402 });

  const fakeClaude = async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-3-7-sonnet-20250219' };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.22,
      usage: { input_tokens: 350, output_tokens: 65 },
      structured_output: {
        summary: 'Claude incremental fallback review',
        findings: [],
      },
    };
  };

  const result = await runGeminiReview({
    env: {
      GEMINI_API_KEY: 'test-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'valid-token',
      TARGET_REPO: 'owner/repo',
      PR_NUMBER: '1',
      HEAD_SHA: HEAD_A,
      REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl: mockFetch402,
    queryImpl: fakeClaude,
    logImpl: () => {},
  });

  assert.equal(result.summary, 'Claude incremental fallback review');
  assert.deepEqual(result.findings, []);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.fallback_from, 'gemini');
  assert.equal(result._meta.fallback_reason, 'HTTP 402');
  assert.equal(result._meta.total_cost_usd, 0.22);
  assert.equal(result._meta.cost_source, 'sdk');
  assert.equal(result._meta.resolved_model, 'claude-3-7-sonnet-20250219');
});

test('Integration: runGeminiShard honors env.GEMINI_MODEL in Full Review shards', async () => {
  let calledUrl = null;
  const mockFetch = async (url) => {
    calledUrl = url;
    return Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'custom model ok', findings: [], coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' } }) }] } }],
      usageMetadata: {},
    });
  };

  const outcome = await runGeminiShard({
    prompt: 'shard prompt',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    env: { GEMINI_API_KEY: 'key', GEMINI_MODEL: 'gemini-2.0-pro-exp-override' },
    fetchImpl: mockFetch,
  });

  assert.equal(outcome.kind, 'ok');
  assert.match(calledUrl, /\/models\/gemini-2\.0-pro-exp-override:generateContent$/);
  assert.equal(outcome.meta.requested_model, 'gemini-2.0-pro-exp-override');
});

test('Integration: runClaudeStructured preserves conservative reserve cost when SDK reports 0', async () => {
  const fakeZeroCostQuery = async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet' };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0, // explicit 0 from SDK
      structured_output: { summary: 'fallback zero cost' },
    };
  };

  const outcome = await runClaudeStructured({
    prompt: 'fallback prompt',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    timeoutMs: 5000,
    maxBudgetUsd: 1.0,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'valid-token' },
    queryImpl: fakeZeroCostQuery,
    logImpl: () => {},
  });

  assert.equal(outcome.structured.summary, 'fallback zero cost');
  assert.equal(outcome.meta.total_cost_usd, 0.5); // Fallback preserves conservative reserve
  assert.equal(outcome.meta.cost_source, 'reserve');
});

test('Full shard wrapper preserves failed outcome for an exhausted deadline without invoking Gemini', async () => {
  let requests = 0;
  const outcome = await runGeminiShard({
    prompt: 'full shard nearing deadline',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    timeoutMs: -30_000,
    env: { GEMINI_API_KEY: 'test-key' },
    fetchImpl: async () => {
      requests += 1;
      throw new Error('Should not fetch with expired deadline');
    },
  });
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error, /invalid or exhausted timeout budget/);
  assert.equal(requests, 0);
});

test('Integration E3: Full review with Tool Gateway preserves shard execution, coverage, and budget accounting', async () => {
  const { ReadOnlyToolGateway } = await import('../scripts/tool-gateway.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-gw-')), safe = path.join(tmp, 's'), ctx = path.join(tmp, 'c');
  fs.mkdirSync(safe); fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(safe, 'fileA.js'), 'export const a = 1;\n');
  const gw = new ReadOnlyToolGateway({ safeRoot: safe, contextRoot: ctx, cwd: tmp, maxCalls: 50 });
  const outcome = await getProviderAdapter(PROVIDER_KINDS.CLAUDE).execute({
    prompt: 'p',
    schema: { type: 'object', properties: { summary: { type: 'string' }, coverage: { type: 'object' } }, required: ['summary', 'coverage'] },
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    queryImpl: async function* ({ options }) {
      assert.deepEqual(options.tools, []);
      assert.ok(options.mcpServers && options.mcpServers.gateway);
      assert.deepEqual(options.allowedTools, ['mcp__gateway__Read', 'mcp__gateway__Glob', 'mcp__gateway__Grep']);
      assert.equal(options.permissionMode, 'dontAsk');
      assert.equal(options.strictMcpConfig, true);
      assert.deepEqual(options.settingSources, []);
      assert.equal((await options.canUseTool('mcp__gateway__Read', { file_path: path.join(safe, 'fileA.js') })).behavior, 'allow');
      assert.equal((await options.canUseTool('Read', { file_path: path.join(safe, 'fileA.js') })).behavior, 'deny');
      await options.mcpServers.gateway.instance?.close?.();
      yield { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.35, usage: { input_tokens: 1500, output_tokens: 250 }, structured_output: { summary: 'ok', coverage: { complete: true } } };
    },
    toolGateway: gw,
    tools: [],
  });
  assert.equal(outcome.ok && outcome.structured.coverage.complete, true);
  assert.equal(outcome.meta.total_cost_usd, 0.35);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Integration E4: Gemini shard review with Tool Gateway explores files and reports structured coverage', async () => {
  const { ReadOnlyToolGateway } = await import('../scripts/tool-gateway.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-shard-gw-'));
  const safe = path.join(tmp, 'safe-target');
  const ctx = path.join(tmp, '.review-context');
  fs.mkdirSync(safe, { recursive: true });
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(safe, 'service.js'), 'export function serve() { return 200; }\n');
  fs.writeFileSync(path.join(ctx, 'diff.txt'), 'diff --git a/service.js b/service.js\n');

  const gw = new ReadOnlyToolGateway({
    safeRoot: safe,
    contextRoot: ctx,
    cwd: tmp,
    allowedContextFiles: ['diff.txt'],
  });

  let turn = 0;
  const mockFetch = async () => {
    turn += 1;
    if (turn === 1) {
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'Read', args: { file_path: path.join(safe, 'service.js') }, id: 'read_srv' } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 25 },
        modelVersion: 'gemini-flash-latest',
      });
    }
    return Response.json({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                text: JSON.stringify({
                  summary: 'Service verified',
                  findings: [],
                  coverage: { complete: true, reviewedPaths: ['service.js'], unreviewedPaths: [], note: '' },
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 45 },
      modelVersion: 'gemini-flash-latest',
    });
  };

  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array' },
      coverage: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'] },
    },
    required: ['summary', 'findings', 'coverage'],
  };

  const outcome = await runGeminiShard({
    prompt: 'Review service.js with tools',
    schema,
    env: { GEMINI_API_KEY: 'test-key' },
    fetchImpl: mockFetch,
    toolGateway: gw,
  });

  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.structured.summary, 'Service verified');
  assert.equal(outcome.structured.coverage.complete, true);
  assert.equal(outcome.meta.num_turns, 2);
  assert.equal(outcome.meta.tool_calls, 1);
  assert.equal(gw.getDiagnostics().callCount, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});
