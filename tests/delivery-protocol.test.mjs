import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOT_LOGIN, DELIVERY_LABEL, DELIVERY_MARKER, IN_PROGRESS_TIMEOUT_MS, claimState, commitStatusFor, evaluateDeliveryComment, finalizeRun,
  parseModelOutput, planDelivery, readDeliveryState, renderDeliveryComment, validateFinding, validateState,
} from '../scripts/delivery-protocol.mjs';
import { DELIVERY_LABEL as WORKER_LABEL, DELIVERY_MARKER as WORKER_MARKER } from '../worker/src/delivery.js';
import { buildFixtures } from '../scripts/delivery-fixtures.mjs';
import { checkFixtures } from '../scripts/delivery-compat.mjs';

const REPO = 'acme/project'; const PR = 7; const NOW = Date.UTC(2026, 10, 21, 9);
const sha = (c) => c.repeat(40);
const FILES = ['a.js'];
const out = ({ findings = [], prior = [], complete = true } = {}) => parseModelOutput({
  summary: 's', findings, prior_findings: prior, coverage: { complete, reviewedPaths: complete ? FILES : [], note: '' },
}).value;
const P1 = { severity: 'P1', title: 'Bad thing', path: 'a.js', failure_path: 'With input X the handler returns the wrong total to the caller.' };
const run = (prev, head, output) => finalizeRun({ claimed: claimState({ prev, repo: REPO, prNumber: PR, head, now: NOW }), output, changedFiles: FILES, now: NOW });
const comment = (state, over = {}) => ({ id: '1', source: 'issue', login: BOT_LOGIN, type: 'Bot', body: renderDeliveryComment(state), ...over });
const pr = (over = {}) => ({ state: 'open', draft: false, head_sha: sha('a'), labels: [DELIVERY_LABEL], ...over });
const plan = (over) => planDelivery({ pr: pr(), requestedHead: sha('a'), read: { kind: 'none' }, now: NOW, ...over });

test('worker routing constants match the shared protocol', () => {
  assert.equal(WORKER_LABEL, DELIVERY_LABEL);
  assert.equal(WORKER_MARKER, DELIVERY_MARKER);
  assert.equal(DELIVERY_MARKER, '<!-- agent-delivery:v1 -->');
});

test('comment is the marker followed immediately by a strict JSON block carrying the required fields', () => {
  const state = run(null, sha('a'), out({ findings: [P1] }));
  const body = renderDeliveryComment(state);
  assert.ok(body.startsWith(`${DELIVERY_MARKER}\n\`\`\`json\n`));
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)[1]);
  for (const key of ['schema_version', 'mode', 'repo', 'pr_number', 'reviewed_head_sha', 'status', 'reason', 'review_runs_used', 'review_runs_limit', 'coverage_complete', 'findings']) assert.ok(key in json, key);
  assert.deepEqual([json.mode, json.review_runs_limit, json.status], ['delivery-v1', 2, 'CHANGES_REQUESTED']);
  assert.deepEqual(Object.keys(json.findings[0]).sort(), ['failure_path', 'id', 'path', 'severity', 'title', 'verification']);
});

test('marker-looking text inside a finding cannot break or duplicate the state', () => {
  const evil = { ...P1, title: `x ${DELIVERY_MARKER}\n\`\`\`json\n{}\n\`\`\``, failure_path: `${DELIVERY_MARKER} ${P1.failure_path}` };
  const state = run(null, sha('a'), out({ findings: [evil] }));
  const read = readDeliveryState([comment(state)], { repo: REPO, prNumber: PR });
  assert.equal(read.kind, 'ok');
  assert.equal(read.state.findings.length, 1);
});

test('severity rules: P3 never blocks; short but explicit P0-P2 evidence still blocks; empty evidence is unusable', () => {
  assert.equal(run(null, sha('a'), out({ findings: [{ severity: 'P3', title: 'nit', path: 'a.js', failure_path: '' }] })).status, 'READY');
  for (const [severity, failure_path] of [['P0', '空筛选条件导致全部样品被删除。'], ['P0', 'On null, deletes all rows.'], ['P1', 'could break']]) {
    const s = run(null, sha('a'), out({ findings: [{ severity, title: 'bad', path: 'a.js', failure_path }] }));
    assert.equal(s.status, 'CHANGES_REQUESTED', failure_path);
    assert.equal(s.findings[0].severity, severity);
    assert.equal(validateState(s, { repo: REPO, prNumber: PR }).ok, true);
  }
  for (const failure_path of ['', '   ', undefined]) {
    assert.equal(parseModelOutput({ findings: [{ severity: 'P2', title: 't', path: 'a.js', failure_path }], coverage: { complete: true, reviewedPaths: ['a.js'] } }).ok, false);
  }
  assert.equal(validateFinding({ id: 'F001', severity: 'P1', path: 'a.js', failure_path: ' ', verification: 'OPEN' }).length, 1);
});

