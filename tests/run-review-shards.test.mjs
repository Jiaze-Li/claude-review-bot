import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Runs the real run-review.mjs against a fake Agent SDK so the shard loop, merge and
// usage accounting are exercised end to end without any model call.
const FAKE_SDK = `
import fs from 'node:fs';
let call = 0;
let cur = 0;
let max = 0;
export async function* query({ prompt, options }) {
  call += 1;
  const myCall = call;
  const mode = process.env.FAKE_MODE || 'ok';
  let files = [...prompt.matchAll(/^- (\\S+)$/gm)].map((m) => m[1]).filter((f) => f !== 'pr.diff' && f !== 'changed-files.txt' && f !== 'diff-stat.txt' && f !== 'pr.json' && f !== 'skipped-files.txt');
  if (!files.length) files = fs.readFileSync('.review-context/changed-files.txt', 'utf8').split('\\n').filter(Boolean);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ call: myCall, turns: options.maxTurns, budget: options.maxBudgetUsd, files, known: prompt.includes('ALREADY EXAMINED') }) + '\\n');
  cur += 1;
  max = Math.max(max, cur);
  fs.writeFileSync(process.env.FAKE_LOG + '.max', String(max));
  if (process.env.FAKE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY)));
  cur -= 1;
  yield { type: 'system', subtype: 'init', model: 'claude-fake' };
  if (mode === 'all-fail' || (mode === 'second-fails' && myCall === 2)) {
    yield { type: 'result', subtype: 'error_max_turns', num_turns: options.maxTurns, total_cost_usd: 0.4, errors: ['turn limit'] };
    return;
  }
  yield { type: 'result', subtype: 'success', num_turns: 5, total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 5 },
    structured_output: { summary: 'shard ' + myCall + ' ok', findings: myCall === 1 ? [{ severity: 'P2', title: 'Real bug', body: 'b', path: files[0] ?? 'x', line: null }] : [],
      coverage: { complete: true, reviewedPaths: files, unreviewedPaths: [], note: '' } } };
}
`;

function setup(fileSizes, session = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['run-review.mjs', 'review-shards.mjs', 'review-session-core.mjs']) fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
  const sdk = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', main: 'index.js', exports: './index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), FAKE_SDK);
  fs.mkdirSync(path.join(root, 'safe-target'));
  fs.mkdirSync(path.join(root, '.review-context'));
  if (session) fs.writeFileSync(path.join(root, '.review-context/session-plan.json'), JSON.stringify({ session }));
  const names = Object.keys(fileSizes);
  fs.writeFileSync(path.join(root, '.review-context/changed-files.txt'), names.join('\n') + '\n');
  fs.writeFileSync(path.join(root, '.review-context/pr.diff'), names.map((n) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1 +1 @@\n+${'x'.repeat(fileSizes[n])}\n`).join(''));
  return root;
}

function run(root, mode = 'ok', extraEnv = {}) {
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  const result = spawnSync(process.execPath, ['scripts/run-review.mjs'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, TARGET_REPO: 'a/b', PR_NUMBER: '7', HEAD_SHA: 'a'.repeat(40), DEEP_REVIEW_MAX_BUDGET_USD: '5', FAKE_MODE: mode, FAKE_LOG: log, ...extraEnv },
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const outPath = path.join(root, '.review-context/review.json');
  return { result, calls, review: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null,
    usage: JSON.parse(fs.readFileSync(path.join(root, '.review-context/claude-usage.json'), 'utf8')) };
}

test('a small PR is one review pass over pr.diff with complete coverage', () => {
  const root = setup({ 'a.swift': 100, 'b.swift': 100 });
  const { result, calls, review } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.equal(review.coverage.complete, true);
  assert.deepEqual(review.coverage.unreviewedPaths, []);
  assert.equal(review._meta.shards, 1);
});

test('a large PR is split into shards, each assigned only its own files, and merged with complete coverage', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000 });
  const { result, calls, review, usage } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.flatMap((c) => c.files).sort(), ['a/1.swift', 'b/2.swift', 'c/3.swift']);
  assert.ok(calls.every((c) => c.files.length === 1 && c.turns === 14));
  assert.equal(review.coverage.complete, true);
  assert.equal(review._meta.shards, 3);
  assert.equal(review.findings.length, 1);
  assert.equal(usage.total_cost_usd, 0.75);
  assert.ok(fs.existsSync(path.join(root, '.review-context/shards/shard-1.diff')));
});

test('a shard that hits its turn limit makes the review PARTIAL, names its files, and still charges its cost', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000 });
  const { result, review, usage } = run(root, 'second-fails');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(review.coverage.complete, false);
  assert.equal(review.coverage.unreviewedPaths.length, 1);
  assert.match(review.summary, /PARTIAL/);
  assert.equal(usage.total_cost_usd, 0.9);
});

test('when the budget runs out, remaining shards are not started and are reported unreviewed', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000 });
  const { result, calls, review } = run(root, 'ok', { DEEP_REVIEW_MAX_BUDGET_USD: '0.5' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.equal(review.coverage.complete, false);
  assert.equal(review.coverage.unreviewedPaths.length, 2);
});

test('if no shard completes the run fails closed and still records the spend', () => {
  const root = setup({ 'a.swift': 100 });
  const { result, review, usage } = run(root, 'all-fail');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no shard completed/);
  assert.equal(review, null);
  assert.equal(usage.subtype, 'error');
  assert.equal(usage.total_cost_usd, 0.4);
});

test('earlier dismissals are shown to every shard and an exact repeat is dropped from the result', () => {
  const session = { findings: [{ id: 'F001', status: 'DISMISSED', path: 'a/1.swift', title: 'Real bug', resolutionReason: 'Dismissed by @x: accepted product decision' }], dismissed: [] };
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000 }, session);
  const { result, calls, review } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.length === 2 && calls.every((c) => c.known));
  assert.deepEqual(review.findings, []);
  assert.match(review.summary, /1 finding\(s\) matching earlier dismissals were not repeated/);
});

test('without earlier dismissals the same finding is kept', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000 });
  const { calls, review } = run(root);
  assert.ok(calls.every((c) => !c.known));
  assert.equal(review.findings.length, 1);
});

test('shards run concurrently up to the limit and the summary reports reviewed/assigned per shard', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000, 'd/4.swift': 100_000 });
  const { result, calls, review } = run(root, 'ok', { FAKE_DELAY: '200' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 4);
  const max = Number(fs.readFileSync(path.join(root, 'calls.log.max'), 'utf8'));
  assert.ok(max >= 2 && max <= 3, `max concurrency ${max}`);
  assert.match(review.summary, /Shards \(reviewed\/assigned\): 1: ok 1\/1 · 2: ok 1\/1 · 3: ok 1\/1 · 4: ok 1\/1/);
  assert.equal(review._meta.shards, 4);
  assert.equal(review._meta.shards_run, 4);
});

test('concurrent shards still share one budget: nothing is started once it is spent', () => {
  const root = setup({ 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000, 'd/4.swift': 100_000 });
  const { result, calls, review, usage } = run(root, 'ok', { DEEP_REVIEW_MAX_BUDGET_USD: '1', FAKE_DELAY: '100' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.length < 4);
  assert.equal(review.coverage.complete, false);
  assert.ok(usage.total_cost_usd <= 1);
});
