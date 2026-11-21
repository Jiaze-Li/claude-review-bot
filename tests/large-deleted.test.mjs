// Large files that cannot be inlined need real, logged reads before they are credited. A file the PR deletes is not in
// the HEAD snapshot, so its content is read from its block of the full diff. These tests drive the REAL gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOT_LOGIN, readState, renderComment } from '../scripts/review-contract.mjs';
import { createProvider, loadContext, runReview } from '../scripts/review.mjs';
import { nextBatch, readCallsFor, maxReadCalls } from '../scripts/review-engine.mjs';
import { splitDiffByFile } from '../scripts/review-shards.mjs';
import { DELETED_LINES, MERGE_BASE, PR, REPO, contextFiles, fakeGithub, makeContext, model, review, scriptedProvider, sha } from './helpers/harness.mjs';

const GONE = 'src/legacy/old-engine.js';
const stateOf = (gh) => gh.state_().state;

// A real on-disk context + snapshot, a real gateway, and a scripted "model" that can only act through that gateway.
function fixture(options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'large-deleted-')));
  const ctxDir = path.join(root, '.review-context');
  const safeDir = path.join(root, 'safe-target');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.mkdirSync(path.join(safeDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(safeDir, 'src/user.js'), "import { run } from './legacy/old-engine.js';\nexport default () => run();\n");
  for (const [name, text] of Object.entries(contextFiles([GONE], { bigDeleted: [GONE], ...options }))) fs.writeFileSync(path.join(ctxDir, name), text);
  const env = { REVIEW_CONTEXT_DIR: ctxDir, SAFE_REPO_DIR: safeDir, CLAUDE_CODE_OAUTH_TOKEN: 'x', REVIEW_MAX_TURNS: '14' };
  const span = (() => { const c = splitDiffByFile(fs.readFileSync(path.join(ctxDir, 'pr.diff'), 'utf8'))[0]; return { from: c.startLine, to: c.endLine }; })();
  return { root, env, ctxDir, span, cwd: root };
}
const coverage = (assigned, complete = true) => ({
  summary: 's', findings: [], prior_findings: [],
  coverage: { complete, reviewedPaths: assigned, unreviewedPaths: [], note: '' },
});
async function run(fx, act) {
  const gh = fakeGithub();
  const prompts = [];
  const provider = await createProvider({ env: fx.env, cwd: fx.cwd, runModel: async ({ prompt, toolGateway }) => { prompts.push(prompt); return act({ prompt, toolGateway }); } });
  const result = await runReview({
    env: { TARGET_REPO: REPO, PR_NUMBER: String(PR), HEAD_SHA: gh.head, ...fx.env }, github: gh, provider,
    loadCtx: () => loadContext({ contextRoot: provider.contextRoot }), log: () => {},
  });
  return { gh, result, prompts };
}
// Read lines [from, to] of the full diff in segments, the way a model with a 2000-line cap must.
async function readSpan(gw, from, to, step = 600) {
  for (let offset = from; offset <= to; offset += step) {
    const r = await gw.executeRead({ file_path: '.review-context/pr.diff', offset, limit: Math.min(step, to - offset + 1) });
    assert.equal(r.ok, true, r.error);
  }
}

test('diff status distinguishes added, modified, deleted and renamed files, with the block span in the full diff', () => {
  const diff = [
    'diff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1 @@\n+a\n',
    'diff --git a/d.js b/d.js\ndeleted file mode 100644\n--- a/d.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n',
    'diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js\n',
  ].join('');
  const chunks = splitDiffByFile(diff);
  assert.deepEqual(chunks.map((c) => [c.path, c.status]), [['n.js', 'added'], ['d.js', 'deleted'], ['m.js', 'modified'], ['new.js', 'renamed']]);
  const lines = diff.split('\n');
  for (const c of chunks) {
    assert.ok(lines[c.startLine - 1].startsWith('diff --git '), 'startLine is the block header');
    assert.equal(lines.slice(c.startLine - 1, c.endLine).join('\n') + '\n', c.text, 'the span is exactly the block');
  }
});