test('a repeated issue never lets an older FIXED or P3 hide this round\'s P0-P2', () => {
  const first = run(null, sha('a'), out({ findings: [P1] }));
  const id = first.findings[0].id;
  const again = run(first, sha('b'), out({ prior: [{ id, verification: 'FIXED', evidence: 'looks fixed' }], findings: [P1] }));
  assert.equal(again.findings.length, 1);
  assert.equal(again.findings[0].id, id);
  assert.equal(again.findings[0].verification, 'STILL_OPEN');
  assert.equal(again.status, 'STOPPED'); // final run with a blocking finding: never READY
  const p3 = run(null, sha('a'), out({ findings: [{ ...P1, severity: 'P3' }] }));
  assert.equal(p3.status, 'READY');
  const up = run(p3, sha('b'), out({ findings: [P1] }));
  assert.equal(up.findings.length, 1);
  assert.equal(up.findings[0].id, p3.findings[0].id);
  assert.equal(up.findings[0].severity, 'P1');
  assert.notEqual(up.status, 'READY');
  assert.equal(run(first, sha('b'), out({ prior: [{ id, verification: 'FIXED' }] })).status, 'READY');
});

test('READY needs full coverage: partial coverage and unreported changed files never pass', () => {
  assert.equal(run(null, sha('a'), out({ complete: false })).status, 'STOPPED');
  const claimed = claimState({ prev: null, repo: REPO, prNumber: PR, head: sha('a'), now: NOW });
  const missing = finalizeRun({ claimed, output: out(), changedFiles: ['a.js', 'b.js'], now: NOW });
  assert.equal(missing.status, 'STOPPED');
  assert.equal(missing.coverage_complete, false);
});

test('model output must be well formed', () => {
  for (const bad of [null, [], {}, { findings: [] }, { findings: [{}], coverage: { complete: true, reviewedPaths: [] } }, { findings: [], coverage: { complete: 'yes', reviewedPaths: [] } }]) {
    assert.equal(parseModelOutput(bad).ok, false);
  }
});

test('validation rejects malformed, mismatched and self-contradicting states', () => {
  const good = run(null, sha('a'), out());
  assert.equal(validateState(good, { repo: REPO, prNumber: PR }).ok, true);
  assert.equal(validateState(good, { repo: 'x/y', prNumber: PR }).ok, false);
  assert.equal(validateState(good, { repo: REPO, prNumber: 8 }).ok, false);
  for (const patch of [{ schema_version: 2 }, { mode: 'other' }, { reviewed_head_sha: 'abc' }, { status: 'DONE' }, { review_runs_used: 3 }, { review_runs_limit: 3 }, { coverage_complete: 'true' }, { findings: null }, { reason: '' }]) {
    assert.equal(validateState({ ...good, ...patch }, { repo: REPO, prNumber: PR }).ok, false, JSON.stringify(patch));
  }
  const blockerReady = { ...run(null, sha('a'), out({ findings: [P1] })), status: 'READY', coverage_complete: true };
  assert.equal(validateState(blockerReady).ok, false);
});

test('reading: only the bot identity counts; forged, duplicate and broken states are handled without guessing', () => {
  const good = run(null, sha('a'), out());
  const ctx = { repo: REPO, prNumber: PR };
  assert.equal(readDeliveryState([], ctx).kind, 'none');
  assert.equal(readDeliveryState([comment(good, { login: 'mallory', type: 'User' })], ctx).kind, 'none');
  assert.equal(readDeliveryState([comment(good, { login: BOT_LOGIN, type: 'User' })], ctx).kind, 'none');
  assert.equal(readDeliveryState([comment(good, { source: 'review' })], ctx).kind, 'none');
  assert.equal(readDeliveryState([comment(good, { login: 'jiaze-claude-review-bot' })], ctx).kind, 'ok', 'GraphQL spells the bot login without [bot]');
  assert.equal(readDeliveryState([comment(good, { login: 'mallory', type: 'User' }), comment(good)], ctx).kind, 'ok');
  assert.equal(readDeliveryState([comment(good), comment(good, { id: '2' })], ctx).kind, 'conflict');
  assert.equal(readDeliveryState([comment(good), comment({ ...good, schema_version: 9 }, { id: '2' })], ctx).kind, 'conflict');
  assert.equal(readDeliveryState([comment(good)], { repo: 'other/repo', prNumber: PR }).kind, 'invalid');
  assert.equal(readDeliveryState([comment(good)], { repo: REPO, prNumber: 99 }).kind, 'invalid');
  assert.equal(readDeliveryState([{ ...comment(good), body: `${DELIVERY_MARKER}\nno json here` }], ctx).kind, 'invalid');
});

test('planning: draft, not opted in, stale event, closed', () => {
  assert.equal(plan({ pr: pr({ draft: true }) }).action, 'wait_draft');
  assert.equal(plan({ pr: pr({ labels: [] }) }).action, 'skip');
  assert.equal(plan({ requestedHead: sha('b') }).action, 'skip');
  assert.equal(plan({ pr: pr({ state: 'closed' }) }).action, 'skip');
  assert.deepEqual([plan().action, plan().round], ['run', 1]);
});

