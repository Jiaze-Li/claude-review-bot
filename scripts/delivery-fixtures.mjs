// Generates compat fixtures for delivery-v1 from the REAL policy and serialization code (claim / finalize /
// budget / render), never from hand-written expectations. `expected` comes from the policy outcome that produced
// the comment (or from how a negative case was constructed), not from the parser the consumer will run.
//
//   npm run delivery:fixtures -- --out /absolute/path/delivery-fixtures.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOT_LOGIN, DELIVERY_MARKER, budgetStoppedState, claimState, finalizeRun, parseModelOutput, planDelivery, renderDeliveryComment,
} from './delivery-protocol.mjs';

const REPO = 'owner/repo';
const PR = 123;
const sha = (c) => c.repeat(40);
const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);
const FILES = ['src/a.js', 'src/b.js'];

const output = ({ findings = [], prior = [], complete = true } = {}) => {
  const parsed = parseModelOutput({
    summary: 's', findings, prior_findings: prior,
    coverage: { complete, reviewedPaths: complete ? FILES : FILES.slice(0, 1), note: '' },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const P1 = { severity: 'P1', title: 'Upload retry drops the last chunk', path: 'src/a.js', failure_path: 'When the second attempt starts, the final chunk is skipped so the file is truncated.' };

// One real review run: claim the slot, then fold the model output in.
const run = ({ prev = null, head, out }) => finalizeRun({ claimed: claimState({ prev, repo: REPO, prNumber: PR, head, now: NOW }), output: out, changedFiles: FILES, now: NOW });
const decisionOf = (state) => (state.status === 'IN_PROGRESS' ? 'WAIT' : state.status);

export function buildFixtureCases() {
  const cases = [];
  const add = ({ name, state = null, body = null, head, current = head, local = head, login = BOT_LOGIN, type = 'Bot', repo = REPO, pr = PR, expected }) => {
    cases.push({
      name, repo, pr_number: pr, local_head_sha: local, current_head_sha: current,
      comment_author_login: login, comment_author_type: type, comment_body: body ?? (state ? renderDeliveryComment(state) : ''), expected,
    });
  };

  const h1 = sha('a'); const h2 = sha('b'); const h3 = sha('c');
  const first = run({ head: h1, out: output() });
  add({ name: 'first run READY', state: first, head: h1, expected: { trusted: true, decision: decisionOf(first) } });

  const changes = run({ head: h1, out: output({ findings: [P1] }) });
  add({ name: 'first run CHANGES_REQUESTED', state: changes, head: h1, expected: { trusted: true, decision: decisionOf(changes) } });

  const fixed = run({ prev: changes, head: h2, out: output({ prior: [{ id: 'F001', verification: 'FIXED', evidence: 'chunk loop fixed' }] }) });
  add({ name: 'second run READY after fix', state: fixed, head: h2, expected: { trusted: true, decision: decisionOf(fixed) } });

  const unfixed = run({ prev: changes, head: h2, out: output({ prior: [{ id: 'F001', verification: 'STILL_OPEN', evidence: 'still skipped' }] }) });
  add({ name: 'second run STOPPED when blocker remains', state: unfixed, head: h2, expected: { trusted: true, decision: decisionOf(unfixed) } });

  const omitted = run({ prev: changes, head: h2, out: output() });
  add({ name: 'second run STOPPED when blocker is omitted (not FIXED)', state: omitted, head: h2, expected: { trusted: true, decision: decisionOf(omitted) } });

  const plan = planDelivery({
    pr: { state: 'open', draft: false, head_sha: h3, labels: ['delivery-v1'] }, requestedHead: h3,
    read: { kind: 'ok', state: fixed }, legacy: false, now: NOW,
  });
  if (plan.action !== 'budget_stop') throw new Error(`policy no longer stops the third run: ${plan.action}`);
  const budget = budgetStoppedState({ prev: fixed, repo: REPO, prNumber: PR, head: h3, now: NOW, reason: plan.reason });
  add({ name: 'budget STOPPED on a third model request', state: budget, head: h3, expected: { trusted: true, decision: decisionOf(budget) } });

  add({ name: 'stale HEAD: remote moved on', state: first, head: h1, current: h2, expected: { trusted: true, decision: 'WAIT' } });
  add({ name: 'stale HEAD: local checkout differs from reviewed commit', state: first, head: h1, local: h2, current: h1, expected: { trusted: true, decision: 'WAIT' } });
  add({ name: 'forged author (ordinary user, valid-looking JSON)', state: first, head: h1, login: 'mallory', type: 'User', expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'forged author with the bot name but a User account', state: first, head: h1, login: BOT_LOGIN, type: 'User', expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'output missing', body: '', head: h1, expected: { trusted: false, decision: 'WAIT' } });
  add({ name: 'output corrupted (truncated JSON)', body: `${DELIVERY_MARKER}\n\`\`\`json\n{"schema_version":1,"mode":"delivery-v1"\n\`\`\`\n`, head: h1, expected: { trusted: false, decision: 'STOPPED' } });
  add({ name: 'state for another repository', state: first, head: h1, repo: 'other/repo', expected: { trusted: false, decision: 'STOPPED' } });
  add({ name: 'state for another pull request', state: first, head: h1, pr: 999, expected: { trusted: false, decision: 'STOPPED' } });
  add({ name: 'READY that contradicts its own findings', body: renderDeliveryComment({ ...changes, status: 'READY', coverage_complete: true }), head: h1, expected: { trusted: false, decision: 'STOPPED' } });
  const inProgress = claimState({ prev: null, repo: REPO, prNumber: PR, head: h1, now: NOW });
  add({ name: 'review still IN_PROGRESS', state: inProgress, head: h1, expected: { trusted: true, decision: decisionOf(inProgress) } });
  return cases;
}

export function buildFixtures() {
  return { schema_version: 1, cases: buildFixtureCases() };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 ? args[i + 1] : null;
  if (!out || !path.isAbsolute(out)) {
    console.error('Usage: npm run delivery:fixtures -- --out /absolute/path/delivery-fixtures.json');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(buildFixtures(), null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