test('a large deleted file completes review from segmented reads of its diff block; HEAD is never asked for it', async () => {
  const fx = fixture();
  const { gh, result, prompts } = await run(fx, async ({ prompt, toolGateway }) => {
    const assigned = [GONE];
    assert.match(prompt, new RegExp(`${GONE}  \\(diff truncated below: this file is deleted; Read \\.review-context/pr\\.diff lines ${fx.span.from}-${fx.span.to}`));
    assert.doesNotMatch(prompt, /you must Read this whole file from safe-target/);
    await readSpan(toolGateway, fx.span.from, fx.span.to);
    return { ok: true, structured: coverage(assigned) };
  });
  assert.equal(result.status, 'READY');
  assert.equal(stateOf(gh).completed_rounds, 1);
  assert.equal(stateOf(gh).attempts_used, 1);
  assert.equal(prompts.length, 1);
});

test('no credit without logged reads of the whole span: a claim, a partial read, or reading the wrong thing', async () => {
  const half = Math.floor((DELETED_LINES) / 2);
  const cases = {
    'claims it reviewed everything, read nothing': async () => {},
    'read only the first segment': async (gw, span) => readSpan(gw, span.from, span.from + 599),
    'read the middle but not the ends': async (gw, span) => readSpan(gw, span.from + 100, span.from + half),
    'read the snapshot path instead (which has no such file)': async (gw) => { await gw.executeRead({ file_path: `safe-target/${GONE}` }); },
    'read everything but one line short': async (gw, span) => readSpan(gw, span.from, span.to - 1),
  };
  for (const [name, doRead] of Object.entries(cases)) {
    const fx = fixture();
    const { gh, result } = await run(fx, async ({ toolGateway }) => { await doRead(toolGateway, fx.span); return { ok: true, structured: coverage([GONE]) }; });
    assert.notEqual(result.status, 'READY', name);
    assert.deepEqual(stateOf(gh).reviewed_files, [], name);
    assert.equal(stateOf(gh).completed_rounds, 0, name);
  }
});

test('a line cut off by the read budget does not count as read, and a continuation completes it', async () => {
  const fx = fixture();
  const { gh, result } = await run(fx, async ({ toolGateway }) => {
    toolGateway.maxCallReadBytes = 20_000; // each call delivers ~190 whole lines and may end inside a line
    let offset = fx.span.from;
    while (offset <= fx.span.to) {
      const r = await toolGateway.executeRead({ file_path: '.review-context/pr.diff', offset, limit: 2000 });
      assert.equal(r.ok, true);
      if (r.nextOffset === null) break;
      offset = r.nextOffset;
    }
    return { ok: true, structured: coverage([GONE]) };
  });
  assert.equal(result.status, 'READY');
  assert.ok(stateOf(gh).completed_rounds === 1);
});

