import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeVerifications, runGeminiReview } from '../scripts/run-gemini-review.mjs';

const A = 'a'.repeat(40);

// A diff of `count` files of about `bytes` each, so a handful of them overflow one request.
function bigDiff(count, bytes = 60_000) {
  return Array.from({ length: count }, (_, i) => {
    const name = `src/m${String(i).padStart(2, '0')}/f.swift`;
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${'x'.repeat(bytes)}\n`;
  }).join('');
}

function setup({ mode = 'audit', diff, session = null, files = 8 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-parts-'));
  fs.writeFileSync(path.join(dir, 'pr.json'), '{}');
  fs.writeFileSync(path.join(dir, mode === 'verification' || mode === 'incremental' ? 'repair.diff' : 'pr.diff'), diff ?? bigDiff(files));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode }, session, requestedMode: 'auto' }));
  return dir;
}

const env = (dir, extra = {}) => ({ GEMINI_API_KEY: 'k', TARGET_REPO: 'a/b', PR_NUMBER: '1', HEAD_SHA: A, REVIEW_CONTEXT_DIR: dir, SOURCE_KIND: 'comment', ...extra });
const filesIn = (text) => [...new Set([...text.matchAll(/diff --git a\/(\S+) b\//g)].map((m) => m[1]))];
const finding = (severity, title, p = 'src/m00/f.swift') => ({ severity, title, body: 'b', path: p, line: null, riskClass: 'x', failurePath: 'a concrete trigger state leads to a wrong result here' });
const geminiReply = (obj) => async (url, init) => {
  const prompt = JSON.parse(init.body).contents[0].parts[0].text;
  const reply = typeof obj === 'function' ? obj(filesIn(prompt)) : obj;
  if (reply.status) return new Response('{"error":"x"}', { status: reply.status });
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: 'gemini-x' });
};
function claudeQuery(calls, reply = () => ({ summary: 'from claude', findings: [] })) {
  return async function* (args) {
    calls.push(filesIn(args.prompt));
    yield { type: 'system', subtype: 'init', model: 'claude-x' };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.2, structured_output: reply(filesIn(args.prompt)), usage: { input_tokens: 3, output_tokens: 4 } };
  };
}

test('a large final-audit diff is split into parts, each reviewed by Gemini, and merged into one result', async () => {
  const dir = setup({ mode: 'audit' });
  const prompts = [];
  const result = await runGeminiReview({
    env: env(dir), logImpl: () => {},
    fetchImpl: async (url, init) => {
      const files = filesIn(JSON.parse(init.body).contents[0].parts[0].text);
      prompts.push(files);
      return geminiReply({ summary: `ok ${files[0]}`, findings: [finding('P3', 'Same nit'), finding('P2', `Bug in ${files[0]}`, files[0])] })(url, init);
    },
  });
  assert.ok(prompts.length >= 4, `parts: ${prompts.length}`);
  assert.deepEqual(prompts.flat().sort(), Array.from({ length: 8 }, (_, i) => `src/m0${i}/f.swift`));
  assert.equal(result._meta.provider, 'gemini');
  assert.equal(result._meta.parts, prompts.length);
  assert.match(result.summary, /Part 1\/\d+: ok /);
  // duplicates collapse, material findings come first, and the session limit of 6 is respected
  assert.equal(new Set(result.findings.map((f) => f.title)).size, result.findings.length);
  assert.equal(result.findings.length, 6);
  assert.ok(result.findings.every((f) => f.severity === 'P2'));
  assert.match(result.summary, /more material finding\(s\) were omitted/);
});

test('Gemini out of credits partway: the rest of the parts go straight to Claude, with costs recorded', async () => {
  const dir = setup({ mode: 'audit' });
  let fetches = 0;
  const calls = [];
  const result = await runGeminiReview({
    env: env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't' }), logImpl: () => {},
    fetchImpl: async (url, init) => {
      fetches += 1;
      return fetches <= 1 ? geminiReply({ summary: 'gemini part', findings: [] })(url, init) : geminiReply({ status: 402 })(url, init);
    },
    queryImpl: claudeQuery(calls),
  });
  assert.ok(fetches <= 4, `gemini requests after 402 stop: ${fetches}`);
  assert.ok(calls.length >= 3);
  assert.equal(result._meta.provider, 'claude');
  assert.equal(result._meta.fallback_from, 'gemini');
  assert.equal(result._meta.parts_by_claude, calls.length);
  assert.equal(result._meta.total_cost_usd, Number((0.2 * calls.length).toFixed(4)));
  assert.equal(result._meta.cost_source, 'sdk');
  assert.match(result._meta.fallback_reason, /HTTP 402/);
});

test('every part falls to Claude when Gemini is down from the first request', async () => {
  const dir = setup({ mode: 'incremental', files: 6 });
  const calls = [];
  const result = await runGeminiReview({
    env: env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't' }), logImpl: () => {},
    fetchImpl: geminiReply({ status: 503 }), queryImpl: claudeQuery(calls),
  });
  assert.deepEqual(calls.flat().sort(), Array.from({ length: 6 }, (_, i) => `src/m0${i}/f.swift`));
  assert.equal(result._meta.parts_by_claude, result._meta.parts);
});

test('an automatic review cannot spend past the Claude allowance across parts, and what was spent is recorded', async () => {
  const dir = setup({ mode: 'audit', session: { version: 1, deepSpendUsd: 5.6, findings: [] } });
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'audit' }, session: { version: 1, deepSpendUsd: 5.6, findings: [] }, requestedMode: 'auto' }));
  await assert.rejects(runGeminiReview({
    env: env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't', SOURCE_KIND: 'pull_request' }), logImpl: () => {},
    fetchImpl: geminiReply({ status: 402 }), queryImpl: claudeQuery([]),
  }), /automatic budget is exhausted or insufficient/);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'fallback-unavailable.json'), 'utf8'));
  assert.match(marker.reason, /Claude budget exhausted/);
});

test('a manual review keeps the whole run within one $5 Claude budget across parts, however many parts there are', async () => {
  const dir = setup({ mode: 'audit', files: 12 });
  const budgets = [];
  const result = await runGeminiReview({
    env: env(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't' }), logImpl: () => {},
    fetchImpl: geminiReply({ status: 402 }),
    queryImpl: async function* (args) {
      budgets.push(args.options.maxBudgetUsd);
      yield { type: 'system', subtype: 'init', model: 'claude-x' };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.4, structured_output: { summary: 's', findings: [] }, usage: {} };
    },
  });
  assert.ok(budgets.length >= 6);
  assert.ok(budgets.every((b) => b <= 1.0 + 1e-9), JSON.stringify(budgets));
  assert.equal(result._meta.parts_by_claude, budgets.length);
  assert.ok(result._meta.total_cost_usd <= 5);
});

test('verification across parts: the verdict comes from the parts that contain the finding\'s file, worst first', () => {
  const session = { findings: [{ id: 'F001', path: 'src/a.swift' }, { id: 'F002', path: 'src/b.swift' }, { id: 'F003', path: 'src/unseen.swift' }] };
  const parts = [{ files: ['src/a.swift'] }, { files: ['src/b.swift'] }];
  const results = [
    { verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'a fixed' }, { findingId: 'F002', status: 'UNCERTAIN', reason: 'cannot see b' }, { findingId: 'F003', status: 'FIXED', reason: 'ok' }], findings: [finding('P2', 'regression a')] },
    { verifications: [{ findingId: 'F001', status: 'STILL_OPEN', reason: 'not my file' }, { findingId: 'F002', status: 'STILL_OPEN', reason: 'b still broken' }, { findingId: 'F003', status: 'UNCERTAIN', reason: 'maybe' }], findings: [finding('P2', 'regression a')] },
  ];
  const merged = mergeVerifications({ session, parts, results });
  const by = Object.fromEntries(merged.verifications.map((v) => [v.findingId, v]));
  assert.equal(by.F001.status, 'FIXED'); // only the part holding a.swift counts
  assert.equal(by.F002.status, 'STILL_OPEN'); // part holding b.swift says so
  assert.equal(by.F003.status, 'UNCERTAIN'); // file in no part: worst of all rulings
  assert.equal(merged.findings.length, 1); // duplicate regression collapsed
});

test('a delta too large for the part limit fails with a pointer to .reviewbotignore instead of truncating', async () => {
  const dir = setup({ mode: 'verification', diff: bigDiff(30, 110_000), session: { version: 1, findings: [] } });
  await assert.rejects(runGeminiReview({ env: env(dir), logImpl: () => {}, fetchImpl: geminiReply({ summary: 's', verifications: [], findings: [] }) }), /too many parts.*reviewbotignore/);
});

test('a small diff is still one request over the original diff, untouched', async () => {
  const dir = setup({ mode: 'audit', diff: bigDiff(2, 1_000) });
  let requests = 0;
  const result = await runGeminiReview({ env: env(dir), logImpl: () => {}, fetchImpl: async (url, init) => { requests += 1; return geminiReply({ summary: 'one', findings: [] })(url, init); } });
  assert.equal(requests, 1);
  assert.equal(result._meta.parts, undefined);
});

test('files matched by .reviewbotignore are not counted toward the staged parts', async () => {
  const file = (name, bytes) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${'x'.repeat(bytes)}\n`;
  const diff = Array.from({ length: 30 }, (_, i) => file(`gen/f${i}.json`, 90_000)).join('') + file('src/a.js', 100);
  const dir = setup({ diff });
  fs.writeFileSync(path.join(dir, 'ignore-patterns.txt'), 'gen/*\n');
  const prompts = [];
  const reply = geminiReply({ summary: 's', verifications: [], findings: [] });
  await runGeminiReview({ env: env(dir), logImpl: () => {}, fetchImpl: async (url, init) => { prompts.push(JSON.parse(init.body).contents[0].parts[0].text); return reply(url, init); } });
  assert.equal(prompts.length, 1);
  assert.deepEqual(filesIn(prompts[0]), ['src/a.js']);
});
