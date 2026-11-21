import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';
import { createHarness, modelOutput, sha, P1, P3, BOT } from './helpers/delivery-harness.mjs';

const H1 = sha('a'); const H2 = sha('b'); const H3 = sha('c');

test.beforeEach((t) => {
  // Any real network call (a real provider, GitHub, anything) fails the test: all transport is injected.
  t.mock.method(globalThis, 'fetch', async (url) => { throw new Error(`test attempted a real network request: ${url}`); });
});

test('Draft spends no model and writes nothing; Ready starts the first review', async () => {
  const h = createHarness({ draft: true });
  assert.equal((await h.event()).action, 'wait_draft');
  assert.equal(h.providerCalls.length, 0);
  assert.equal(h.comments().length, 0);
  h.world.draft = false;
  h.script(h.ok(modelOutput()));
  const result = await h.event();
  assert.deepEqual([result.action, result.status, result.modelCalls], ['run', 'READY', 1]);
  assert.equal(h.state().state.review_runs_used, 1);
  assert.equal(h.lastStatus().state, 'success');
});

test('a PR without the label and without delivery state is left to the legacy path', async () => {
  const h = createHarness({ labels: [] });
  assert.equal((await h.event()).action, 'skip');
  assert.equal(h.providerCalls.length, 0);
  assert.equal(h.comments().length, 0);
  assert.equal(h.world.statuses.length, 0);
});

test('P3 never blocks: only suggestions plus full coverage is READY on the first run', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P3] })));
  assert.equal((await h.event()).status, 'READY');
  assert.equal(h.state().state.findings[0].severity, 'P3');
});

test('first run P1 -> CHANGES_REQUESTED; a fixed second run -> READY; later duplicates keep READY and cost nothing', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P1] })));
  assert.equal((await h.event()).status, 'CHANGES_REQUESTED');
  assert.equal(h.lastStatus().state, 'failure');
  const id = h.comments()[0].id;

  // duplicates of the same HEAD, label removed, workflow re-run: no model, no budget, same result
  h.world.labels = [];
  for (let i = 0; i < 3; i += 1) assert.deepEqual([(await h.event()).action, h.providerCalls.length], ['reuse', 1]);
  h.world.labels = ['delivery-v1'];

  h.world.head = H2;
  h.script(h.ok(modelOutput({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'loop fixed' }] })));
  const second = await h.event();
  assert.equal(second.status, 'READY');
  assert.equal(h.comments().length, 1, 'one comment, patched in place');
  assert.equal(h.comments()[0].id, id);
  const state = h.state().state;
  assert.deepEqual([state.review_runs_used, state.reviewed_head_sha, state.findings[0].verification], [2, H2, 'FIXED']);

  // a repeated notification after READY changes nothing
  assert.deepEqual([(await h.event()).status, h.providerCalls.length], ['READY', 2]);
});

test('the second run receives the earlier blockers and the PR goal in its prompt', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P1] })));
  await h.event();
  assert.match(h.providerCalls[0].prompt, /uploads retry safely/);
  h.world.head = H2;
  h.script(h.ok(modelOutput({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'x' }] })));
  await h.event();
  assert.match(h.providerCalls[1].prompt, /F001 \[P1\] src\/a\.js/);
  assert.match(h.providerCalls[1].prompt, /FINAL review/);
});

test('a blocker that is STILL_OPEN, UNCERTAIN or simply not mentioned on the second run STOPS it', async () => {
  for (const prior of [[{ id: 'F001', verification: 'STILL_OPEN', evidence: 'x' }], [{ id: 'F001', verification: 'UNCERTAIN', evidence: 'x' }], []]) {
    const h = createHarness();
    h.script(h.ok(modelOutput({ findings: [P1] })));
    await h.event();
    h.world.head = H2;
    h.script(h.ok(modelOutput({ prior })));
    const result = await h.event();
    assert.equal(result.status, 'STOPPED');
    assert.equal(h.state().state.findings[0].verification, prior[0]?.verification ?? 'UNCERTAIN');
    assert.equal(h.lastStatus().state, 'error');
  }
});

test('a regression found by the final run also stops it', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P1] })));
  await h.event();
  h.world.head = H2;
  h.script(h.ok(modelOutput({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'x' }], findings: [{ ...P1, title: 'New crash on empty upload', path: 'src/b.js' }] })));
  assert.equal((await h.event()).status, 'STOPPED');
});

