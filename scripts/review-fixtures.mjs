// Generates the shared contract fixtures from the REAL parser, serializer and state transitions, never from
// hand-written expectations. `expected` comes from the transition that produced a comment (or from how a negative
// case was constructed), not from the parser a consumer will run.
//
//   npm run review:fixtures            writes tests/fixtures/review-contract.json
//   npm run test:compat -- [--in file] evaluates a fixtures file with the consumer-side code (default: the committed one)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOT_LOGIN, MARKER, SCHEMA_VERSION, evaluateComment, isBlocking, renderComment } from './review-contract.mjs';
import { applyBatch, claimAttempt, concludeRound, makeScope, parseBatchOutput, planRun, stopRun, stoppedState } from './review-engine.mjs';

const REPO = 'owner/repo';
const PR = 123;
const sha = (c) => c.repeat(40);
const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);
const FILES = ['src/a.js', 'src/b.js'];
const SCOPE = makeScope({ mergeBase: sha('0'), files: FILES });
export const FIXTURES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/review-contract.json');

export const modelOutput = ({ findings = [], prior = [], reviewed = FILES, unreviewed = [], complete = true } = {}) => {
  const parsed = parseBatchOutput({ summary: 's', findings, prior_findings: prior, coverage: { complete, reviewedPaths: reviewed, unreviewedPaths: unreviewed, note: '' } });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const P1 = { severity: 'P1', title: 'Upload retry drops the last chunk', path: 'src/a.js', failure_path: 'When the second attempt starts, the final chunk is skipped so the file is truncated.' };
const P2 = { severity: 'P2', title: 'Cache never expires', path: 'src/b.js', failure_path: 'A stale entry is served forever after the source changes.' };

// One real attempt: record it, fold the model output in, conclude the round if coverage is complete.
export function attempt({ prev = null, head, output, assigned = FILES }) {
  const claimed = claimAttempt({ prev, repo: REPO, prNumber: PR, head, scope: SCOPE, now: NOW });
  const applied = applyBatch({ state: claimed, assigned, output, needsRead: new Map(), reads: new Map(), now: NOW });
  return applied.state.reviewed_files.length === FILES.length ? concludeRound(applied.state, NOW) : applied.state;
}
const decisionOf = (state) => (state.status === 'IN_PROGRESS' ? 'WAIT' : state.status);

export function buildFixtureCases() {
  const cases = [];
  const add = ({ name, state = null, body = null, head, current = head, local = head, login = BOT_LOGIN, type = 'Bot', repo = REPO, pr = PR, expected }) => {
    cases.push({
      name, repo, pr_number: pr, local_head_sha: local, current_head_sha: current,
      comment_author_login: login, comment_author_type: type, comment_body: body ?? (state ? renderComment(state) : ''), expected,
    });
  };
  const h1 = sha('a'); const h2 = sha('b'); const h3 = sha('c');

  const ready1 = attempt({ head: h1, output: modelOutput() });
  add({ name: 'round 1 complete, READY', state: ready1, head: h1, expected: { trusted: true, decision: decisionOf(ready1) } });
  const changes = attempt({ head: h1, output: modelOutput({ findings: [P1] }) });
  add({ name: 'round 1 complete with a blocker, CHANGES_REQUESTED', state: changes, head: h1, expected: { trusted: true, decision: decisionOf(changes) } });
  const fixed = attempt({ prev: changes, head: h2, output: modelOutput({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'chunk loop fixed' }] }) });
  add({ name: 'round 2 complete, earlier blocker verified FIXED, READY', state: fixed, head: h2, expected: { trusted: true, decision: decisionOf(fixed) } });
  const unfixed = attempt({ prev: changes, head: h2, output: modelOutput({ prior: [{ id: 'F001', verification: 'STILL_OPEN', evidence: 'still skipped' }] }) });
  add({ name: 'round 2 complete, blocker STILL_OPEN, STOPPED', state: unfixed, head: h2, expected: { trusted: true, decision: decisionOf(unfixed) } });
  const omitted = attempt({ prev: changes, head: h2, output: modelOutput() });
  add({ name: 'round 2 complete, blocker omitted (never counts as fixed), STOPPED', state: omitted, head: h2, expected: { trusted: true, decision: decisionOf(omitted) } });
  const third = planRun({ pr: { state: 'open', draft: false, head_sha: h3 }, requestedHead: h3, read: { kind: 'ok', state: fixed }, now: NOW });
  if (third.action !== 'budget_stop') throw new Error(`policy no longer stops a third round: ${third.action}`);
  const budget = stoppedState({ prev: fixed, repo: REPO, prNumber: PR, head: h3, reason: third.reason, now: NOW });
  add({ name: 'both rounds used, new HEAD is not reviewed, STOPPED', state: budget, head: h3, expected: { trusted: true, decision: decisionOf(budget) } });

  const partial = attempt({ head: h1, output: modelOutput({ findings: [P2], reviewed: ['src/a.js'], unreviewed: ['src/b.js'], complete: false }) });
  add({ name: 'same-round progress with a P2 is IN_PROGRESS, never CHANGES_REQUESTED', state: partial, head: h1, expected: { trusted: true, decision: decisionOf(partial) } });
  const paused = stopRun(partial, 'This run used its 6 attempts; 1 of 2 file(s) not yet reviewed. Request a review again to continue where it stopped.', NOW);
  add({ name: 'technical stop with partial coverage keeps the finding, STOPPED', state: paused, head: h1, expected: { trusted: true, decision: decisionOf(paused) } });

  add({ name: 'stale HEAD: remote moved on', state: ready1, head: h1, current: h2, expected: { trusted: true, decision: 'WAIT' } });
  add({ name: 'stale HEAD: local checkout differs from reviewed commit', state: ready1, head: h1, local: h2, current: h1, expected: { trusted: true, decision: 'WAIT' } });
  add({ name: 'forged author (ordinary user, valid-looking JSON)', state: ready1, head: h1, login: 'mallory', type: 'User', expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'forged author with the bot name but a User account', state: ready1, head: h1, login: BOT_LOGIN, type: 'User', expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'output missing', body: '', head: h1, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'output corrupted (truncated JSON)', body: `${MARKER}\n\`\`\`json\n{"schema_version":2\n\`\`\`\n`, head: h1, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'retired schema_version 1 document is never a pass', body: `${MARKER}\n\`\`\`json\n${JSON.stringify({ schema_version: 1, mode: 'delivery-v1', repo: REPO, pr_number: PR, reviewed_head_sha: h1, status: 'READY', reason: 'x', review_runs_used: 1, review_runs_limit: 2, coverage_complete: true, findings: [] })}\n\`\`\`\n`, head: h1, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'state for another repository', state: ready1, head: h1, repo: 'other/repo', expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'state for another pull request', state: ready1, head: h1, pr: 999, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'READY that contradicts its own findings', body: renderComment({ ...changes, status: 'READY' }), head: h1, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'READY on a HEAD no round has completed', body: renderComment({ ...ready1, completed_head_sha: h2 }), head: h1, expected: { trusted: false, decision: 'WAIT' } });
  const running = claimAttempt({ prev: null, repo: REPO, prNumber: PR, head: h1, scope: SCOPE, now: NOW });
  add({ name: 'review still IN_PROGRESS', state: running, head: h1, expected: { trusted: true, decision: decisionOf(running) } });
  return cases;
}