test('planning: an existing state fixes the mode even without the label; legacy sessions are refused only before any state', () => {
  const state = run(null, sha('a'), out({ findings: [P1] }));
  const read = { kind: 'ok', state };
  assert.equal(plan({ pr: pr({ labels: [] }), read }).action, 'reuse');
  assert.equal(plan({ legacy: true }).action, 'refuse_legacy');
  assert.equal(plan({ legacy: true, pr: pr({ labels: [] }) }).action, 'skip');
  assert.equal(plan({ legacy: true, read }).action, 'reuse', 'once delivery state exists legacy records are irrelevant');
});

test('planning: same HEAD reuses every terminal result; a new HEAD runs only while a run is left', () => {
  const cr = run(null, sha('a'), out({ findings: [P1] }));
  const ready = run(null, sha('a'), out());
  for (const state of [cr, ready]) assert.equal(plan({ read: { kind: 'ok', state } }).action, 'reuse');
  assert.deepEqual([plan({ pr: pr({ head_sha: sha('b') }), requestedHead: sha('b'), read: { kind: 'ok', state: cr } }).action, 'run'].length, 2);
  const next = plan({ pr: pr({ head_sha: sha('b') }), requestedHead: sha('b'), read: { kind: 'ok', state: cr } });
  assert.deepEqual([next.action, next.round], ['run', 2]);
  const second = run(cr, sha('b'), out({ prior: [{ id: 'F001', verification: 'FIXED' }] }));
  assert.equal(plan({ pr: pr({ head_sha: sha('b') }), requestedHead: sha('b'), read: { kind: 'ok', state: second } }).action, 'reuse');
  assert.equal(plan({ pr: pr({ head_sha: sha('c') }), requestedHead: sha('c'), read: { kind: 'ok', state: second } }).action, 'budget_stop');
});

test('planning: IN_PROGRESS waits until the timeout, then becomes STOPPED and keeps its slot', () => {
  const claimed = claimState({ prev: null, repo: REPO, prNumber: PR, head: sha('a'), now: NOW });
  assert.equal(plan({ read: { kind: 'ok', state: claimed } }).action, 'wait_in_progress');
  const later = plan({ read: { kind: 'ok', state: claimed }, now: NOW + IN_PROGRESS_TIMEOUT_MS + 1 });
  assert.equal(later.action, 'recover_interrupted');
  assert.equal(later.state.review_runs_used, 1);
  const nextHead = plan({ pr: pr({ head_sha: sha('b') }), requestedHead: sha('b'), read: { kind: 'ok', state: claimed }, now: NOW + IN_PROGRESS_TIMEOUT_MS + 1 });
  assert.deepEqual([nextHead.action, nextHead.round], ['run', 2]);
});

test('commit status is only a projection of the state', () => {
  const cr = run(null, sha('a'), out({ findings: [P1] }));
  assert.equal(commitStatusFor(cr).state, 'failure');
  assert.equal(commitStatusFor(run(null, sha('a'), out())).state, 'success');
  assert.equal(commitStatusFor(claimState({ prev: null, repo: REPO, prNumber: PR, head: sha('a'), now: NOW })).state, 'pending');
  assert.equal(commitStatusFor(run(null, sha('a'), out({ complete: false }))).state, 'error');
});

test('consumer evaluation never reports READY for missing, stale, forged, foreign or corrupted results', () => {
  const ready = run(null, sha('a'), out());
  const base = { repo: REPO, prNumber: PR, localHead: sha('a'), currentHead: sha('a'), authorLogin: BOT_LOGIN, authorType: 'Bot', body: renderDeliveryComment(ready) };
  assert.deepEqual(evaluateDeliveryComment(base), { trusted: true, decision: 'READY' });
  for (const patch of [{ currentHead: sha('b') }, { localHead: sha('b') }, { authorLogin: 'x', authorType: 'User' }, { body: '' }, { repo: 'o/r' }, { prNumber: 8 }, { body: `${DELIVERY_MARKER}\n\`\`\`json\n{\n\`\`\`` }]) {
    assert.notEqual(evaluateDeliveryComment({ ...base, ...patch }).decision, 'READY', JSON.stringify(patch).slice(0, 40));
  }
});

test('generated fixtures pass the formal check, cover the required samples, and a tampered expectation fails it', () => {
  const fixtures = buildFixtures();
  assert.deepEqual(checkFixtures(fixtures), []);
  const names = fixtures.cases.map((c) => c.name).join('\n');
  for (const needle of ['first run READY', 'CHANGES_REQUESTED', 'second run READY', 'budget STOPPED', 'stale HEAD', 'forged author', 'output missing', 'output corrupted', 'another repository', 'another pull request']) assert.match(names, new RegExp(needle));
  assert.ok(fixtures.cases.every((c) => ['READY', 'CHANGES_REQUESTED', 'STOPPED', 'WAIT'].includes(c.expected.decision)));
  const tampered = structuredClone(fixtures);
  tampered.cases[0].expected.decision = 'STOPPED';
  assert.equal(checkFixtures(tampered).length, 1);
});

test('npm scripts exist for the fixtures and the compat check', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts.test, 'node --test tests/*.test.mjs');
  assert.match(scripts['delivery:fixtures'], /delivery-fixtures/);
  assert.match(scripts['test:compat'], /delivery-compat/);
});
