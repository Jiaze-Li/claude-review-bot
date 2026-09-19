import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publishRunStatus } from '../scripts/review-status.mjs';

const baseEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'Jiaze-Li/claude-review-bot',
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '2',
  GH_TOKEN: 'synthetic-test-token',
  TARGET_REPO: 'acme/project',
  PR_NUMBER: '7',
  SOURCE_COMMENT_ID: '99',
  HEAD_SHA: 'a'.repeat(40),
  STATUS_STAGE: 'started',
  PREFLIGHT_OUTCOME: 'success',
  REVIEW_MODE: 'discovery',
  REVIEW_REASON: 'new review session',
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

test('verified workflow posts generic run-linked discovery status', async () => {
  const fake = fakeFetch();
  assert.equal(await publishRunStatus({ env: baseEnv, fetchImpl: fake.fetchImpl }), '5678');
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.github.com/repos/acme/project/issues/7/comments');
  assert.match(call.body, /actions\/runs\/1234\/attempts\/2/);
  assert.match(call.body, /issuecomment-99/);
  assert.ok(call.body.includes(baseEnv.HEAD_SHA));
  assert.match(call.body, /Gemini discovery review is running/);
  assert.match(call.body, /Independent review/);
  assert.doesNotMatch(call.body, /👀|synthetic-test-token/);
});

for (const mode of ['verification', 'audit', 'recover', 'claude', 'noop_ready', 'noop_waiting', 'human_required']) {
  test(`status renders supported review mode ${mode}`, async () => {
    const fake = fakeFetch();
    await publishRunStatus({
      env: { ...baseEnv, REVIEW_MODE: mode, REVIEW_REASON: 'bounded-session reason' },
      fetchImpl: fake.fetchImpl,
    });
    assert.match(fake.calls[0].body, new RegExp(mode === 'verification'
      ? 'Gemini targeted verification'
      : mode === 'audit'
        ? 'Gemini one-time final audit'
        : mode === 'recover'
        ? 'Recovering durable session state'
        : mode === 'claude'
          ? 'Claude deep review'
          : 'No model call'));
  });
}

for (const [field, value] of [
  ['GITHUB_ACTIONS', undefined],
  ['GITHUB_RUN_ID', undefined],
  ['PREFLIGHT_OUTCOME', 'failure'],
  ['PREFLIGHT_OUTCOME', 'skipped'],
  ['PREFLIGHT_OUTCOME', undefined],
  ['HEAD_SHA', 'wrong'],
  ['TARGET_REPO', 'acme/project/other'],
  ['SOURCE_COMMENT_ID', '99\nextra'],
  ['REVIEW_MODE', 'unknown'],
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
  test(`Gemini final status reports publication outcome ${outcome}`, async () => {
    const fake = fakeFetch();
    await publishRunStatus({
      env: {
        ...baseEnv,
        STATUS_STAGE: 'finished',
        STATUS_COMMENT_ID: '5678',
        GEMINI_PUBLISH_OUTCOME: outcome,
      },
      fetchImpl: fake.fetchImpl,
    });
    assert.equal(fake.calls[0].method, 'PATCH');
    assert.equal(fake.calls[0].url, 'https://api.github.com/repos/acme/project/issues/comments/5678');
    assert.match(fake.calls[0].body, outcome === 'success' ? /publication completed/ : /publication was not confirmed/);
  });
}

test('skipped final audit does not mask a successful Gemini publication', async () => {
  const fake = fakeFetch();
  await publishRunStatus({
    env: {
      ...baseEnv,
      STATUS_STAGE: 'finished',
      STATUS_COMMENT_ID: '5678',
      GEMINI_PUBLISH_OUTCOME: 'success',
      FINAL_AUDIT_PUBLISH_OUTCOME: 'skipped',
    },
    fetchImpl: fake.fetchImpl,
  });
  assert.match(fake.calls[0].body, /publication completed/);
});

test('bounded no-op final status explicitly says zero model quota', async () => {
  const fake = fakeFetch();
  await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: 'noop_waiting',
      REVIEW_REASON: 'push a repair before verification',
      STATUS_STAGE: 'finished',
      STATUS_COMMENT_ID: '5678',
    },
    fetchImpl: fake.fetchImpl,
  });
  assert.match(fake.calls[0].body, /No model quota was spent/);
  assert.match(fake.calls[0].body, /jiaze-review-source-comment:99/);
});

