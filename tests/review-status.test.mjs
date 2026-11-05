import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishRunStatus } from '../scripts/review-status.mjs';
import { renderSessionComment } from '../scripts/review-session-core.mjs';

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
  REVIEW_MODE: 'incremental',
  REVIEW_REASON: 'small delta on a reviewed state',
};

function fakeFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body).body : undefined });
      return Response.json({ id: 5678 });
    },
  };
}

const defaultSession = {
  version: 1,
  status: "READY",
  findings: [],
  verificationRound: 0,
  maxVerificationRounds: 3,
  auditCompleted: true,
  lastReviewedHead: baseEnv.HEAD_SHA,
  baseSha: baseEnv.HEAD_SHA,
  fullAuditHead: baseEnv.HEAD_SHA,
  deepSpendUsd: 0,
};

test('verified workflow start is silent and posts no comment', async () => {
  const fake = fakeFetch();
  const res = await publishRunStatus({ env: baseEnv, fetchImpl: fake.fetchImpl });
  assert.equal(res, null);
  assert.equal(fake.calls.length, 0);
});

test('automatic PR trigger start status is also silent and validates inputs', async () => {
  const fake = fakeFetch();
  const res = await publishRunStatus({
    env: { ...baseEnv, SOURCE_KIND: 'pull_request', SOURCE_COMMENT_ID: '123456789' },
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(res, null);
  assert.equal(fake.calls.length, 0);
});

for (const mode of ['verification', 'recover', 'claude', 'noop_ready', 'noop_waiting', 'human_required']) {
  test(`started status is silent for review mode ${mode}`, async () => {
    const fake = fakeFetch();
    const res = await publishRunStatus({
      env: { ...baseEnv, REVIEW_MODE: mode, REVIEW_REASON: 'bounded-session reason' },
      fetchImpl: fake.fetchImpl,
    });
    assert.equal(res, null);
    assert.equal(fake.calls.length, 0);
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
  ['SOURCE_KIND', 'unknown'],
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

test('Gemini final status is silent when publication succeeds', async () => {
  const fake = fakeFetch();
  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      STATUS_STAGE: 'finished',
      STATUS_COMMENT_ID: '5678',
      GEMINI_PUBLISH_OUTCOME: 'success',
    },
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(res, null);
  assert.equal(fake.calls.length, 0);
});

for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
  test(`Gemini final status reports unconfirmed publication on ${outcome}`, async () => {
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
    assert.match(fake.calls[0].body, /publication was not confirmed/);
    assert.match(fake.calls[0].body, /jiaze-review-source-comment:99/);
  });
}

test('human_required final status posts human prompt containing idempotency marker', async () => {
  const fake = fakeFetch();
  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: 'human_required',
      REVIEW_REASON: 'verification budget exhausted',
      STATUS_STAGE: 'finished',
    },
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(res, '5678');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, 'POST');
  assert.match(fake.calls[0].body, /No model quota was spent\. verification budget exhausted/);
  assert.match(fake.calls[0].body, /jiaze-review-source-comment:99/);
});

test('bounded no-op with session comment silently attaches dedupe marker without conversational noise', async () => {
  const dummySession = {
    version: 1,
    status: 'READY',
    findings: [],
    verificationRound: 0,
    maxVerificationRounds: 3,
    auditCompleted: true,
    lastReviewedHead: baseEnv.HEAD_SHA,
    baseSha: baseEnv.HEAD_SHA,
    fullAuditHead: baseEnv.HEAD_SHA,
    deepSpendUsd: 0,
  };
  const dummyPlan = {
    sessionCommentId: '5678',
    session: dummySession,
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body).body : undefined });
    if (!options.method || options.method === 'GET') {
      return Response.json({
        id: 5678,
        body: renderSessionComment(dummySession),
      });
    }
    return Response.json({ id: 5678 });
  };

  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: 'noop_ready',
      REVIEW_REASON: 'review clear on this HEAD',
      STATUS_STAGE: 'finished',
    },
    fetchImpl,
    plan: dummyPlan,
  });
  assert.equal(res, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].body, /jiaze-review-source-comment:99/);
  assert.match(calls[1].body, /Independent Review Session/);
  assert.doesNotMatch(calls[1].body, /### Independent review\n/);
});

