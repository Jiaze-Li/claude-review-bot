import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_SHARD_MAX_BYTES, geminiBaseUrl, runGeminiShard } from '../scripts/gemini-shard.mjs';

const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const ok = (text, extra = {}) => async () => Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }, modelVersion: 'gemini-x', ...extra });
const status = (code) => async () => new Response('{"error":"x"}', { status: code });
const env = { GEMINI_API_KEY: 'k' };

test('a good response is returned with Claude-ledger cost 0 and token usage', async () => {
  const out = await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: ok('{"summary":"hi"}') });
  assert.equal(out.kind, 'ok');
  assert.equal(out.structured.summary, 'hi');
  assert.equal(out.meta.total_cost_usd, 0);
  assert.equal(out.meta.provider, 'gemini');
  assert.equal(out.meta.resolved_model, 'gemini-x');
  assert.deepEqual([out.meta.usage.input_tokens, out.meta.usage.output_tokens], [7, 3]);
});

test('HTTP failures are classified: unavailable switches Gemini off, config switches it off, other is shard-local', async () => {
  for (const code of [402, 429, 500, 503]) assert.equal((await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: status(code) })).kind, 'unavailable', String(code));
  for (const code of [400, 401, 403, 404]) assert.equal((await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: status(code) })).kind, 'config', String(code));
  assert.equal((await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: status(408) })).kind, 'failed');
  assert.equal((await runGeminiShard({ prompt: 'p', schema, env: {}, fetchImpl: ok('{}') })).kind, 'config');
});

test('network errors and timeouts fail the shard, and malformed output is retried once', async () => {
  const net = await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(net.kind, 'failed');
  assert.match(net.error, /socket hang up/);
  const timeout = await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, timeoutMs: 5 });
  assert.match(timeout.error, /timed out after 5ms/);
  let calls = 0;
  const flaky = await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: async () => (++calls === 1 ? ok('not json')() : ok('{"summary":"second try"}')()) });
  assert.equal(flaky.kind, 'ok');
  assert.equal(calls, 2);
  calls = 0;
  const bad = await runGeminiShard({ prompt: 'p', schema, env, fetchImpl: async () => { calls += 1; return ok('nope')(); } });
  assert.equal(bad.kind, 'failed');
  assert.equal(calls, 2);
});

test('the API key only ever goes to the Gemini host or a local test server', () => {
  assert.equal(geminiBaseUrl({}), 'https://generativelanguage.googleapis.com');
  assert.equal(geminiBaseUrl({ GEMINI_API_BASE_URL: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
  assert.throws(() => geminiBaseUrl({ GEMINI_API_BASE_URL: 'https://evil.example.com' }), /must be the Gemini API host/);
  assert.throws(() => geminiBaseUrl({ GEMINI_API_BASE_URL: 'http://127.0.0.1.evil.com:80' }), /must be the Gemini API host/);
  assert.ok(GEMINI_SHARD_MAX_BYTES > 100_000);
});

test('the deep review step receives the provider list and the Gemini key, but never the GitHub token', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const start = yml.indexOf('- name: Run Claude explicit deep review');
  const block = yml.slice(start, yml.indexOf('- name: Publish Claude explicit deep review'));
  assert.match(block, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(block, /REVIEW_PROVIDERS: \$\{\{ steps\.begin-deep\.outputs\.providers \}\}/);
  assert.doesNotMatch(block, /GH_TOKEN|app-token\.outputs\.token/);
});
