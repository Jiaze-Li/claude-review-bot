import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathKey } from '../scripts/review-session-core.mjs';

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

function setup(fileSizes, session = null, ignore = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['run-review.mjs', 'review-shards.mjs', 'review-session-core.mjs', 'gemini-shard.mjs', 'run-gemini-review.mjs', 'claude-fallback.mjs']) fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
  const sdk = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', main: 'index.js', exports: './index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), FAKE_SDK);
  fs.mkdirSync(path.join(root, 'safe-target'));
  fs.mkdirSync(path.join(root, '.review-context'));
  if (session) fs.writeFileSync(path.join(root, '.review-context/session-plan.json'), JSON.stringify({ session }));
  if (ignore !== null) fs.writeFileSync(path.join(root, '.review-context/ignore-patterns.txt'), ignore);
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
  assert.match(review.summary, /Shards \(reviewed\/assigned\): 1: claude ok 1\/1 · 2: claude ok 1\/1 · 3: claude ok 1\/1 · 4: claude ok 1\/1/);
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

test('files matching the base-commit ignore list are skipped, not assigned, and not counted as unreviewed', () => {
  const root = setup({ 'Sources/A.swift': 100, 'package-lock.json': 100, 'img/logo.png': 100 }, null, '*.json\n');
  const { result, calls, review } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.flatMap((c) => c.files), ['Sources/A.swift']);
  assert.equal(review.coverage.complete, true);
  assert.equal(review._meta.ignored_files, 2);
  assert.match(review.summary, /2 more file\(s\) skipped by ignore rules/);
});

test('a second run on the same HEAD reviews only the files the first run did not reach', () => {
  const session = { coverage: { head: 'a'.repeat(40), complete: false, reviewedKeys: [] }, findings: [], dismissed: [] };
  const names = ['a/1.swift', 'b/2.swift', 'c/3.swift'];
  session.coverage.reviewedKeys = names.slice(0, 2).map(pathKey);
  const root = setup({ 'a/1.swift': 100, 'b/2.swift': 100, 'c/3.swift': 100 }, session);
  const { result, calls, review } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.flatMap((c) => c.files), ['c/3.swift']);
  assert.equal(review.coverage.complete, true);
  assert.deepEqual(review.coverage.reviewedPaths.sort(), names);
  assert.match(review.summary, /Reviewed 3 of 3 changed file\(s\) in 1 shard\(s\) \(2 already covered by an earlier run on this HEAD\)/);
});

test('coverage recorded for a different HEAD is not reused', () => {
  const session = { coverage: { head: 'b'.repeat(40), complete: false, reviewedKeys: ['a/1.swift'].map(pathKey) }, findings: [], dismissed: [] };
  const root = setup({ 'a/1.swift': 100 }, session);
  const { calls } = run(root);
  assert.deepEqual(calls.flatMap((c) => c.files), ['a/1.swift']);
});

test('when every file is already covered no model is called and the review is complete', () => {
  const names = ['a/1.swift', 'b/2.swift'];
  const session = { coverage: { head: 'a'.repeat(40), complete: false, reviewedKeys: names.map(pathKey) }, findings: [], dismissed: [] };
  const root = setup({ 'a/1.swift': 100, 'b/2.swift': 100 }, session);
  const { result, calls, review, usage } = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 0);
  assert.equal(review.coverage.complete, true);
  assert.equal(usage.total_cost_usd, 0);
  assert.equal(usage.subtype, 'success');
});

// ---- Gemini as the first provider (a local server stands in for the Gemini API) ----

async function withGemini(behavior, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const prompt = JSON.parse(body).contents[0].parts[0].text;
      const files = [...(prompt.split('Assigned files:')[1] ?? '').split('\n\n')[0].matchAll(/^- (\S+)$/gm)].map((m) => m[1]);
      requests.push({ files, hasKnown: prompt.includes('ALREADY EXAMINED'), inlineDiff: /<<<DIFF-/.test(prompt) });
      const answer = behavior(requests.length, files);
      if (answer.status) {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'nope' } }));
        return;
      }
      const text = answer.text ?? JSON.stringify({ summary: 'gemini ok', findings: [], coverage: { complete: true, reviewedPaths: files, unreviewedPaths: [], note: '' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }, modelVersion: 'gemini-fake-1' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn({ requests, base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runAsync(root, base, extraEnv = {}) {
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-review.mjs'], {
      cwd: root,
      env: { ...process.env, TARGET_REPO: 'a/b', PR_NUMBER: '7', HEAD_SHA: 'a'.repeat(40), DEEP_REVIEW_MAX_BUDGET_USD: '5', FAKE_LOG: log,
        REVIEW_PROVIDERS: 'gemini,claude', GEMINI_API_KEY: 'k', GEMINI_API_BASE_URL: base, ...extraEnv },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const outPath = path.join(root, '.review-context/review.json');
      resolve({ status, stderr, calls, review: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null,
        usage: JSON.parse(fs.readFileSync(path.join(root, '.review-context/claude-usage.json'), 'utf8')),
        reason: fs.existsSync(path.join(root, '.review-context/failure-reason.txt')) ? fs.readFileSync(path.join(root, '.review-context/failure-reason.txt'), 'utf8') : '' });
    });
  });
}