test('a third request that needs a model cannot bypass the two-run cap, whatever triggered it', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P1] })), h.ok(modelOutput({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'x' }] })));
  await h.event();
  h.world.head = H2;
  await h.event();
  h.world.head = H3;
  for (let i = 0; i < 2; i += 1) { // a manual command and a synchronize look the same to the runner
    const result = await h.event();
    assert.deepEqual([result.action, result.status, result.modelCalls], [i === 0 ? 'budget_stop' : 'reuse', 'STOPPED', 0]);
  }
  assert.equal(h.providerCalls.length, 2);
  const state = h.state().state;
  assert.deepEqual([state.review_runs_used, state.reviewed_head_sha, state.status], [2, H3, 'STOPPED']);
});

test('the slot is persisted before the model runs, and a failed persist means no model call', async () => {
  const h = createHarness();
  h.world.failures.post = 1;
  h.script(h.ok(modelOutput()));
  await assert.rejects(h.event(), /no model was called/);
  assert.equal(h.providerCalls.length, 0);
  assert.equal(h.comments().length, 0);
  assert.equal(h.lastStatus().state, 'error');

  // ordering: when the provider runs, the comment already says IN_PROGRESS with the slot used
  const g = createHarness();
  let seen;
  g.script(() => { seen = g.state().state; return g.ok(modelOutput()); });
  await g.event();
  assert.deepEqual([seen.status, seen.review_runs_used], ['IN_PROGRESS', 1]);
});

test('a failure to save the final result never reports success; the slot stays used', async () => {
  const h = createHarness();
  h.world.failures.patch = 1;
  h.script(h.ok(modelOutput()));
  await assert.rejects(h.event(), /could not persist the review result/);
  assert.equal(h.lastStatus().state, 'error');
  assert.equal(h.world.statuses.some((s) => s.state === 'success'), false);
  const state = h.state().state;
  assert.deepEqual([state.status, state.review_runs_used], ['IN_PROGRESS', 1]);
});

test('a leftover IN_PROGRESS waits, then is recognised as interrupted after the timeout without resetting the budget', async () => {
  const h = createHarness();
  h.world.failures.patch = 1;
  h.script(h.ok(modelOutput()));
  await assert.rejects(h.event());
  assert.equal((await h.event()).action, 'wait_in_progress');
  h.world.now += 46 * 60 * 1000;
  const recovered = await h.event();
  assert.deepEqual([recovered.action, recovered.status, recovered.modelCalls], ['recover_interrupted', 'STOPPED', 0]);
  assert.equal(h.state().state.review_runs_used, 1);
  assert.equal(h.providerCalls.length, 1);
  // a later HEAD may use only the one remaining run
  h.world.head = H2;
  h.script(h.ok(modelOutput()));
  assert.equal((await h.event()).status, 'READY');
  assert.equal(h.state().state.review_runs_used, 2);
});

test('HEAD changing during the run never publishes the old result as a pass for the current commit', async () => {
  const h = createHarness();
  h.script((world) => { world.head = H2; return h.ok(modelOutput()); });
  const result = await h.event();
  assert.equal(result.status, 'STOPPED');
  const state = h.state().state;
  assert.deepEqual([state.reviewed_head_sha, state.review_runs_used], [H1, 1]);
  assert.match(state.reason, /HEAD changed/);
  assert.equal(h.world.statuses.filter((s) => s.sha === H2).length, 0);
  assert.equal(h.world.statuses.some((s) => s.state === 'success'), false);
});

test('a queued event for an older HEAD is skipped before the model and spends nothing', async () => {
  const h = createHarness({ head: H2 });
  const result = await h.event({ requestHead: H1 });
  assert.deepEqual([result.action, result.modelCalls], ['skip', 0]);
  assert.equal(h.comments().length, 0);
});

test('partial coverage, provider failure, broken output and a crash never produce READY and keep the slot', async () => {
  const cases = [
    ['partial coverage', h => h.ok(modelOutput({ complete: false })), /coverage incomplete/],
    ['provider failure', () => ({ ok: false, error: 'timeout' }), /Provider failed: timeout/],
    ['broken output', h => h.ok({ nonsense: true }), /Model output unusable/],
    ['crash', () => () => { throw new Error('kaboom'); }, /crashed: kaboom/],
  ];
  for (const [name, answer, reason] of cases) {
    const h = createHarness();
    const a = answer(h);
    h.script(typeof a === 'function' ? a : a);
    const result = await h.event();
    assert.equal(result.status, 'STOPPED', name);
    const state = h.state().state;
    assert.match(state.reason, reason, name);
    assert.equal(state.review_runs_used, 1, name);
    assert.equal(h.world.statuses.some((s) => s.state === 'success'), false, name);
  }
});

