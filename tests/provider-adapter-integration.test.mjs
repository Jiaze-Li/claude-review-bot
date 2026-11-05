import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview, buildGeminiRequest } from '../scripts/run-gemini-review.mjs';
import { runGeminiShard } from '../scripts/gemini-shard.mjs';
import { runClaudeStructured } from '../scripts/claude-fallback.mjs';
import { getProviderAdapter, PROVIDER_KINDS, OUTCOME_KINDS } from '../scripts/provider-adapter.mjs';

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
