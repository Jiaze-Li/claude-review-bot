import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import worker from '../worker/src/index.js';
import { DELIVERY_MARKER } from '../worker/src/delivery.js';

const secret = 'synthetic-test-webhook-secret';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY: privateKey };
const A = 'a'.repeat(40);
const BOT = 'jiaze-claude-review-bot[bot]';
const prPayload = (action, extra = {}) => ({
  action, installation: { id: 11 }, repository: { full_name: 'acme/project' }, number: 7, sender: { login: 'contributor' },
  pull_request: { number: 7, state: 'open', draft: false, user: { login: 'contributor' }, head: { sha: A }, base: { sha: 'b'.repeat(40) } }, ...extra,
});
const commentPayload = (body) => ({ action: 'created', installation: { id: 11 }, repository: { full_name: 'acme/project' }, issue: { number: 7, pull_request: {} }, comment: { id: 99, user: { login: 'maintainer' }, body } });
function request(payload, event) {
  const body = JSON.stringify(payload);
  return new Request('https://example.test/webhook', { method: 'POST', body, headers: { 'x-github-event': event, 'x-github-delivery': '11111111-2222-3333-4444-555555555555', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
}
function github(t, { labels = [], draft = false, comments = [] } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { pathname } = new URL(url);
    const method = options?.method ?? 'GET';
    calls.push({ pathname, method, body: options?.body ? JSON.parse(options.body) : null });
    if (pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
    let out;
    if (pathname === '/app') out = { slug: 'jiaze-claude-review-bot' };
    else if (pathname === '/app/installations/11/access_tokens') out = { token: 'synthetic' };
    else if (pathname.endsWith('/permission')) out = { permission: 'write' };
    else if (pathname === '/repos/acme/project/pulls/7') out = { state: 'open', draft, head: { sha: A }, base: { sha: 'b'.repeat(40) }, labels: labels.map((name) => ({ name })) };
    else if (pathname.endsWith('/reviews')) out = [];
    else if (pathname === '/repos/acme/project/issues/7/comments') out = comments;
    else if (pathname === '/repos/Jiaze-Li/pr-bot/installation') out = { id: 11 };
    else assert.fail(`Unexpected GitHub endpoint: ${method} ${pathname}`);
    return Response.json(out);
  });
  return calls;
}
const dispatches = (calls) => calls.filter((c) => c.pathname.endsWith('/dispatches'));
const stateComment = (over = {}) => ({ user: { login: BOT, type: 'Bot' }, body: `${DELIVERY_MARKER}\n\`\`\`json\n{}\n\`\`\``, ...over });

test('PRs that did not opt in keep the exact legacy route, inputs and push behaviour', async (t) => {
  const calls = github(t);
  let response = await worker.fetch(request(prPayload('opened'), 'pull_request'), env);
  assert.equal(response.status, 202);
  assert.equal(dispatches(calls)[0].pathname, '/repos/Jiaze-Li/pr-bot/actions/workflows/review-v2.yml/dispatches');
  assert.equal(dispatches(calls)[0].body.inputs.requested_mode, 'auto');
  assert.ok(calls.some((c) => c.pathname.endsWith('/reviews')), 'legacy receipt lookup still happens');

  const push = github(t);
  response = await worker.fetch(request(prPayload('synchronize'), 'pull_request'), env);
  assert.equal(dispatches(push)[0].body.inputs.requested_mode, 'stale');

  const other = github(t);
  response = await worker.fetch(request(prPayload('labeled', { label: { name: 'bug' } }), 'pull_request'), env);
  assert.equal((await response.json()).ignored, true);
  assert.equal(dispatches(other).length, 0);
});

test('a forged state comment from a user does not move a PR to delivery-v1', async (t) => {
  const calls = github(t, { comments: [stateComment({ user: { login: 'mallory', type: 'User' } })] });
  await worker.fetch(request(prPayload('opened'), 'pull_request'), env);
  assert.match(dispatches(calls)[0].pathname, /review-v2\.yml/);
});

test('labelled PRs go to the delivery workflow for open, ready, push and label events', async (t) => {
  for (const [action, extra] of [['opened'], ['ready_for_review'], ['reopened'], ['synchronize'], ['labeled', { label: { name: 'delivery-v1' } }]]) {
    const calls = github(t, { labels: ['delivery-v1'] });
    const response = await worker.fetch(request(prPayload(action, extra), 'pull_request'), env);
    assert.equal(response.status, 202, action);
    const [dispatch] = dispatches(calls);
    assert.match(dispatch.pathname, /\/actions\/workflows\/delivery-review\.yml\/dispatches$/, action);
    assert.equal(dispatch.body.inputs.requested_mode, 'auto', action);
    assert.equal(dispatch.body.inputs.head_sha, A);
    assert.equal(calls.some((c) => c.pathname.endsWith('/reviews')), false, 'no legacy receipt lookup');
  }
});

test('draft PRs never dispatch, labelled or not', async (t) => {
  for (const [event, payload, options] of [
    ['pull_request', prPayload('opened', { pull_request: { ...prPayload('x').pull_request, draft: true } }), { labels: ['delivery-v1'], draft: true }],
    ['pull_request', prPayload('labeled', { label: { name: 'delivery-v1' }, pull_request: { ...prPayload('x').pull_request, draft: true } }), { labels: ['delivery-v1'], draft: true }],
    ['pull_request', prPayload('synchronize', { pull_request: { ...prPayload('x').pull_request, draft: true } }), { labels: ['delivery-v1'], draft: true }],
  ]) {
    const calls = github(t, options);
    assert.equal((await (await worker.fetch(request(payload, event), env)).json()).ignored, true);
    assert.equal(dispatches(calls).length, 0);
  }
});

test('once delivery state exists the PR stays on it: label removal, review commands and push all route to delivery', async (t) => {
  for (const body of ['@claude review', '@jiaze-claude-review-bot review', '@gemini review', '@jiaze-claude-review-bot claude review']) {
    const calls = github(t, { labels: [], comments: [stateComment()] });
    assert.equal((await worker.fetch(request(commentPayload(body), 'issue_comment'), env)).status, 202);
    assert.match(dispatches(calls)[0].pathname, /delivery-review\.yml/);
    assert.equal(dispatches(calls)[0].body.inputs.requested_mode, 'auto');
  }
  const push = github(t, { labels: [], comments: [stateComment()] });
  await worker.fetch(request(prPayload('synchronize'), 'pull_request'), env);
  assert.match(dispatches(push)[0].pathname, /delivery-review\.yml/);
});

test('legacy-only controls (reset, override, dismiss, thread resolution) cannot touch a delivery PR', async (t) => {
  for (const body of ['@jiaze-claude-review-bot reset review', '@jiaze-claude-review-bot override review', '@gemini dismiss F001 not a bug', '@gemini accept F002 known risk']) {
    const calls = github(t, { labels: ['delivery-v1'] });
    const result = await (await worker.fetch(request(commentPayload(body), 'issue_comment'), env)).json();
    assert.equal(result.ignored, true, body);
    assert.equal(dispatches(calls).length, 0);
  }
  const calls = github(t, { labels: ['delivery-v1'] });
  const thread = { action: 'resolved', installation: { id: 11 }, repository: { full_name: 'acme/project' }, sender: { login: 'maintainer' }, pull_request: { number: 7 } };
  assert.equal((await (await worker.fetch(request(thread, 'pull_request_review_thread'), env)).json()).ignored, true);
  assert.equal(dispatches(calls).length, 0);
});