test('an unfinished-coverage first run that also has a blocker still asks for changes and keeps coverage false', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput({ findings: [P1], complete: false })));
  assert.equal((await h.event()).status, 'CHANGES_REQUESTED');
  assert.equal(h.state().state.coverage_complete, false);
});

test('provider misconfiguration is caught before a slot is taken', async () => {
  const h = createHarness();
  h.world.preflightError = 'CLAUDE_CODE_OAUTH_TOKEN is not configured';
  await assert.rejects(h.event(), /not configured/);
  assert.equal(h.comments().length, 0);
  assert.equal(h.providerCalls.length, 0);
});

test('a PR with a legacy review session is not migrated and nothing is spent', async () => {
  const h = createHarness();
  const legacy = applyDiscoveryResult({ result: { summary: 's', findings: [] }, baseSha: sha('0'), headSha: H1, sourceCommentId: '7' });
  h.fake.seed(legacy);
  const result = await h.event();
  assert.equal(result.action, 'refuse_legacy');
  assert.equal(h.providerCalls.length, 0);
  assert.equal(h.comments().length, 0);
  assert.match(h.lastStatus().description, /legacy review session/);
});

test('trust: a forged state comment by a user is ignored; an untrusted bot comment or two states stop the review', async () => {
  const forged = createHarness();
  const good = createHarness();
  good.script(good.ok(modelOutput()));
  await good.event();
  const body = good.comments()[0].body;
  forged.fake.addIssue(body, { user: 'mallory', type: 'User' });
  forged.script(forged.ok(modelOutput({ findings: [P1] })));
  assert.equal((await forged.event()).status, 'CHANGES_REQUESTED', 'the forged READY was ignored and a real run happened');

  const twice = createHarness();
  twice.fake.addIssue(body.replace('"pr_number": 7', '"pr_number": 7'), { user: BOT, type: 'Bot' });
  twice.fake.addIssue(body, { user: BOT, type: 'Bot' });
  // identical repo/pr in both would be valid twice -> conflict. (good's state belongs to acme/project#7)
  const conflict = await twice.event();
  assert.equal(conflict.action, 'stop_untrusted');
  assert.equal(twice.providerCalls.length, 0);

  const broken = createHarness();
  broken.fake.addIssue('<!-- agent-delivery:v1 -->\n```json\n{oops\n```', { user: BOT, type: 'Bot' });
  assert.equal((await broken.event()).action, 'stop_untrusted');
});

test('unreadable PR records fail closed instead of reading as "no state"', async () => {
  const h = createHarness();
  const original = h.github.readRecords;
  h.github.readRecords = async () => { throw new Error('GitHub GraphQL failed (HTTP 502)'); };
  await assert.rejects(h.event(), /GraphQL failed/);
  assert.equal(h.providerCalls.length, 0);
  h.github.readRecords = original;
});

test('state comments are read across pages', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput()));
  await h.event();
  // 130 unrelated comments before the state comment: a first-page-only read would miss it and run again
  const stateComment = h.fake.issue.splice(0, h.fake.issue.length);
  for (let i = 0; i < 130; i += 1) h.fake.addIssue(`chatter ${i}`, { user: 'someone', type: 'User' });
  h.fake.issue.push(...stateComment);
  // serve the GraphQL comment connection 50 at a time
  const base = h.github.readRecords;
  assert.ok(base);
  const { fetchLedgerSources } = await import('../scripts/review-ledger-fetch.mjs');
  const paged = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).endsWith('/graphql') && body.query.includes('comments(first') && !body.query.includes('reviewThreads')) {
      const all = h.fake.issue.map((c) => ({ databaseId: Number(c.id), createdAt: c.createdAt, lastEditedAt: null, minimizedReason: null, body: c.body, author: { login: c.user.replace(/\[bot\]$/, ''), __typename: c.type } }));
      const start = body.variables.after ? Number(body.variables.after) : 0;
      const nodes = all.slice(start, start + 50);
      const more = start + 50 < all.length;
      return Response.json({ data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: more, endCursor: String(start + 50) }, nodes } } } } });
    }
    return h.fetchImpl(url, init);
  };
  const { records, reads } = await fetchLedgerSources({ owner: 'acme', repo: 'project', number: 7, token: 't', fetchImpl: paged });
  assert.equal(reads.complete, true);
  assert.equal(records.filter((r) => r.body.startsWith('<!-- agent-delivery:v1 -->')).length, 1);
  assert.equal(records.length, 131);
  // and the runner itself, reading through the same paged transport, finds the state and reuses it without a model
  const { createGithubClient, runDelivery } = await import('../scripts/delivery-review.mjs');
  const github = createGithubClient({ fetchImpl: paged, token: 't', statusToken: 's', target: 'acme/project', prNumber: 7, botLogin: BOT, env: {} });
  const result = await runDelivery({ env: { TARGET_REPO: 'acme/project', PR_NUMBER: '7', HEAD_SHA: H1, EXPECTED_REVIEW_AUTHOR: BOT }, github, provider: h.provider, log: () => {} });
  assert.deepEqual([result.action, result.modelCalls, h.providerCalls.length], ['reuse', 0, 1]);
});