test('recordSessionMarker preserves live session state from GitHub rather than stale pre-run plan', async () => {
  const staleSession = {
    version: 1,
    status: 'REWORK',
    findings: [],
    verificationRound: 1,
    maxVerificationRounds: 3,
    auditCompleted: false,
    lastReviewedHead: baseEnv.HEAD_SHA,
    baseSha: baseEnv.HEAD_SHA,
    fullAuditHead: baseEnv.HEAD_SHA,
    deepSpendUsd: 0,
  };
  const liveSession = {
    version: 1,
    status: 'READY',
    findings: [],
    verificationRound: 2,
    maxVerificationRounds: 3,
    auditCompleted: true,
    lastReviewedHead: baseEnv.HEAD_SHA,
    baseSha: baseEnv.HEAD_SHA,
    fullAuditHead: baseEnv.HEAD_SHA,
    deepSpendUsd: 0,
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (!options.method || options.method === 'GET') {
      return Response.json({
        id: 5678,
        body: renderSessionComment(liveSession, { sourceCommentIds: ['11'] }),
      });
    }
    return Response.json({ id: 5678 });
  };

  await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: 'noop_ready',
      REVIEW_REASON: 'review clear on this HEAD',
      STATUS_STAGE: 'finished',
    },
    fetchImpl,
    plan: { sessionCommentId: '5678', session: staleSession },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  // Patched body must preserve the live session status READY (not stale REWORK) and include both markers
  assert.match(calls[1].body, /Status: \*\*READY\*\*/);
  assert.match(calls[1].body, /jiaze-review-source-comment:11/);
  assert.match(calls[1].body, /jiaze-review-source-comment:99/);
});