test('a reference left behind by a deletion is put in front of the reviewer, who can find it with the real Grep', async () => {
  const fx = fixture();
  const { gh, result, prompts } = await run(fx, async ({ prompt, toolGateway }) => {
    assert.match(prompt, /Files DELETED by this PR[\s\S]*Grep safe-target\//);
    assert.ok(prompt.includes(`- ${GONE}`), 'the deleted path is listed');
    await readSpan(toolGateway, fx.span.from, fx.span.to);
    const grep = await toolGateway.executeGrep({ pattern: 'old-engine', path: 'safe-target', fixed_string: true });
    assert.equal(grep.ok, true, grep.error);
    const hit = grep.matches.find((m) => m.path.endsWith('src/user.js'));
    assert.ok(hit, 'the dangling import is discoverable');
    return { ok: true, structured: { ...coverage([GONE]), findings: [{ severity: 'P2', title: 'Import of a deleted module', path: hit.path.replace(/^safe-target\//, ''), failure_path: `${hit.path}:${hit.line} still imports ${GONE}, which this PR deletes; loading it throws.` }] } };
  });
  assert.equal(prompts.length, 1);
  assert.equal(result.status, 'CHANGES_REQUESTED');
  assert.ok(stateOf(gh).findings.some((f) => f.severity === 'P2' && f.path.endsWith('src/user.js')));
});

test('capacity follows the call budget: reads per batch are bounded, and a file nobody can read through stops without spending attempts', () => {
  const bytes = { a: 450_000, b: 450_000, c: 450_000, small: 1000 };
  const readsOf = (f) => (f === 'small' ? 0 : readCallsFor(bytes[f]));
  assert.equal(readCallsFor(450_000), 3);
  const batch = nextBatch({ remaining: ['a', 'b', 'c', 'small'], bytesOf: (f) => bytes[f], readsOf, maxReads: 4 });
  assert.ok(batch.reduce((n, f) => n + readsOf(f), 0) <= 4 || batch.length === 1, `got ${batch}`);
  assert.equal(nextBatch({ remaining: ['a', 'b', 'c'], bytesOf: (f) => bytes[f], readsOf, maxReads: 4 }).length, 1);
  assert.equal(maxReadCalls(14), 10);
});

test('a file too large to read through in one attempt stops the PR before any model call, saying so', async () => {
  const gh = fakeGithub();
  const store = contextFiles([GONE], { bigDeleted: [GONE] });
  const huge = `diff --git a/${GONE} b/${GONE}\ndeleted file mode 100644\n--- a/${GONE}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-${'z'.repeat(2_500_000)}\n`;
  const provider = scriptedProvider(() => model.ok({ assigned: [GONE] }));
  const r = await review({ gh, provider, ctx: () => loadContext({ contextRoot: 'unused', readFile: (n) => (n === 'pr.diff' ? huge : store[n] ?? '') }) });
  assert.equal(r.status, 'STOPPED');
  assert.equal(provider.calls.length, 0);
  assert.equal(stateOf(gh).attempts_used, 0);
  assert.match(stateOf(gh).reason, /too large to read through/);
});

const names = (n) => Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
const ok = (c) => model.ok({ assigned: c.assigned });
const reread = (gh) => readState(gh.comments, { botLogin: BOT_LOGIN, repo: REPO, prNumber: PR });

test('same HEAD, different merge-base: the old READY is not reused, and the redo is the CURRENT phase, not a new one', async () => {
  const gh = fakeGithub();
  await review({ gh, provider: scriptedProvider(ok), ctx: makeContext(names(2)) });
  assert.equal(stateOf(gh).status, 'READY');
  assert.equal(stateOf(gh).completed_rounds, 1);

  const same = scriptedProvider(ok);
  assert.equal((await review({ gh, provider: same, ctx: makeContext(names(2)) })).action, 'reuse');
  assert.equal(same.calls.length, 0);

  gh.mergeBase = sha('9');
  const moved = scriptedProvider(ok);
  const again = await review({ gh, provider: moved, ctx: makeContext(names(2), { mergeBase: sha('9') }) });
  assert.equal(again.action, 'run');
  assert.ok(moved.calls.length > 0, 'the new diff is reviewed');
  const s = stateOf(gh);
  assert.equal(s.scope.merge_base_sha, sha('9'));
  assert.equal(s.completed_rounds, 1, 'no phantom round: the one-and-only fix/verification opportunity is untouched');
  assert.equal(s.status, 'READY');
  assert.equal(s.attempts_used, 2, 'but the model attempt is really spent');
});

test('same HEAD, new merge-base, >10 files: a partial batch is a VALID state, survives a technical stop, and resumes to a completed round', async () => {
  const gh = fakeGithub();
  const files = names(14);
  await review({ gh, provider: scriptedProvider(ok), ctx: makeContext(files) });
  assert.equal(stateOf(gh).status, 'READY');

  gh.mergeBase = sha('8');
  const ctx = makeContext(files, { mergeBase: sha('8') });
  const crash = scriptedProvider((c) => (c.n === 1 ? ok(c) : model.fail('boom')));
  await review({ gh, provider: crash, ctx });
  let read = reread(gh);
  assert.equal(read.kind, 'ok', `a persisted partial state must be readable: ${read.reason}`);
  assert.equal(read.state.reviewed_files.length, 10);
  assert.equal(read.state.completed_rounds, 0, 'the reopened round is not counted while it is being redone');
  assert.equal(read.state.completed_head_sha, null);
  assert.equal(read.state.status, 'STOPPED');

  const spent = read.state.attempts_used;
  const resume = scriptedProvider(ok);
  const r = await review({ gh, provider: resume, ctx });
  assert.equal(r.action, 'run', 'a partial redo is never mistaken for a complete review');
  assert.equal(resume.calls.flatMap((c) => c.assigned).length, 4, 'only the remaining files');
  read = reread(gh);
  assert.equal(read.kind, 'ok');
  assert.equal(read.state.status, 'READY');
  assert.equal(read.state.completed_rounds, 1);
  assert.equal(read.state.attempts_used, spent + resume.calls.length, 'every real attempt is counted, none refunded');
});

test('base drift after BOTH rounds: the final phase is redone under the remaining attempts; with none left it is an authoritative STOPPED naming the current baseline', async () => {
  const gh = fakeGithub({ head: sha('a') });
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: [{ severity: 'P2', title: 'Bug', path: 'src/f00.js', failure_path: 'trigger then wrong result' }] })), ctx: makeContext(names(2)) });
  gh.head = sha('b');
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, prior: [{ id: 'F001', verification: 'FIXED', evidence: 'fixed at f00:3' }] })), ctx: makeContext(names(2)) });
  assert.equal(stateOf(gh).completed_rounds, 2);
  assert.equal(stateOf(gh).status, 'READY');

  const exhausted = JSON.parse(JSON.stringify(stateOf(gh)));
  gh.mergeBase = sha('7');
  const redo = scriptedProvider(ok);
  await review({ gh, provider: redo, ctx: makeContext(names(2), { mergeBase: sha('7') }) });
  assert.equal(redo.calls.length, 1, 'no third phase, no budget_stop: the second phase is redone');
  assert.equal(stateOf(gh).completed_rounds, 2);
  assert.equal(stateOf(gh).scope.merge_base_sha, sha('7'));

  // no attempts left
  gh.comments[0].body = renderComment({ ...exhausted, attempts_used: 10 });
  gh.mergeBase = sha('6');
  const none = scriptedProvider(ok);
  const r = await review({ gh, provider: none, ctx: makeContext(names(2), { mergeBase: sha('6') }) });
  assert.equal(none.calls.length, 0);
  assert.equal(r.status, 'STOPPED');
  const s = reread(gh);
  assert.equal(s.kind, 'ok', s.reason);
  assert.equal(s.state.status, 'STOPPED');
  assert.equal(s.state.scope.merge_base_sha, sha('6'), 'the STOPPED names the current baseline');
  assert.notEqual(s.state.completed_head_sha, s.state.head_sha, 'and does not pose as a completed review of it');
  assert.match(s.state.reason, /budget used up/);
});

