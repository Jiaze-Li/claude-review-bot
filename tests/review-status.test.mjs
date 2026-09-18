import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publishRunStatus } from '../scripts/review-status.mjs';

const baseEnv = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Jiaze-Li/claude-review-bot',
  GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', GH_TOKEN: 'synthetic-test-token',
  TARGET_REPO: 'acme/project', PR_NUMBER: '7', SOURCE_COMMENT_ID: '99',
  HEAD_SHA: 'a'.repeat(40), STATUS_STAGE: 'started', PREFLIGHT_OUTCOME: 'success',
};
function fakeFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body).body });
      return Response.json({ id: 5678 });
    },
  };
}
test('verified workflow posts a run-linked start status, not an eyes reaction or completion marker', async () => {
  const fake = fakeFetch();
  assert.equal(await publishRunStatus({ env: baseEnv, fetchImpl: fake.fetchImpl }), '5678');
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.github.com/repos/acme/project/issues/7/comments');
  assert.match(call.body, /actions\/runs\/1234\/attempts\/2/);
  assert.match(call.body, /issuecomment-99/);
  assert.ok(call.body.includes(baseEnv.HEAD_SHA));
  assert.match(call.body, /Workflow started; preflight passed/);
  assert.doesNotMatch(call.body, /claude-review-source-comment:|👀|synthetic-test-token/);
});
for (const [field, value] of [
  ['GITHUB_ACTIONS', undefined], ['GITHUB_RUN_ID', undefined],
  ['PREFLIGHT_OUTCOME', 'failure'], ['PREFLIGHT_OUTCOME', 'skipped'],
  ['PREFLIGHT_OUTCOME', undefined], ['HEAD_SHA', 'wrong'],
  ['TARGET_REPO', 'acme/project/other'], ['SOURCE_COMMENT_ID', '99\nextra'],
]) {
  test(`no status before valid workflow identity and preflight: ${field}=${value}`, async () => {
    const fake = fakeFetch();
    await assert.rejects(publishRunStatus({ env: { ...baseEnv, [field]: value }, fetchImpl: fake.fetchImpl }));
    assert.equal(fake.calls.length, 0);
  });
}
test('deduplicated run never posts an extra started status', async () => {
  const fake = fakeFetch();
  assert.equal(await publishRunStatus({ env: { ...baseEnv, DUPLICATE: 'true' }, fetchImpl: fake.fetchImpl }), null);
  assert.equal(fake.calls.length, 0);
});
for (const outcome of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
  test(`final status updates the same comment and reports publication outcome ${outcome}`, async () => {
    const fake = fakeFetch();
    await publishRunStatus({
      env: { ...baseEnv, STATUS_STAGE: 'finished', STATUS_COMMENT_ID: '5678', PUBLISH_OUTCOME: outcome },
      fetchImpl: fake.fetchImpl,
    });
    assert.equal(fake.calls[0].method, 'PATCH');
    assert.equal(fake.calls[0].url, 'https://api.github.com/repos/acme/project/issues/comments/5678');
    assert.match(fake.calls[0].body, outcome === 'success' ? /publication step completed/ : /Review publication was not confirmed/);
    assert.doesNotMatch(fake.calls[0].body, /claude-review-source-comment:|👀/);
  });
}
test('failed status write cannot invent a comment id or echo sensitive response content', async () => {
  await assert.rejects(publishRunStatus({ env: baseEnv, fetchImpl: async () => new Response('sensitive-content', { status: 403 }) }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes('sensitive-content'));
});
test('finished status cannot update an unknown comment', async () => {
  const fake = fakeFetch();
  await assert.rejects(publishRunStatus({ env: { ...baseEnv, STATUS_STAGE: 'finished' }, fetchImpl: fake.fetchImpl }));
  assert.equal(fake.calls.length, 0);
});
test('workflow wires status after exact-head preflight and preserves isolated Claude credentials', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
  const preflight = yml.indexOf('- name: Materialize safe read-only source snapshot');
  const started = yml.indexOf('- name: Announce verified workflow start');
  const reviewer = yml.indexOf('- name: Run Claude with host-enforced read-only policy');
  const publisher = yml.indexOf('- name: Publish GitHub PR Review');
  const finished = yml.indexOf('- name: Finalize workflow status');
  assert.ok(preflight < started && started < reviewer && reviewer < publisher && publisher < finished);
  assert.match(yml.slice(started, reviewer), /steps\.snapshot\.outcome == 'success'/);
  assert.match(yml.slice(finished), /always\(\) && steps\.review-status\.outputs\.comment_id != ''/);
  assert.match(yml.slice(finished), /PUBLISH_OUTCOME: \$\{\{ steps\.publish\.outcome \}\}/);
  assert.doesNotMatch(yml.slice(reviewer, publisher), /GH_TOKEN|app-token\.outputs\.token/);
  assert.match(yml, /permission-issues: read/);
  assert.match(yml, /permission-pull-requests: write/);
  assert.doesNotMatch(yml, /permission-contents: write/);
});