const BIG = { 'a/1.swift': 100_000, 'b/2.swift': 100_000, 'c/3.swift': 100_000, 'd/4.swift': 100_000 };

test('Gemini first: when Gemini reviews every shard Claude is never called and the Claude ledger is charged nothing', async () => {
  await withGemini(() => ({}), async ({ requests, base }) => {
    const root = setup(BIG);
    const out = await runAsync(root, base);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.calls.length, 0);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((r) => r.inlineDiff && r.files.length === 1));
    assert.equal(out.review.coverage.complete, true);
    assert.deepEqual(out.review._meta.providers, { gemini: 4 });
    assert.equal(out.usage.total_cost_usd, 0);
    assert.equal(out.usage.subtype, 'success');
    assert.match(out.review.summary, /1: gemini ok 1\/1/);
  });
});

test('a small PR takes the same route: one Gemini shard', async () => {
  await withGemini(() => ({}), async ({ requests, base }) => {
    const root = setup({ 'a.swift': 100, 'b.swift': 100 });
    const out = await runAsync(root, base);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].files, ['a.swift', 'b.swift']);
    assert.equal(out.calls.length, 0);
    assert.equal(out.review.coverage.complete, true);
  });
});

test('Gemini out of credits (402): Claude reviews every shard, and the review says so', async () => {
  await withGemini(() => ({ status: 402 }), async ({ requests, base }) => {
    const root = setup(BIG);
    const out = await runAsync(root, base);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(requests.length >= 1 && requests.length <= 3, `gemini requests: ${requests.length}`);
    assert.deepEqual(out.calls.flatMap((c) => c.files).sort(), Object.keys(BIG));
    assert.equal(out.review.coverage.complete, true);
    assert.deepEqual(out.review._meta.providers, { claude: 4 });
    assert.match(out.review.summary, /Gemini could not finish 4 shard\(s\) \(gemini: Gemini HTTP 402/);
    assert.ok(out.usage.total_cost_usd > 0);
  });
});

test('Gemini fails partway (429 after two shards): Claude continues with the remaining shards', async () => {
  await withGemini((n) => (n <= 2 ? {} : { status: 429 }), async ({ base }) => {
    const root = setup({ ...BIG, 'e/5.swift': 100_000, 'f/6.swift': 100_000 });
    const out = await runAsync(root, base, { DEEP_REVIEW_SHARD_CONCURRENCY: '1' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.review.coverage.complete, true);
    assert.deepEqual(out.review._meta.providers, { gemini: 2, claude: 4 });
    assert.deepEqual(out.calls.flatMap((c) => c.files).sort(), ['c/3.swift', 'd/4.swift', 'e/5.swift', 'f/6.swift']);
  });
});

test('a bad Gemini key (401) is not retried shard after shard: Claude takes over, loudly', async () => {
  await withGemini(() => ({ status: 401 }), async ({ requests, base }) => {
    const root = setup(BIG);
    const out = await runAsync(root, base, { DEEP_REVIEW_SHARD_CONCURRENCY: '1' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 1);
    assert.equal(out.review.coverage.complete, true);
    assert.match(out.review.summary, /Gemini could not finish/);
  });
});

test('malformed Gemini output fails that shard to Claude; two such failures switch Gemini off', async () => {
  await withGemini(() => ({ text: 'not json' }), async ({ requests, base }) => {
    const root = setup(BIG);
    const out = await runAsync(root, base, { DEEP_REVIEW_SHARD_CONCURRENCY: '1' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 4); // 2 shards x (try + one retry), then Gemini is off
    assert.equal(out.calls.length, 4);
    assert.equal(out.review.coverage.complete, true);
  });
});

test('an explicit @claude review (providers=claude) never calls Gemini', async () => {
  await withGemini(() => ({}), async ({ requests, base }) => {
    const root = setup(BIG);
    const out = await runAsync(root, base, { REVIEW_PROVIDERS: 'claude' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 0);
    assert.equal(out.calls.length, 4);
  });
});

test('no Gemini key configured: Claude reviews, and the summary says why', async () => {
  await withGemini(() => ({}), async ({ requests, base }) => {
    const root = setup({ 'a.swift': 100 });
    const out = await runAsync(root, base, { GEMINI_API_KEY: '' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 0);
    assert.match(out.review.summary, /GEMINI_API_KEY is not configured/);
  });
});

test('Gemini only (Claude allowance spent) and Gemini down: fails closed with a reason that tells you what to do', async () => {
  await withGemini(() => ({ status: 503 }), async ({ base }) => {
    const root = setup({ 'a.swift': 100 });
    const out = await runAsync(root, base, { REVIEW_PROVIDERS: 'gemini' });
    assert.notEqual(out.status, 0);
    assert.equal(out.review, null);
    assert.match(out.reason, /comment `@claude review` to continue manually/);
    assert.equal(out.usage.subtype, 'error');
  });
});

test('known issues reach Gemini shards too', async () => {
  const session = { findings: [{ id: 'F001', status: 'DISMISSED', path: 'a.swift', title: 'Accepted decision', resolutionReason: 'Dismissed by @x: accepted' }], dismissed: [] };
  await withGemini(() => ({}), async ({ requests, base }) => {
    const root = setup({ 'a.swift': 100 }, session);
    const out = await runAsync(root, base);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(requests.every((r) => r.hasKnown));
  });
});

test('a Gemini shard that credits fewer files than assigned is not accepted: Claude takes exactly the files it left', async () => {
  const geminiLeavesLast = (n, files) => ({
    text: JSON.stringify({
      summary: 'gemini part',
      findings: [{ severity: 'P3', title: 'Gemini nit', body: 'b', path: files[0], line: null, failurePath: '' }],
      coverage: { complete: false, reviewedPaths: files.slice(0, -1), unreviewedPaths: files.slice(-1), note: 'cannot see the callers' },
    }),
  });
  await withGemini(geminiLeavesLast, async ({ requests, base }) => {
    // one shard holding three small files
    const root = setup({ 'a/1.swift': 100, 'a/2.swift': 100, 'a/3.swift': 100 });
    const out = await runAsync(root, base);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(requests.length, 1);
    assert.deepEqual(out.calls.flatMap((c) => c.files), ['a/3.swift']); // only what Gemini left
    assert.equal(out.review.coverage.complete, true);
    assert.deepEqual(out.review.coverage.reviewedPaths.sort(), ['a/1.swift', 'a/2.swift', 'a/3.swift']);
    assert.match(out.review.summary, /1: gemini\+claude ok 3\/3/);
    assert.match(out.review.summary, /Gemini could not finish 1 shard\(s\) \(gemini: 1 of 3 file\(s\) not covered/);
    assert.deepEqual(out.review._meta.providers, { 'gemini+claude': 1 });
    assert.ok(out.review.findings.some((f) => f.title === 'Gemini nit'));
    assert.ok(fs.existsSync(path.join(root, '.review-context/shards/shard-1-rest.diff')));
  });
});

test('if Claude cannot take what Gemini left, the shard keeps Gemini\'s work and the files stay unreviewed', async () => {
  await withGemini((n, files) => ({
    text: JSON.stringify({ summary: 'g', findings: [], coverage: { complete: false, reviewedPaths: files.slice(0, 1), unreviewedPaths: files.slice(1), note: '' } }),
  }), async ({ base }) => {
    const root = setup({ 'a/1.swift': 100, 'a/2.swift': 100 });
    const out = await runAsync(root, base, { FAKE_MODE: 'all-fail' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.review.coverage.complete, false);
    assert.deepEqual(out.review.coverage.unreviewedPaths, ['a/2.swift']);
    assert.match(out.review.summary, /PARTIAL/);
  });
});

test('with no later provider, incomplete coverage from the only provider stays partial', async () => {
  await withGemini((n, files) => ({
    text: JSON.stringify({ summary: 'g', findings: [], coverage: { complete: false, reviewedPaths: files.slice(0, 1), unreviewedPaths: files.slice(1), note: '' } }),
  }), async ({ base }) => {
    const root = setup({ 'a/1.swift': 100, 'a/2.swift': 100 });
    const out = await runAsync(root, base, { REVIEW_PROVIDERS: 'gemini' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.calls.length, 0);
    assert.equal(out.review.coverage.complete, false);
    assert.deepEqual(out.review.coverage.unreviewedPaths, ['a/2.swift']);
  });
});
