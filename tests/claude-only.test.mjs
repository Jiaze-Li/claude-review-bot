import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { publishRunStatus } from '../scripts/review-status.mjs';

const A = 'a'.repeat(40);

function setup({ requestedMode, mode = 'audit', diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n+x\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-only-'));
  fs.writeFileSync(path.join(dir, 'pr.json'), '{}');
  fs.writeFileSync(path.join(dir, 'pr.diff'), diff);
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode }, session: null, requestedMode }));
  return dir;
}
const env = (dir, extra = {}) => ({ TARGET_REPO: 'a/b', PR_NUMBER: '1', HEAD_SHA: A, REVIEW_CONTEXT_DIR: dir, SOURCE_KIND: 'comment', CLAUDE_CODE_OAUTH_TOKEN: 't', ...extra });
const claude = (calls) => async function* (args) {
  calls.push(args);
  yield { type: 'system', subtype: 'init', model: 'claude-x' };
  yield { type: 'result', subtype: 'success', total_cost_usd: 0.2, structured_output: { summary: 'from claude', findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
};
const neverGemini = async () => { throw new Error('Gemini must not be called when Claude was requested'); };

test('@claude review runs the same review with Claude alone: no Gemini key needed, no Gemini call, no "fallback from gemini"', async () => {
  const calls = [];
  const result = await runGeminiReview({ env: env(setup({ requestedMode: 'claude' })), logImpl: () => {}, fetchImpl: neverGemini, queryImpl: claude(calls) });
  assert.equal(calls.length, 1);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.mode, 'audit');
  assert.equal(result._meta.fallback_from, undefined);
  assert.equal(result._meta.fallback_reason, undefined);
});

test('the same review asked with @gemini review still goes to Gemini first', async () => {
  let gemini = 0;
  const result = await runGeminiReview({
    env: env(setup({ requestedMode: 'auto' }), { GEMINI_API_KEY: 'k' }), logImpl: () => {},
    fetchImpl: async () => { gemini += 1; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'from gemini', findings: [] }) }] } }], usageMetadata: {} }); },
    queryImpl: claude([]),
  });
  assert.equal(gemini, 1);
  assert.equal(result._meta.provider, 'gemini');
});

test('a large diff under @claude review is split into parts all reviewed by Claude, with the one-call budget respected', async () => {
  const big = Array.from({ length: 6 }, (_, i) => `diff --git a/f${i}.js b/f${i}.js\n--- a/f${i}.js\n+++ b/f${i}.js\n@@ -1 +1 @@\n+${'x'.repeat(70_000)}\n`).join('');
  const calls = [];
  const result = await runGeminiReview({ env: env(setup({ requestedMode: 'claude', diff: big })), logImpl: () => {}, fetchImpl: neverGemini, queryImpl: claude(calls) });
  assert.ok(calls.length >= 3);
  assert.equal(result._meta.parts, calls.length);
  assert.equal(result._meta.parts_by_claude, calls.length);
  assert.equal(result._meta.fallback_from, undefined);
  assert.ok(calls.every((c) => c.options.maxBudgetUsd <= 1.0 + 1e-9));
});

test('the status comment names the model that was asked for', async () => {
  const bodies = [];
  const base = { GITHUB_ACTIONS: 'true', TARGET_REPO: 'a/b', GITHUB_REPOSITORY: 'c/d', PR_NUMBER: '7', SOURCE_COMMENT_ID: '9', SOURCE_KIND: 'comment', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', HEAD_SHA: A, REVIEW_MODE: 'verification', REVIEW_REASON: 'r', STATUS_STAGE: 'started', PREFLIGHT_OUTCOME: 'success', GH_TOKEN: 't' };
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body).body); return Response.json({ id: 7 }); };
  await publishRunStatus({ env: { ...base, REQUESTED_MODE: 'claude' }, fetchImpl });
  await publishRunStatus({ env: { ...base, REQUESTED_MODE: 'auto' }, fetchImpl });
  assert.match(bodies[0], /Claude targeted verification is running/);
  assert.match(bodies[1], /Gemini targeted verification is running/);
});

test('the workflow lets the automatic final audit keep an @claude review command', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.match(yml, /"\$requested_mode" == "claude"/);
});
