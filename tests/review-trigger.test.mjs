import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  automaticSourceId,
  isReviewTrigger,
  parseAutomaticPullRequestTrigger,
  parseReviewTrigger,
} from '../worker/src/review-trigger.js';
import worker from '../worker/src/index.js';

for (const body of [
  '@claude review', ' @claude review ', '\n\n@claude review\n',
  '@CLAUDE REVIEW', '@claude   review', '@claude\treview',
  '\r\n @claude review \r\n\r\nInspect the actual diff.',
  '@claude review\n\nReview exact HEAD and regression tests.',
  '@jiaze-claude-review-bot review', '@JIAZE-CLAUDE-REVIEW-BOT REVIEW\nDetails.',
  '@jiaze-claude-review-bot claude review', '@jiaze-claude-review-bot reset review',
  '   @claude review\t ',
]) {
  test(`accepts standalone leading command: ${JSON.stringify(body)}`, () => {
    assert.equal(isReviewTrigger(body), true);
  });
}
for (const body of [
  '', ' \n ', null, undefined, {},
  'Please run @claude review', 'Explanation\n@claude review',
  '> @claude review', '- @claude review', '`@claude review`',
  '```text\n@claude review\n```', '~~~\n@claude review\n~~~',
  '    @claude review', '\t@claude review',
  '@claude reviewer', '@claude review-all', '@claude review please',
  '@jiaze-claude-review-bot gemini review', '@jiaze-claude-review-bot review please',
  '@claude\nreview', '@other review', '<!--\n@claude review\n-->',
]) {
  test(`rejects non-command or quoted command: ${JSON.stringify(body)}`, () => {
    assert.equal(isReviewTrigger(body), false);
  });
}

test('dedicated command maps to auto mode while Claude aliases remain explicit', () => {
  assert.deepEqual(parseReviewTrigger('@jiaze-claude-review-bot review'), { requestedMode: 'auto' });
  assert.deepEqual(parseReviewTrigger('@jiaze-claude-review-bot reset review'), { requestedMode: 'reset' });
  assert.deepEqual(parseReviewTrigger('@jiaze-claude-review-bot claude review'), { requestedMode: 'claude' });
  assert.deepEqual(parseReviewTrigger('@claude review'), { requestedMode: 'claude' });
});

test('automatic PR trigger accepts review-ready lifecycle events but not draft work', () => {
  for (const action of ['opened', 'ready_for_review', 'reopened', 'synchronize']) {
    const draft = action === 'ready_for_review' ? false : false;
    assert.deepEqual(
      parseAutomaticPullRequestTrigger('pull_request', {
        action,
        pull_request: { state: 'open', draft },
      }),
      { requestedMode: 'auto', sourceKind: 'pull_request' },
    );
  }
  assert.equal(
    parseAutomaticPullRequestTrigger('pull_request', {
      action: 'opened',
      pull_request: { state: 'open', draft: true },
    }),
    null,
  );
  assert.equal(
    parseAutomaticPullRequestTrigger('pull_request', {
      action: 'closed',
      pull_request: { state: 'closed', draft: false },
    }),
    null,
  );
});

test('automatic source id is stable per webhook delivery, not per PR HEAD', () => {
  const delivery = '11111111-2222-3333-4444-555555555555';
  const hex = delivery.replaceAll('-', '');
  assert.equal(automaticSourceId(delivery), BigInt(`0x${hex}`).toString(10));
  assert.equal(automaticSourceId(delivery), automaticSourceId(delivery));
  assert.notEqual(
    automaticSourceId(delivery),
    automaticSourceId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  );
  assert.throws(() => automaticSourceId('not-a-delivery'), /Invalid GitHub webhook delivery id/);
});

