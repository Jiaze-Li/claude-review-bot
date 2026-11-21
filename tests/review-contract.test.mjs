import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOT_LOGIN, MARKER, evaluateComment, parseComment, readState, renderComment, validateState,
} from '../scripts/review-contract.mjs';
import { FIXTURES_PATH, buildFixtures, checkFixtures } from '../scripts/review-fixtures.mjs';
import { applyBatch, claimAttempt, concludeRound, makeScope, parseBatchOutput } from '../scripts/review-engine.mjs';

const REPO = 'owner/repo';
const sha = (c) => c.repeat(40);
const scope = makeScope({ mergeBase: sha('0'), files: ['a.js', 'b.js'] });
const base = () => claimAttempt({ prev: null, repo: REPO, prNumber: 5, head: sha('a'), scope, now: Date.UTC(2026, 10, 21) });
const rec = (body, over = {}) => ({ id: '1', source: 'issue', login: BOT_LOGIN, type: 'Bot', body, ...over });

test('the committed fixtures are exactly what the real code generates, and the consumer-side evaluation agrees', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')), JSON.parse(JSON.stringify(buildFixtures())), 'run: npm run review:fixtures');
  assert.deepEqual(checkFixtures(JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'))), []);
});

test('render/parse round-trips and the JSON block alone carries the state', () => {
  const state = base();
  const body = renderComment(state);
  assert.ok(body.startsWith(MARKER));
  assert.deepEqual(parseComment(body).value, state);
  assert.equal(readState([rec(body)], { repo: REPO, prNumber: 5 }).kind, 'ok');
});

test('only the bot author counts; two state comments conflict; v1 and corrupt documents are never trusted', () => {
  const body = renderComment({ ...base() });
  const opts = { repo: REPO, prNumber: 5 };
  assert.equal(readState([rec(body, { login: 'mallory', type: 'User' })], opts).kind, 'none');
  assert.equal(readState([rec(body, { type: 'User' })], opts).kind, 'none');
  assert.equal(readState([rec(body), rec(body, { id: '2' })], opts).kind, 'conflict');
  assert.equal(readState([rec(body, { id: '1' }), rec(body, { id: '2', login: 'mallory', type: 'User' })], opts).kind, 'ok');
  assert.equal(readState([rec(`${MARKER}\n\`\`\`json\n{"schema_version":2\n\`\`\`\n`)], opts).kind, 'invalid');
  assert.equal(readState([rec(body)], { repo: 'other/repo', prNumber: 5 }).kind, 'invalid');
  assert.equal(readState([rec(body)], { repo: REPO, prNumber: 6 }).kind, 'invalid');
  assert.equal(readState([rec(`${MARKER}\n\`\`\`json\n{"schema_version":1}\n\`\`\`\n`)], opts).kind, 'legacy');
});

test('contradictory states are invalid: READY with a blocker, READY off the concluded HEAD, CHANGES_REQUESTED without one', () => {
  const finding = { id: 'F001', severity: 'P2', title: 't', path: 'a.js', failure_path: 'x', verification: 'OPEN', checked_head_sha: sha('a') };
  const done = concludeRound(applyBatch({ state: base(), assigned: ['a.js', 'b.js'], output: parseBatchOutput({ summary: 's', findings: [], prior_findings: [], coverage: { complete: true, reviewedPaths: ['a.js', 'b.js'], unreviewedPaths: [], note: '' } }).value, now: 1 }).state, 1);
  assert.equal(done.status, 'READY');
  assert.ok(validateState(done).ok);
  assert.ok(!validateState({ ...done, findings: [finding] }).ok);
  assert.ok(!validateState({ ...done, completed_head_sha: sha('b') }).ok);
  assert.ok(!validateState({ ...done, status: 'CHANGES_REQUESTED' }).ok);
  assert.ok(!validateState({ ...done, completed_rounds: 3 }).ok);
  assert.ok(!validateState({ ...done, attempts_used: 11 }).ok);
  assert.ok(!validateState({ ...done, completed_rounds: 0 }).ok);
});

test('evaluateComment: stale HEAD, forged author, in-progress and missing are WAIT; a trusted conclusion on the exact HEAD is its status', () => {
  const state = base();
  const body = renderComment(state);
  const args = { repo: REPO, prNumber: 5, localHead: sha('a'), currentHead: sha('a'), authorLogin: BOT_LOGIN, authorType: 'Bot', body };
  assert.equal(evaluateComment(args).decision, 'WAIT'); // IN_PROGRESS
  assert.equal(evaluateComment({ ...args, body: '' }).decision, 'WAIT');
  assert.equal(evaluateComment({ ...args, authorType: 'User' }).trusted, false);
  assert.equal(evaluateComment({ ...args, currentHead: sha('b') }).decision, 'WAIT');
});

test('the rendered comment stays under the GitHub limit with a full set of findings; the JSON is never the part that is dropped', () => {
  const state = base();
  state.findings = Array.from({ length: 40 }, (_, i) => ({ id: `F${String(i + 1).padStart(3, '0')}`, severity: 'P2', title: 't'.repeat(200), path: `src/${'p'.repeat(100)}${i}.js`, failure_path: 'f'.repeat(600), verification: 'OPEN', checked_head_sha: sha('a') }));
  const body = renderComment(state);
  assert.ok(body.length < 65536);
  assert.equal(parseComment(body).value.findings.length, 40);
});