test('whole-PR preflight: 26 files fit; 60 files fit; a PR that cannot finish within 10 executions stops before any model call', async () => {
  for (const n of [26, 60]) {
    const gh = fakeGithub();
    const p = scriptedProvider(ok);
    const r = await review({ gh, provider: p, ctx: makeContext(names(n)) });
    assert.equal(r.status, 'READY', `${n} files`);
    assert.equal(p.calls.length, Math.ceil(n / 10));
  }
  for (const n of [101, 156]) {
    const gh = fakeGithub();
    const p = scriptedProvider(ok);
    const r = await review({ gh, provider: p, ctx: makeContext(names(n).concat(Array.from({ length: Math.max(0, n - 100) }, (_, i) => `docs/x${i}.md`)).slice(0, n)) });
    assert.equal(r.status, 'STOPPED', `${n} files`);
    assert.equal(p.calls.length, 0, 'no attempt is spent');
    assert.equal(stateOf(gh).attempts_used, 0);
    assert.equal(stateOf(gh).completed_rounds, 0);
    assert.match(stateOf(gh).reason, new RegExp(`need at least ${Math.ceil(n / 10)} model executions.*only 10 of 10 remain`));
  }
});

test('preflight counts what is left: progress already credited and attempts already spent are taken into account', async () => {
  const gh = fakeGithub();
  const files = names(30);
  // two batches done, then the run stops; 3 batches in total are needed, 8 attempts remain
  const crash = scriptedProvider((c) => (c.n <= 2 ? ok(c) : model.fail('boom')));
  await review({ gh, provider: crash, ctx: makeContext(files) });
  assert.equal(stateOf(gh).reviewed_files.length, 20);
  const fin = scriptedProvider(ok);
  const r = await review({ gh, provider: fin, ctx: makeContext(files) });
  assert.equal(r.status, 'READY');
  assert.equal(fin.calls.length, 1);
});