const secret = 'synthetic-test-webhook-secret';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY: privateKey };
const basePayload = {
  action: 'created', installation: { id: 11 }, repository: { full_name: 'acme/project' },
  issue: { number: 7, pull_request: {} },
  comment: { id: 99, user: { login: 'maintainer' }, body: '@claude review' },
};
const pullRequestPayload = {
  action: 'opened',
  installation: { id: 11 },
  repository: { full_name: 'acme/project' },
  number: 7,
  sender: { login: 'contributor' },
  pull_request: {
    number: 7,
    state: 'open',
    draft: false,
    user: { login: 'contributor' },
    head: { sha: 'a'.repeat(40) },
    base: { sha: 'b'.repeat(40) },
  },
};
function request(payload = basePayload, overrides = {}, event = 'issue_comment') {
  const body = JSON.stringify(payload);
  return new Request('https://example.test/webhook', {
    method: 'POST', body,
    headers: {
      'x-github-event': event,
      'x-github-delivery': '11111111-2222-3333-4444-555555555555',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      ...overrides,
    },
  });
}
function fakeGithub(t, {
  permission = 'write',
  state = 'open',
  draft = false,
  duplicate = false,
  duplicateMarkerId = '99',
  processedNoop = false,
  dispatchFails = false,
} = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    const method = options?.method ?? 'GET';
    calls.push({ pathname, method, body: options?.body ? JSON.parse(options.body) : null });
    if (pathname.endsWith('/dispatches')) {
      assert.equal(method, 'POST');
      return dispatchFails ? new Response('Rejected', { status: 503 }) : new Response(null, { status: 204 });
    }
    let out;
    if (pathname === '/app') out = { slug: 'jiaze-claude-review-bot' };
    else if (pathname === '/app/installations/11/access_tokens') out = { token: 'synthetic-installation-token' };
    else if (pathname.endsWith('/permission')) out = { permission };
    else if (pathname === '/repos/acme/project/pulls/7') out = {
      state,
      draft,
      head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40) },
    };
    else if (pathname.endsWith('/reviews')) out = duplicate
      ? [{ user: { login: 'jiaze-claude-review-bot[bot]' }, body: `<!-- claude-review-source-comment:${duplicateMarkerId} -->` }]
      : [];
    else if (pathname === '/repos/acme/project/issues/7/comments') out = processedNoop
      ? [{ user: { login: 'jiaze-claude-review-bot[bot]' }, body: `<!-- jiaze-review-source-comment:${duplicateMarkerId} -->` }]
      : [];
    else if (pathname === '/repos/Jiaze-Li/claude-review-bot/installation') out = { id: 11 };
    else assert.fail(`Unexpected GitHub endpoint: ${method} ${pathname}`);
    return Response.json(out);
  });
  return calls;
}

for (const body of ['@claude review\n\nFocus on the runtime evidence.', '\n @jiaze-claude-review-bot review \n']) {
  test('signed relaxed trigger dispatches exact target once without any premature acknowledgement', async (t) => {
    const calls = fakeGithub(t);
    const response = await worker.fetch(request({ ...basePayload, comment: { ...basePayload.comment, body } }), env);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).head_sha, 'a'.repeat(40));
    const dispatches = calls.filter((call) => call.pathname.endsWith('/dispatches'));
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].body, {
      ref: 'main', inputs: {
        target_repo: 'acme/project', pr_number: '7', base_sha: 'b'.repeat(40),
        head_sha: 'a'.repeat(40), trigger_user: 'maintainer', source_comment_id: '99',
        source_kind: 'comment',
        requested_mode: body.includes('@claude review') && !body.includes('@jiaze-claude-review-bot') ? 'claude' : 'auto',
      },
    });
    assert.equal(calls.some((call) => /comments|reactions/.test(call.pathname) && call.method !== 'GET'), false);
  });
}
for (const action of ['opened', 'ready_for_review', 'reopened', 'synchronize']) {
  test(`automatic PR ${action} event dispatches the exact current HEAD without collaborator gating`, async (t) => {
    const calls = fakeGithub(t, { permission: 'read' });
    const payload = {
      ...pullRequestPayload,
      action,
      pull_request: { ...pullRequestPayload.pull_request, draft: false },
    };
    const response = await worker.fetch(request(payload, {}, 'pull_request'), env);
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.source_kind, 'pull_request');
    assert.equal(result.head_sha, 'a'.repeat(40));
    assert.equal(calls.some((call) => call.pathname.endsWith('/permission')), false);

    const dispatches = calls.filter((call) => call.pathname.endsWith('/dispatches'));
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].body, {
      ref: 'main',
      inputs: {
        target_repo: 'acme/project',
        pr_number: '7',
        base_sha: 'b'.repeat(40),
        head_sha: 'a'.repeat(40),
        trigger_user: 'contributor',
        source_comment_id: automaticSourceId('11111111-2222-3333-4444-555555555555'),
        source_kind: 'pull_request',
        requested_mode: 'auto',
      },
    });
  });
}