test('diagnostics: one allow-listed line per run, unknown stays null, failures and crashes still report, results unchanged', async () => {
  const { buildProviderDiagnostics, emitDiagnostics } = await import('../scripts/delivery-review.mjs');
  const claude = buildProviderDiagnostics({ provider: 'claude', durationMs: 1200, limits: { maxTurns: 20, maxBudgetUsd: 2.5 }, outcome: { ok: true, meta: { requested_model: 'sonnet', resolved_model: 'claude-sonnet-x', num_turns: 4, total_cost_usd: 0.31, cost_source: 'sdk', usage: { input_tokens: 900, output_tokens: 50 } } } });
  assert.deepEqual([claude.cost_usd_nominal, claude.usd_cap, claude.turns, claude.input_tokens, claude.failure], [0.31, 2.5, 4, 900, null]);
  const gemini = buildProviderDiagnostics({ provider: 'gemini', durationMs: 5, limits: { maxTurns: 20, maxBudgetUsd: 2.5 }, outcome: { ok: false, errorKind: 'timeout', error: 'Gemini request timed out', meta: { total_cost_usd: 0, cost_source: 'zero', usage: { input_tokens: 0, output_tokens: 0 } } } });
  assert.equal(gemini.cost_usd_nominal, null); // Gemini zero is "not measured", never a real 0
  assert.equal(gemini.usd_cap, null);
  assert.equal(gemini.timed_out, true);
  assert.equal(gemini.failure.kind, 'timeout');
  assert.equal(buildProviderDiagnostics({ provider: 'claude', outcome: {}, limits: {} }).resolved_model, 'unknown');

  const h = createHarness();
  const lines = [];
  const secretish = { ok: true, structured: modelOutput(), diagnostics: { ...claude, resolved_model: 'm' } };
  h.script(secretish);
  const { runDelivery } = await import('../scripts/delivery-review.mjs');
  const res = await runDelivery({ env: { TARGET_REPO: 'acme/project', PR_NUMBER: '7', HEAD_SHA: sha('a'), EXPECTED_REVIEW_AUTHOR: BOT }, github: h.github, provider: h.provider, now: () => h.world.now, log: (l) => lines.push(l) });
  assert.equal(lines.filter((l) => l.startsWith('DELIVERY_DIAGNOSTICS ')).length, 1);
  // a provider that throws still yields its (limited) diagnostics line and the same STOPPED result as before
  const h2 = createHarness();
  const crash = Object.assign(new Error('boom'), { diagnostics: gemini });
  h2.script(() => { throw crash; });
  const l2 = [];
  const r2 = await runDelivery({ env: { TARGET_REPO: 'acme/project', PR_NUMBER: '7', HEAD_SHA: sha('a'), EXPECTED_REVIEW_AUTHOR: BOT }, github: h2.github, provider: h2.provider, now: () => h2.world.now, log: (l) => l2.push(l) });
  assert.equal(r2.status, 'STOPPED');
  assert.equal(l2.filter((l) => l.startsWith('DELIVERY_DIAGNOSTICS ')).length, 1);
  assert.equal(res.status, 'READY');
  const emitted = [];
  emitDiagnostics((l) => emitted.push(l), { repo: 'a/b', prNumber: 7, head: sha('a'), round: 1, diagnostics: claude });
  assert.match(emitted[0], /^DELIVERY_DIAGNOSTICS \{/);
  const parsed = JSON.parse(emitted[0].slice('DELIVERY_DIAGNOSTICS '.length));
  assert.deepEqual([parsed.repo, parsed.pr, parsed.head, parsed.run], ['a/b', 7, sha('a'), 1]);
  assert.doesNotMatch(emitted[0], /OAUTH|API_KEY|PRIVATE|ghp_|Bearer/i);
  // a logger that throws must not change anything
  assert.doesNotThrow(() => emitDiagnostics(() => { throw new Error('log broke'); }, { repo: 'a/b', prNumber: 7, head: 'x', round: 1, diagnostics: claude }));
});
