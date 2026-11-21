import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeliveryPr } from '../scripts/delivery-mode-check.mjs';
import { createHarness, modelOutput } from './helpers/delivery-harness.mjs';

const read = (name) => fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const group = (text) => /concurrency:\s*\n(?:\s*#.*\n)*\s*group: (.+)/.exec(text)[1].trim();

test('legacy and delivery workflows share one concurrency group per PR and queue instead of cancelling', () => {
  assert.equal(group(read('delivery-review.yml')), group(read('review-v2.yml')));
  assert.match(read('delivery-review.yml'), /queue: max/);
  assert.match(read('delivery-review.yml'), /cancel-in-progress: false/);
});

test('the whole legacy review job, always() steps included, is gated on the delivery check', () => {
  const legacy = read('review-v2.yml');
  assert.match(legacy, /\n  review:\n[\s\S]*?needs: mode-gate\n\s+if: needs\.mode-gate\.outputs\.delivery != 'true'/);
  assert.match(legacy, /\n  mode-gate:\n[\s\S]*?delivery-mode-check\.mjs/);
  // The job-level condition is what protects the always() steps: they live inside that one job.
  assert.equal((legacy.match(/\n  [a-z-]+:\n    (?:needs|runs-on)/g) ?? []).length, 2);
});

test('delivery workflow re-reads state before the model and only ever runs one provider step', () => {
  const text = read('delivery-review.yml');
  assert.equal((text.match(/delivery-review\.mjs run/g) ?? []).length, 1);
  assert.match(text, /delivery-review\.mjs plan/);
  assert.doesNotMatch(text, /workflow_call|continue-review|uses: \.\/\.github/);
  assert.match(text, /timeout-minutes: 25/);
});

test('the Worker is not a new deploy surface beyond routing: no new secrets or permissions are named', () => {
  const text = `${read('delivery-review.yml')}${read('review-v2.yml')}`;
  const secrets = new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...secrets].sort(), ['APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY']);
});

test('the legacy gate recognises label, bot state comment and fails closed when unreadable', async () => {
  const h = createHarness();
  h.script(h.ok(modelOutput()));
  await h.event();
  const stateBody = h.comments()[0].body;
  const gateFetch = (opts) => async (url, init) => {
    const u = new URL(url);
    if (opts.fail) return new Response('no', { status: 502 });
    if (u.pathname.endsWith('/pulls/7')) return Response.json({ labels: (opts.labels ?? []).map((name) => ({ name })) });
    const body = JSON.parse(init.body);
    const nodes = (opts.comments ?? []).map((c, i) => ({ databaseId: i + 1, createdAt: '2026-11-21T00:00:00Z', lastEditedAt: null, minimizedReason: null, body: c.body, author: { login: c.login, __typename: c.type } }));
    const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
    const key = body.query.includes('reviewThreads(') ? 'reviewThreads' : body.query.includes('reviews(') ? 'reviews' : 'comments';
    return Response.json({ data: { repository: { pullRequest: { [key]: key === 'comments' ? { pageInfo: { hasNextPage: false }, nodes } : empty } } } });
  };
  const ctx = { target: 'acme/project', prNumber: 7, token: 't' };
  assert.equal(await isDeliveryPr({ ...ctx, fetchImpl: gateFetch({}) }), false);
  assert.equal(await isDeliveryPr({ ...ctx, fetchImpl: gateFetch({ labels: ['delivery-v1'] }) }), true);
  assert.equal(await isDeliveryPr({ ...ctx, fetchImpl: gateFetch({ comments: [{ body: stateBody, login: 'jiaze-claude-review-bot', type: 'Bot' }] }) }), true);
  assert.equal(await isDeliveryPr({ ...ctx, fetchImpl: gateFetch({ comments: [{ body: stateBody, login: 'mallory', type: 'User' }] }) }), false);
  await assert.rejects(isDeliveryPr({ ...ctx, fetchImpl: gateFetch({ fail: true }) }));
});
