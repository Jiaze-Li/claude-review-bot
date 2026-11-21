// An in-memory PR + mock provider for delivery-v1 tests. Only api.github.com requests are answered (from memory);
// anything else, and any provider/network call outside the injected mock provider, fails the test.
import { createFakePr, BOT } from './fake-pr.mjs';
import { createGithubClient } from '../../scripts/delivery-review.mjs';
import { runDelivery } from '../../scripts/delivery-review.mjs';
import { readDeliveryState } from '../../scripts/delivery-protocol.mjs';

export const REPO = 'acme/project';
export const PR = 7;
export const sha = (c) => c.repeat(40);
export const FILES = ['src/a.js', 'src/b.js'];
export { BOT };

export const P1 = { severity: 'P1', title: 'Retry drops the last chunk', path: 'src/a.js', failure_path: 'When the second upload attempt starts, the final chunk is skipped so the stored file is truncated.' };
export const P3 = { severity: 'P3', title: 'Prefer a named constant', path: 'src/b.js', failure_path: '' };

export const modelOutput = ({ findings = [], prior = [], complete = true, reviewed = FILES } = {}) => ({
  summary: 'review', findings, prior_findings: prior,
  coverage: { complete, reviewedPaths: complete ? FILES : reviewed, note: '' },
});

export function createHarness({ labels = ['delivery-v1'], draft = false, head = sha('a'), state = 'open', now = Date.UTC(2026, 10, 21, 9, 0, 0) } = {}) {
  const fake = createFakePr({ number: PR });
  const world = { labels, draft, head, state, now, statuses: [], failures: { post: 0, patch: 0 }, requests: [] };
  const providerCalls = [];
  let script = [];
  const own = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    world.requests.push(`${method} ${u.pathname}`);
    if (u.host !== 'api.github.com') throw new Error(`unexpected external request: ${url}`);
    if (u.pathname === `/repos/${REPO}/pulls/${PR}` && method === 'GET') {
      return Response.json({ state: world.state, draft: world.draft, head: { sha: world.head }, base: { sha: sha('0') }, labels: world.labels.map((name) => ({ name })), title: 'Add upload retry', body: 'Goal: uploads retry safely. Acceptance: file is complete after a retry.' });
    }
    const m = /\/statuses\/([0-9a-f]{40})$/.exec(u.pathname);
    if (m && method === 'POST') { world.statuses.push({ sha: m[1], ...JSON.parse(init.body) }); return Response.json({}, { status: 201 }); }
    return new Response('not found', { status: 404 });
  };
  const gate = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'POST' && /\/issues\/7\/comments$/.test(String(url)) && world.failures.post > 0) { world.failures.post -= 1; return new Response('boom', { status: 500 }); }
    if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(String(url)) && world.failures.patch > 0) { world.failures.patch -= 1; return new Response('boom', { status: 500 }); }
    return fake.layer(own)(url, init);
  };
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    if (host !== 'api.github.com') throw new Error(`unexpected external request: ${url}`);
    return gate(url, init);
  };
  const github = createGithubClient({ fetchImpl, token: 't', statusToken: 's', target: REPO, prNumber: PR, botLogin: BOT, env: {} });
  const provider = {
    name: 'mock', limits: { maxTurns: 5 },
    changedFiles: () => FILES,
    preflight() { if (world.preflightError) throw new Error(world.preflightError); },
    async run(request) {
      providerCalls.push(request);
      const next = script.shift();
      if (!next) throw new Error('mock provider has no scripted answer');
      return typeof next === 'function' ? next(world) : next;
    },
  };
  const env = () => ({ TARGET_REPO: REPO, PR_NUMBER: String(PR), HEAD_SHA: world.requestHead ?? world.head, EXPECTED_REVIEW_AUTHOR: BOT });
  return {
    fake, world, providerCalls, github, provider, fetchImpl,
    script: (...items) => { script = items; },
    ok: (structured) => ({ ok: true, structured }),
    // One delivery event for the current (or an explicitly older) HEAD.
    async event({ requestHead = null, planOnly = false } = {}) {
      world.requestHead = requestHead;
      return runDelivery({ env: env(), github, provider, now: () => world.now, log: () => {}, planOnly });
    },
    state() {
      const records = fake.issue.map((c) => ({ id: c.id, source: 'issue', login: c.user, type: c.type, body: c.body }));
      return readDeliveryState(records, { botLogin: BOT, repo: REPO, prNumber: PR });
    },
    comments: () => fake.issue.filter((c) => c.body.startsWith('<!-- agent-delivery:v1 -->')),
    lastStatus: () => world.statuses.at(-1),
  };
}
