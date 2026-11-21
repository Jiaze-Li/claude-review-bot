import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../worker/src/index.js';
import { automaticSourceId, parseAutomaticPullRequestTrigger, parseReviewTrigger } from '../worker/src/review-trigger.js';

test('one command, first nonblank line only; the retired commands do nothing', () => {
  assert.ok(parseReviewTrigger('@jiaze-claude-review-bot review'));
  assert.ok(parseReviewTrigger('\n  @jiaze-claude-review-bot   review  \nmore text'));
  for (const body of ['@jiaze-claude-review-bot claude review', '@gemini review', '@claude review', '@jiaze-claude-review-bot reset review', '@jiaze-claude-review-bot override review',
    '@gemini dismiss F001 nope', '> @jiaze-claude-review-bot review', '    @jiaze-claude-review-bot review', 'please @jiaze-claude-review-bot review', '```\n@jiaze-claude-review-bot review\n```']) {
    assert.equal(parseReviewTrigger(body), null, body);
  }
});

test('non-draft opened/ready/reopened/synchronize start a review; drafts, closes and labels do not', () => {
  const pr = { state: 'open', draft: false };
  for (const action of ['opened', 'ready_for_review', 'reopened', 'synchronize']) assert.ok(parseAutomaticPullRequestTrigger('pull_request', { action, pull_request: pr }), action);
  assert.equal(parseAutomaticPullRequestTrigger('pull_request', { action: 'synchronize', pull_request: { ...pr, draft: true } }), null);
  assert.equal(parseAutomaticPullRequestTrigger('pull_request', { action: 'labeled', pull_request: pr, label: { name: 'delivery-v1' } }), null);
  assert.equal(parseAutomaticPullRequestTrigger('pull_request', { action: 'closed', pull_request: pr }), null);
  assert.equal(parseAutomaticPullRequestTrigger('pull_request_review_thread', { action: 'resolved' }), null);
  assert.match(automaticSourceId('12345678-1234-1234-1234-123456789abc'), /^\d+$/);
});

async function send({ event, payload, prOverrides = {}, workflows = [] }) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GITHUB_WEBHOOK_SECRET: 's3cret', GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), CONTROL_WORKFLOW: undefined };
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status });
    if (u.endsWith('/access_tokens')) return ok({ token: 't' }, 201);
    if (u.includes('/collaborators/')) return ok({ permission: 'write' });
    if (u.includes('/pulls/')) return ok({ state: 'open', draft: false, base: { sha: sha('1') }, head: { sha: sha('2') }, labels: [], ...prOverrides });
    if (u.endsWith('/installation')) return ok({ id: 9 });
    if (u.includes('/dispatches')) { workflows.push({ url: u, body: JSON.parse(init.body) }); return ok(null, 204); }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    return await worker.fetch(new Request('https://w.example/', { method: 'POST', body, headers: { 'x-hub-signature-256': signature, 'x-github-event': event, 'x-github-delivery': '12345678-1234-1234-1234-123456789abc' } }), env);
  } finally { globalThis.fetch = realFetch; }
}
const sha = (c) => c.repeat(40);
const repo = { full_name: 'o/r' };

test('a ready PR (no label of any kind) dispatches the single review workflow; a draft dispatches nothing', async () => {
  const dispatched = [];
  const payload = { action: 'synchronize', installation: { id: 9 }, repository: repo, pull_request: { number: 3, state: 'open', draft: false }, sender: { login: 'jack' } };
  const response = await send({ event: 'pull_request', payload, workflows: dispatched });
  assert.equal(response.status, 202);
  assert.match(dispatched[0].url, /\/actions\/workflows\/review\.yml\/dispatches$/);
  assert.equal(dispatched[0].body.inputs.head_sha, sha('2'));
  assert.equal('requested_mode' in dispatched[0].body.inputs, false);

  const drafts = [];
  const asDraft = await send({ event: 'pull_request', payload, prOverrides: { draft: true }, workflows: drafts });
  assert.equal((await asDraft.json()).ignored, true);
  assert.equal(drafts.length, 0);
});

test('a review command needs write access and goes to the same workflow; a bad signature is refused', async () => {
  const dispatched = [];
  const payload = { action: 'created', installation: { id: 9 }, repository: repo, issue: { number: 3, pull_request: {} }, comment: { id: 77, body: '@jiaze-claude-review-bot review', user: { login: 'jack' } } };
  const ok = await send({ event: 'issue_comment', payload, workflows: dispatched });
  assert.equal(ok.status, 202);
  assert.match(dispatched[0].url, /review\.yml/);
  const retired = await send({ event: 'issue_comment', payload: { ...payload, comment: { ...payload.comment, body: '@jiaze-claude-review-bot reset review' } }, workflows: dispatched });
  assert.equal((await retired.json()).ignored, true);
  const bad = await worker.fetch(new Request('https://w.example/', { method: 'POST', body: '{}', headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'ping' } }), { GITHUB_WEBHOOK_SECRET: 's' });
  assert.equal(bad.status, 401);
});
