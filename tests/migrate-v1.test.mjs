import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateOne } from '../scripts/migrate-v1.mjs';
import { BOT_LOGIN, MARKER, MAX_ATTEMPTS } from '../scripts/review-contract.mjs';
import { fakeGithub, review, scriptedProvider, makeContext, model, sha, REPO, PR } from './helpers/harness.mjs';

const v1 = (over = {}) => ({
  schema_version: 1, mode: 'delivery-v1', repo: REPO, pr_number: PR, reviewed_head_sha: sha('a'), status: 'STOPPED',
  reason: 'Review coverage incomplete (20 changed file(s) not reviewed); no READY without full coverage.',
  review_runs_used: 1, review_runs_limit: 2, coverage_complete: false, findings: [], updated_at: '2026-11-21T12:50:38.471Z', ...over,
});
const comment = (doc) => ({ id: '55', source: 'issue', login: BOT_LOGIN, type: 'Bot', body: `${MARKER}\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n\nold text\n` });
const mergeBaseOf = async () => sha('0');
const opts = { repo: REPO, prNumber: PR, mergeBaseOf, now: Date.UTC(2026, 10, 22) };

test('#219 shaped record: dry-run changes nothing; apply keeps the comment, keeps the spent attempt, invents no round and no progress', async () => {
  const gh = fakeGithub({ comments: [comment(v1())] });
  const dry = await migrateOne({ github: gh, ...opts });
  assert.equal(dry.result, 'would-migrate');
  assert.equal(gh.writes.length, 0);

  const done = await migrateOne({ github: gh, ...opts, apply: true });
  assert.equal(done.result, 'migrated');
  assert.equal(gh.comments.length, 1);
  assert.equal(gh.comments[0].id, '55');
  const s = gh.state_().state;
  assert.equal(s.schema_version, 2);
  assert.equal(s.completed_rounds, 0);
  assert.equal(s.attempts_used, 1);
  assert.deepEqual(s.reviewed_files, []);
  assert.match(s.reason, /Migrated from schema_version 1/);
  assert.match(s.reason, /20 changed file/);
});

test('migrating again changes nothing, and never re-initialises the budget', async () => {
  const gh = fakeGithub({ comments: [comment(v1())] });
  await migrateOne({ github: gh, ...opts, apply: true });
  const before = gh.comments[0].body;
  const again = await migrateOne({ github: gh, ...opts, apply: true });
  assert.equal(again.result, 'already-v2');
  assert.equal(gh.comments[0].body, before);
});

test('findings survive, a complete v1 round stays a complete round, and what cannot be known is reported, not guessed', async () => {
  const finding = { id: 'F001', severity: 'P1', title: 'bug', path: 'a.js', failure_path: 'breaks', verification: 'OPEN' };
  const gh = fakeGithub({ comments: [comment(v1({ status: 'CHANGES_REQUESTED', coverage_complete: true, findings: [finding], review_runs_used: 1 }))] });
  await migrateOne({ github: gh, ...opts, apply: true });
  const s = gh.state_().state;
  assert.equal(s.status, 'CHANGES_REQUESTED');
  assert.equal(s.completed_rounds, 1);
  assert.equal(s.completed_head_sha, sha('a'));
  assert.equal(s.findings[0].id, 'F001');

  const unknown = fakeGithub({ comments: [comment(v1({ review_runs_used: 2, coverage_complete: false }))] });
  const r = await migrateOne({ github: unknown, ...opts, apply: true });
  assert.equal(r.result, 'not-convertible');
  assert.equal(unknown.writes.length, 0);
  const other = fakeGithub({ comments: [comment(v1({ repo: 'x/y' }))] });
  assert.equal((await migrateOne({ github: other, ...opts, apply: true })).result, 'not-convertible');
});

test('after migration the same PR and HEAD gets a full review under the new rules, with the old attempt still counted', async () => {
  const gh = fakeGithub({ head: sha('a'), comments: [comment(v1())] });
  await migrateOne({ github: gh, ...opts, apply: true });
  const names = Array.from({ length: 26 }, (_, i) => `src/f${i}.js`);
  const provider = scriptedProvider((c) => model.ok({ assigned: c.assigned }));
  const r = await review({ gh, provider, ctx: makeContext(names) });
  const s = gh.state_().state;
  assert.equal(r.status, 'READY');
  assert.equal(s.completed_rounds, 1);
  assert.equal(s.attempts_used, 1 + provider.calls.length);
  assert.ok(s.attempts_used <= MAX_ATTEMPTS);
  assert.equal(gh.comments.length, 1);
});

test('before migration the runner refuses to treat the v1 document as state (no silent restart, no pass)', async () => {
  const gh = fakeGithub({ comments: [comment(v1())] });
  const provider = scriptedProvider((c) => model.ok({ assigned: c.assigned }));
  const r = await review({ gh, provider, ctx: makeContext(['a.js']) });
  assert.equal(r.action, 'stop_untrusted');
  assert.equal(provider.calls.length, 0);
  assert.equal(gh.statuses.at(-1).state, 'error');
});