test('failed status write cannot invent a comment id or echo sensitive response content', async () => {
  await assert.rejects(
    publishRunStatus({
      env: baseEnv,
      fetchImpl: async () => new Response('sensitive-content', { status: 403 }),
    }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes('sensitive-content'),
  );
});

test('finished status cannot update an unknown comment', async () => {
  const fake = fakeFetch();
  await assert.rejects(publishRunStatus({
    env: { ...baseEnv, STATUS_STAGE: 'finished' },
    fetchImpl: fake.fetchImpl,
  }));
  assert.equal(fake.calls.length, 0);
});

test('v2 workflow isolates provider credentials and serializes durable PR sessions', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const context = yml.indexOf('- name: Build exact PR review context');
  const plan = yml.indexOf('- name: Plan durable review session');
  const started = yml.indexOf('- name: Announce verified workflow start');
  const recover = yml.indexOf('- name: Recover published session without model spend');
  const gemini = yml.indexOf('- name: Run Gemini bounded review');
  const validator = yml.indexOf('- name: Validate Gemini material findings');
  const publishGemini = yml.indexOf('- name: Publish Gemini review and durable session');
  const autoAudit = yml.indexOf('- name: Prepare automatic final audit');
  const runFinalAudit = yml.indexOf('- name: Run automatic Gemini final audit');
  const validateFinalAudit = yml.indexOf('- name: Validate automatic final audit findings');
  const publishFinalAudit = yml.indexOf('- name: Publish automatic final audit');
  const claude = yml.indexOf('- name: Run Claude explicit deep review');
  const finished = yml.indexOf('- name: Finalize workflow status');

  assert.ok(context < plan && plan < started && started < recover && recover < gemini && gemini < validator && validator < publishGemini && publishGemini < autoAudit && autoAudit < runFinalAudit && runFinalAudit < validateFinalAudit && validateFinalAudit < publishFinalAudit && publishFinalAudit < claude && claude < finished);
  assert.match(yml, /group: independent-review-\$\{\{ inputs\.target_repo \}\}-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(yml, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  const recoverBlock = yml.slice(recover, gemini);
  assert.doesNotMatch(recoverBlock, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(yml, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  const geminiBlock = yml.slice(gemini, publishGemini);
  assert.doesNotMatch(geminiBlock, /GH_TOKEN|app-token\.outputs\.token/);
  const validatorBlock = yml.slice(validator, publishGemini);
  assert.match(validatorBlock, /thinkingLevel|validate-gemini-findings|TARGET_REPO_DIR: target/);
  assert.doesNotMatch(validatorBlock, /GH_TOKEN|app-token\.outputs\.token/);
  const publishClaude = yml.indexOf('- name: Publish Claude explicit deep review');
  const claudeBlock = yml.slice(claude, publishClaude);
  assert.doesNotMatch(claudeBlock, /GH_TOKEN|app-token\.outputs\.token/);
  assert.match(yml, /permission-issues: read/);
  assert.match(yml, /permission-pull-requests: write/);
  assert.doesNotMatch(yml, /permission-contents: write/);
});


test('legacy review.yml is a thin auto-mode wrapper over review-v2', () => {
  const legacy = fs.readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
  const v2 = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.match(legacy, /uses: \.\/\.github\/workflows\/review-v2\.yml/);
  assert.match(legacy, /requested_mode: auto/);
  assert.match(legacy, /secrets: inherit/);
  assert.doesNotMatch(legacy, /Run Claude|Run Gemini|GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(v2, /workflow_call:/);
  assert.match(v2, /requested_mode:\n\s+required: false\n\s+default: auto/);
});