// Informative: how one batch result changes the state. A batch that reports nothing about an earlier blocker can
// never remove it, and an old FIXED/P3 never hides a repeated report.
export function buildTransitions() {
  const h1 = sha('a');
  const start = attempt({ head: h1, output: modelOutput({ findings: [P2], reviewed: ['src/a.js'], unreviewed: ['src/b.js'], complete: false }) });
  const step = (name, output, assigned, expectedBlocking) => {
    const claimed = claimAttempt({ prev: start, repo: REPO, prNumber: PR, head: h1, scope: SCOPE, now: NOW });
    const applied = applyBatch({ state: claimed, assigned, output, needsRead: new Map(), reads: new Map(), now: NOW });
    const result = applied.state.reviewed_files.length === FILES.length ? concludeRound(applied.state, NOW) : applied.state;
    return { name, prev_state: start, assigned, result_state: result, expected: { blocking_ids: expectedBlocking, blocking_ids_actual: result.findings.filter(isBlocking).map((f) => f.id) } };
  };
  return [
    step('a batch that reports nothing keeps the earlier P2', modelOutput({ reviewed: ['src/b.js'] }), ['src/b.js'], ['F001']),
    step('the same issue reported as P3 never downgrades the P2', modelOutput({ findings: [{ ...P2, severity: 'P3', failure_path: '' }], reviewed: ['src/b.js'] }), ['src/b.js'], ['F001']),
  ];
}

export function buildFixtures() {
  return { schema_version: SCHEMA_VERSION, cases: buildFixtureCases(), transitions: buildTransitions() };
}

export function checkFixtures(fixtures) {
  const failures = [];
  if (fixtures?.schema_version !== SCHEMA_VERSION || !Array.isArray(fixtures.cases)) return ['fixtures file has the wrong shape'];
  for (const c of fixtures.cases) {
    const actual = evaluateComment({ repo: c.repo, prNumber: c.pr_number, localHead: c.local_head_sha, currentHead: c.current_head_sha, authorLogin: c.comment_author_login, authorType: c.comment_author_type, body: c.comment_body });
    if (actual.trusted !== c.expected.trusted || actual.decision !== c.expected.decision) failures.push(`${c.name}: expected ${JSON.stringify(c.expected)} but got ${JSON.stringify(actual)}`);
  }
  for (const t of fixtures.transitions ?? []) {
    if (JSON.stringify(t.expected.blocking_ids) !== JSON.stringify(t.expected.blocking_ids_actual)) failures.push(`transition ${t.name}: blockers changed`);
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check') || args.includes('--in')) {
    const i = args.indexOf('--in');
    const file = i >= 0 ? path.resolve(args[i + 1]) : FIXTURES_PATH;
    const fixtures = JSON.parse(fs.readFileSync(file, 'utf8'));
    const failures = checkFixtures(fixtures);
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; return; }
    console.log(`review contract: ${fixtures.cases.length} case(s) ok`);
    return;
  }
  fs.mkdirSync(path.dirname(FIXTURES_PATH), { recursive: true });
  fs.writeFileSync(FIXTURES_PATH, `${JSON.stringify(buildFixtures(), null, 2)}\n`);
  console.log(`Wrote ${FIXTURES_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
