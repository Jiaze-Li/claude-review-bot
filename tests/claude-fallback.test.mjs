import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { isGeminiUnavailableStatus } from '../scripts/claude-fallback.mjs';

const A = 'a'.repeat(40);

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fallback-'));
  fs.writeFileSync(path.join(dir, 'pr.json'), '{}');
  fs.writeFileSync(path.join(dir, 'pr.diff'), 'diff --git a/a b/a\n');
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'discovery' }, session: null }));
  return dir;
}
const env = (dir, extra = {}) => ({ GEMINI_API_KEY: 'k', TARGET_REPO: 'a/b', PR_NUMBER: '1', HEAD_SHA: A, REVIEW_CONTEXT_DIR: dir, ...extra });

function fakeQuery(calls) {
  return async function* (args) {
    calls.push(args);
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
    yield { type: 'result', subtype: 'success', structured_output: { summary: 'from claude', findings: [] }, usage: { input_tokens: 5, output_tokens: 7 } };
  };
}

test('only credit/quota/outage statuses trigger the Claude fallback', () => {
  for (const s of [402, 429, 500, 503]) assert.equal(isGeminiUnavailableStatus(s), true);
  for (const s of [200, 400, 401, 403, 404]) assert.equal(isGeminiUnavailableStatus(s), false);
});

test('Gemini HTTP 402 falls back to Claude with no tools and the same output shape', async () => {
  const calls = [];
  const result = await runGeminiReview({
    env: env(ctx(), { CLAUDE_CODE_OAUTH_TOKEN: 't', GH_TOKEN: 'secret-gh' }),
    logImpl: () => {},
    fetchImpl: async () => new Response('{"error":{"message":"credits depleted"}}', { status: 402 }),
    queryImpl: fakeQuery(calls),
  });
  assert.equal(result.summary, 'from claude');
  assert.deepEqual(result.findings, []);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.resolved_model, 'claude-sonnet-x');
  assert.equal(result._meta.fallback_from, 'gemini');
  assert.equal(result._meta.mode, 'discovery');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.tools, []);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TMPDIR']);
  assert.equal(calls[0].options.outputFormat.type, 'json_schema');
});

test('Gemini auth errors also hand the review to Claude, and say why', async () => {
  const calls = [];
  const result = await runGeminiReview({
    env: env(ctx(), { CLAUDE_CODE_OAUTH_TOKEN: 't' }),
    logImpl: () => {},
    fetchImpl: async () => new Response('bad key', { status: 403 }),
    queryImpl: fakeQuery(calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.fallback_from, 'gemini');
  assert.equal(result._meta.fallback_reason, 'HTTP 403');
});

test('fallback without a Claude token fails clearly', async () => {
  await assert.rejects(
    runGeminiReview({
      env: env(ctx()),
      logImpl: () => {},
      fetchImpl: async () => new Response('x', { status: 429 }),
      queryImpl: fakeQuery([]),
    }),
    /CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test('malformed Claude fallback output is rejected rather than published', async () => {
  const bad = async function* () {
    yield { type: 'result', subtype: 'success', structured_output: { summary: 'no findings key' } };
  };
  await assert.rejects(
    runGeminiReview({
      env: env(ctx(), { CLAUDE_CODE_OAUTH_TOKEN: 't' }),
      logImpl: () => {},
      fetchImpl: async () => new Response('x', { status: 402 }),
      queryImpl: bad,
    }),
    /findings must be an array/,
  );
});

test('fallback reports a cost, charging a conservative default when the SDK gives none', async () => {
  const calls = [];
  const r = await runGeminiReview({
    env: env(ctx(), { CLAUDE_CODE_OAUTH_TOKEN: 't' }), logImpl: () => {},
    fetchImpl: async () => new Response('x', { status: 402 }), queryImpl: fakeQuery(calls),
  });
  assert.equal(r._meta.total_cost_usd, 0.5);
});

test('fallback is blocked once the per-PR Claude budget is exhausted', async () => {
  const dir = ctx();
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'session-plan.json'), 'utf8'));
  plan.session = { version: 1, baseSha: 'b'.repeat(40), lastReviewedHead: A, status: 'AUDIT_PENDING', findings: [], deepSpendUsd: 6 };
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify(plan));
  const calls = [];
  await assert.rejects(runGeminiReview({
    env: env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't' }), logImpl: () => {},
    fetchImpl: async () => new Response('x', { status: 402 }), queryImpl: fakeQuery(calls),
  }), /budget is exhausted/);
  assert.equal(calls.length, 0);
});