for (const [name, payload, githubOptions] of [
  ['draft opened PR', { ...pullRequestPayload, pull_request: { ...pullRequestPayload.pull_request, draft: true } }, {}],
  ['draft synchronize PR', { ...pullRequestPayload, action: 'synchronize', pull_request: { ...pullRequestPayload.pull_request, draft: true } }, {}],
  ['closed PR after webhook race', pullRequestPayload, { state: 'closed' }],
  ['still-draft PR after webhook race', pullRequestPayload, { draft: true }],
]) {
  test(`${name}: automatic review does not dispatch`, async (t) => {
    const calls = fakeGithub(t, githubOptions);
    const response = await worker.fetch(request(payload, {}, 'pull_request'), env);
    assert.equal((await response.json()).ignored, true);
    assert.equal(calls.some((call) => call.pathname.endsWith('/dispatches')), false);
  });
}

test('redelivery of the same automatic webhook is idempotent', async (t) => {
  const delivery = '11111111-2222-3333-4444-555555555555';
  const sourceId = automaticSourceId(delivery);
  const calls = fakeGithub(t, { duplicate: true, duplicateMarkerId: sourceId });
  const response = await worker.fetch(request(
    pullRequestPayload,
    { 'x-github-delivery': delivery },
    'pull_request',
  ), env);
  assert.equal((await response.json()).ignored, true);
  assert.equal(calls.some((call) => call.pathname.endsWith('/dispatches')), false);
});

test('historical marker for the same HEAD does not suppress a later delivery generation', async (t) => {
  const oldDelivery = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const newDelivery = '11111111-2222-3333-4444-555555555555';
  const calls = fakeGithub(t, {
    duplicate: true,
    duplicateMarkerId: automaticSourceId(oldDelivery),
  });
  const response = await worker.fetch(request(
    pullRequestPayload,
    { 'x-github-delivery': newDelivery },
    'pull_request',
  ), env);
  assert.equal(response.status, 202);
  assert.equal(calls.filter((call) => call.pathname.endsWith('/dispatches')).length, 1);
});

test('automatic PR events fail closed without a GitHub delivery id', async (t) => {
  const calls = fakeGithub(t);
  const response = await worker.fetch(request(
    pullRequestPayload,
    { 'x-github-delivery': '' },
    'pull_request',
  ), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('unrelated pull_request actions are ignored before GitHub API calls', async (t) => {
  const calls = fakeGithub(t);
  const response = await worker.fetch(request(
    { ...pullRequestPayload, action: 'closed', pull_request: { ...pullRequestPayload.pull_request, state: 'closed' } },
    {},
    'pull_request',
  ), env);
  assert.equal((await response.json()).ignored, true);
  assert.equal(calls.length, 0);
});

for (const [name, payload, headers] of [
  ['edited comment', { ...basePayload, action: 'edited' }],
  ['ordinary issue', { ...basePayload, issue: { number: 7 } }],
  ['quoted command', { ...basePayload, comment: { ...basePayload.comment, body: '> @claude review' } }],
  ['wrong event', basePayload, { 'x-github-event': 'pull_request_review_comment' }],
  ['invalid signature', basePayload, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }],
]) {
  test(`${name}: zero GitHub calls and no acknowledgement`, async (t) => {
    const calls = fakeGithub(t);
    const response = await worker.fetch(request(payload, headers), env);
    assert.equal(response.status, name === 'invalid signature' ? 401 : 200);
    assert.equal(calls.length, 0);
  });
}
for (const options of [{ permission: 'read' }, { state: 'closed' }, { duplicate: true }, { processedNoop: true }]) {
  test(`ignored authorized-path trigger: ${JSON.stringify(options)}`, async (t) => {
    const calls = fakeGithub(t, options);
    const response = await worker.fetch(request(), env);
    assert.equal((await response.json()).ignored, true);
    assert.equal(calls.some((call) =>
      call.pathname.endsWith('/dispatches') ||
      (/comments|reactions/.test(call.pathname) && call.method !== 'GET')), false);
  });
}
test('failed dispatch never returns accepted or posts a reaction/status', async (t) => {
  const calls = fakeGithub(t, { dispatchFails: true });
  await assert.rejects(worker.fetch(request(), env), /503/);
  assert.equal(calls.filter((call) => call.pathname.endsWith('/dispatches')).length, 1);
  assert.equal(calls.some((call) => /comments|reactions/.test(call.pathname) && call.method !== 'GET'), false);
});


test('deployed Worker config routes normal triggers to review-v2 workflow', () => {
  const toml=fs.readFileSync(new URL('../worker/wrangler.toml',import.meta.url),'utf8');
  assert.match(toml,/CONTROL_WORKFLOW\s*=\s*"review-v2\.yml"/);
  assert.doesNotMatch(toml,/CONTROL_WORKFLOW\s*=\s*"review\.yml"/);
});