test("recordSessionMarker fails closed on corrupted session comment and refuses to PATCH", async () => {
  const staleSession = {
    version: 1,
    status: "READY",
    findings: [],
    verificationRound: 0,
    maxVerificationRounds: 3,
    auditCompleted: true,
    lastReviewedHead: baseEnv.HEAD_SHA,
    baseSha: baseEnv.HEAD_SHA,
    fullAuditHead: baseEnv.HEAD_SHA,
    deepSpendUsd: 0,
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (!options.method || options.method === "GET") {
      return Response.json({
        id: 5678,
        body: "<!-- jiaze-review-session:v1 -->\nCorrupted body without state comment",
      });
    }
    return Response.json({ id: 5678 });
  };

  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: "noop_ready",
      REVIEW_REASON: "review clear on this HEAD",
      STATUS_STAGE: "finished",
    },
    fetchImpl,
    plan: { sessionCommentId: "5678", session: staleSession },
  });

  assert.equal(res, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("recordSessionMarker fails closed on HTTP error and refuses to PATCH", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    return new Response("Not found", { status: 404 });
  };

  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: "noop_ready",
      REVIEW_REASON: "review clear on this HEAD",
      STATUS_STAGE: "finished",
    },
    fetchImpl,
    plan: { sessionCommentId: "5678", session: defaultSession },
  });

  assert.equal(res, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("recordSessionMarker fails closed on network exception and refuses to PATCH", async () => {
  const fetchImpl = async () => {
    throw new Error("Network timeout");
  };

  const res = await publishRunStatus({
    env: {
      ...baseEnv,
      REVIEW_MODE: "noop_ready",
      REVIEW_REASON: "review clear on this HEAD",
      STATUS_STAGE: "finished",
    },
    fetchImpl,
    plan: { sessionCommentId: "5678", session: defaultSession },
  });

  assert.equal(res, null);
});

test('failed status write cannot invent a comment id or echo sensitive response content', async () => {
  await assert.rejects(
    publishRunStatus({
      env: {
        ...baseEnv,
        STATUS_STAGE: 'finished',
        GEMINI_PUBLISH_OUTCOME: 'failure',
      },
      fetchImpl: async () => new Response('sensitive-content', { status: 403 }),
    }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes('sensitive-content'),
  );
});

test('finished status rejects invalid comment id', async () => {
  const fake = fakeFetch();
  await assert.rejects(publishRunStatus({
    env: { ...baseEnv, STATUS_STAGE: 'finished', STATUS_COMMENT_ID: 'invalid_id' },
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
  const stopGemini = yml.indexOf('- name: Record provider-unavailable delta review');
  const validator = yml.indexOf('- name: Validate Gemini material findings');
  const publishGemini = yml.indexOf('- name: Publish Gemini review and durable session');
  const claude = yml.indexOf('- name: Run Claude explicit deep review');
  const finished = yml.indexOf('- name: Finalize workflow status');

  assert.ok(context < plan && plan < started && started < recover && recover < gemini && gemini < validator && validator < publishGemini && publishGemini < claude && claude < finished);
  assert.match(yml, /group: independent-review-\$\{\{ inputs\.target_repo \}\}-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(yml, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  const recoverBlock = yml.slice(recover, gemini);
  assert.doesNotMatch(recoverBlock, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(yml, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  // Only the trusted external-fact validator receives the scoped GitHub token.
  // The Gemini provider step remains isolated.
  const geminiBlock = yml.slice(gemini, stopGemini);
  assert.doesNotMatch(geminiBlock, /GH_TOKEN|app-token\.outputs\.token/);
  // Failure persistence is a separate GitHub-only step, never part of the provider's execution environment.
  const stopBlock = yml.slice(stopGemini, validator);
  assert.match(stopBlock, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(stopBlock, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
  const validatorBlock = yml.slice(validator, publishGemini);
  assert.match(validatorBlock, /thinkingLevel|validate-gemini-findings|TARGET_REPO_DIR: target/);
  assert.match(validatorBlock, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  // Claude fallback validates when Gemini is out of credits; the fallback subprocess is tool-less and gets a scrubbed env (see claude-fallback tests).
  assert.match(validatorBlock, /CLAUDE_CODE_OAUTH_TOKEN/);
  const publishClaude = yml.indexOf('- name: Publish Claude explicit deep review');
  const claudeBlock = yml.slice(claude, publishClaude);
  assert.doesNotMatch(claudeBlock, /GH_TOKEN|app-token\.outputs\.token/);
  assert.match(yml, /permission-issues: read/);
  assert.match(yml, /permission-pull-requests: write/);
  assert.doesNotMatch(yml, /permission-contents: write/);
  // Every full review (first, after a big change, the final one) is the sharded engine; the staged steps only
  // handle repairs and small deltas.
  assert.doesNotMatch(yml, /steps\.plan\.outputs\.mode == 'discovery'|steps\.plan\.outputs\.mode == 'audit'/);
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
  assert.match(v2, /source_kind:\n\s+required: false\n\s+default: comment/);
});

test('a failed run shows the recorded reason in the status comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reason-'));
  fs.writeFileSync(path.join(dir, 'failure-reason.txt'), "Gemini review context exceeds 1500000 bytes\nsecond line");
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body).body); return Response.json({ id: 7 }); };
  await publishRunStatus({
    env: {
      GITHUB_ACTIONS: 'true',
      TARGET_REPO: 'a/b',
      GITHUB_REPOSITORY: 'c/d',
      PR_NUMBER: '7',
      SOURCE_COMMENT_ID: '9',
      SOURCE_KIND: 'pull_request',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      HEAD_SHA: 'a'.repeat(40),
      REVIEW_MODE: 'incremental',
      REVIEW_REASON: 'small delta',
      STATUS_STAGE: 'finished',
      STATUS_COMMENT_ID: '7',
      GH_TOKEN: 't',
      GEMINI_PUBLISH_OUTCOME: 'skipped',
      REVIEW_CONTEXT_DIR: dir,
    },
    fetchImpl,
  });
  assert.match(bodies[0], /not confirmed/);
  assert.match(bodies[0], /Reason: Gemini review context exceeds 1500000 bytes second line/);
});

test('thread decisions are silent on success and reported honestly on failure', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).body); return Response.json({ id: 7 }); };
  const base = { ...baseEnv, REVIEW_MODE: 'threads', REVIEW_REASON: 'r', STATUS_COMMENT_ID: '7' };
  const r1 = await publishRunStatus({ env: { ...base, STATUS_STAGE: 'started' }, fetchImpl });
  assert.equal(r1, null);
  assert.equal(sent.length, 0);

  const r2 = await publishRunStatus({ env: { ...base, STATUS_STAGE: 'finished', THREADS_OUTCOME: 'success' }, fetchImpl });
  assert.equal(r2, null);
  assert.equal(sent.length, 0);

  await publishRunStatus({ env: { ...base, STATUS_STAGE: 'finished', THREADS_OUTCOME: 'failure' }, fetchImpl });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Review-thread decisions were not confirmed/);
});
