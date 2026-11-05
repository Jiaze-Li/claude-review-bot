import test from 'node:test';
import assert from 'node:assert/strict';
import { syncReviewThreads } from '../scripts/sync-review-threads.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';
import { applyDiscoveryResult, renderSessionComment } from '../scripts/review-session-core.mjs';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const BOT = 'jiaze-claude-review-bot';
const env = { GH_TOKEN: 't', TARGET_REPO: 'acme/project', PR_NUMBER: '7', EXPECTED_REVIEW_AUTHOR: `${BOT}[bot]` };

const f = (title, path, severity = 'P2') => ({ severity, title, body: 'Trigger X causes wrong result Y.', path, line: null });
function session(statuses) {
  const base = applyDiscoveryResult({
    result: { summary: 's', findings: Object.keys(statuses).map((title) => f(title, `${title.replace(/\W+/g, '-')}.swift`)) },
    baseSha: BASE, headSha: HEAD, sourceCommentId: '1',
  });
  return { ...base, findings: base.findings.map((finding) => ({ ...finding, status: statuses[finding.title] })) };
}
const thread = (id, title, { resolved = false, author = BOT, marker = true } = {}) => ({
  id, isResolved: resolved,
  comments: { nodes: [{ databaseId: 77, author: { login: author }, body: `**[P2] ${title}**\n\nbody${marker ? `\n\n${findingMarker(`${title.replace(/\W+/g, '-')}.swift`, title)}` : ''}` }] },
});

function fakeGitHub(sess, threads, { failResolve = [] } = {}) {
  const resolved = [];
  const reopened = [];
  const replies = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/issues/7/comments')) {
      return Response.json(sess ? [{ id: 5, user: { login: `${BOT}[bot]` }, body: renderSessionComment(sess) }] : []);
    }
    if (url === 'https://api.github.com/graphql') {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('unresolveReviewThread')) { reopened.push(variables.id); return Response.json({ data: {} }); }
      if (query.includes('resolveReviewThread')) {
        if (failResolve.includes(variables.id)) return Response.json({ errors: [{ message: 'Resource not accessible by integration' }] });
        resolved.push(variables.id);
        return Response.json({ data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } });
      }
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
    }
    if (/\/comments\/\d+\/replies$/.test(url)) { replies.push(JSON.parse(init.body).body); return Response.json({ id: 1 }); }
    assert.fail('unexpected URL ' + url);
  };
  return { fetchImpl, resolved, reopened, replies };
}
const quiet = { log() {}, warn() {} };

test('threads for FIXED, DISMISSED and WAIVED findings are resolved; open ones are left alone', async () => {
  const sess = session({ 'Fixed bug': 'FIXED', 'Dismissed bug': 'DISMISSED', 'Waived bug': 'WAIVED', 'Open bug': 'OPEN', 'Minor nit': 'DEFERRED' });
  const gh = fakeGitHub(sess, [thread('T1', 'Fixed bug'), thread('T2', 'Dismissed bug'), thread('T3', 'Waived bug'), thread('T4', 'Open bug'), thread('T5', 'Minor nit')]);
  const out = await syncReviewThreads({ env, fetchImpl: gh.fetchImpl, log: quiet });
  assert.deepEqual(gh.resolved.sort(), ['T1', 'T2', 'T3']);
  assert.deepEqual([out.resolved, out.failed, out.closed], [3, 0, 3]);
});

test('only the bot\'s own marked, still-open threads are touched', async () => {
  const sess = session({ 'Fixed bug': 'FIXED' });
  const gh = fakeGitHub(sess, [
    thread('already', 'Fixed bug', { resolved: true }),
    thread('human', 'Fixed bug', { author: 'jiaze-li' }),
    thread('unmarked', 'Fixed bug', { marker: false }),
    thread('other', 'A different finding'),
    thread('mine', 'Fixed bug'),
  ]);
  await syncReviewThreads({ env, fetchImpl: gh.fetchImpl, log: quiet });
  assert.deepEqual(gh.resolved, ['mine']);
});

test('nothing is queried or resolved when no finding is closed, or there is no session', async () => {
  for (const sess of [session({ 'Open bug': 'OPEN' }), null]) {
    const gh = fakeGitHub(sess, [thread('T1', 'Open bug')]);
    let graphqlCalls = 0;
    const out = await syncReviewThreads({ env, fetchImpl: async (url, init) => { if (url.endsWith('/graphql')) graphqlCalls += 1; return gh.fetchImpl(url, init); }, log: quiet });
    assert.equal(graphqlCalls, 0);
    assert.equal(out.resolved, 0);
  }
});

test('a thread that cannot be resolved (one-off error) is counted, not thrown, and the rest still resolve', async () => {
  const sess = session({ 'Bug one': 'FIXED', 'Bug two': 'FIXED' });
  const warnings = [];
  const gh = fakeGitHub(sess, [thread('T1', 'Bug one'), thread('T2', 'Bug two')], { failResolve: ['T1'] });
  const real = gh.fetchImpl;
  gh.fetchImpl = async (url, init = {}) => (url.endsWith('/graphql') && JSON.parse(init.body).variables?.id === 'T1' ? Response.json({ errors: [{ message: 'Could not resolve to a node' }] }) : real(url, init));
  const out = await syncReviewThreads({ env, fetchImpl: gh.fetchImpl, log: { log() {}, warn: (m) => warnings.push(m) } });
  assert.deepEqual(gh.resolved, ['T2']);
  assert.deepEqual([out.resolved, out.failed], [1, 1]);
  assert.match(warnings[0], /Could not resolve to a node/);
});

test('the workflow runs the thread sync last and never lets it fail a review', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const start = yml.indexOf('- name: Resolve review threads for closed findings');
  assert.ok(start > yml.indexOf('- name: Fail closed if the deep review did not complete'));
  assert.ok(start < yml.indexOf('- name: Finalize workflow status'));
  const block = yml.slice(start, yml.indexOf('- name: Finalize workflow status'));
  assert.match(block, /continue-on-error: true/);
  assert.match(block, /if: always\(\)/);
  assert.doesNotMatch(block, /GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
});

test('after a verification run, a still-open finding whose thread a person resolved is put back with the reason', async () => {
  const sess = session({ 'Open bug': 'OPEN', 'Fixed bug': 'FIXED' });
  sess.findings[0].resolutionReason = 'The guard was added on the wrong branch.';
  const resolvedByPerson = (id, title) => ({ ...thread(id, title, { resolved: true }), resolvedBy: { login: 'jiaze-li' } });
  const gh = fakeGitHub(sess, [resolvedByPerson('T1', 'Open bug'), resolvedByPerson('T2', 'Fixed bug')]);
  const out = await syncReviewThreads({ env: { ...env, REVIEW_MODE: 'verification' }, fetchImpl: gh.fetchImpl, log: quiet });
  assert.deepEqual(gh.reopened, ['T1']);
  assert.equal(out.reopened, 1);
  assert.match(gh.replies[0], /wrong branch/);
  // outside a verification run nothing is put back
  const plain = fakeGitHub(sess, [resolvedByPerson('T1', 'Open bug')]);
  await syncReviewThreads({ env, fetchImpl: plain.fetchImpl, log: quiet });
  assert.deepEqual(plain.reopened, []);
});

// --- failure handling -------------------------------------------------------------------------------------------

function denyAll(sess, threads, { http = false } = {}) {
  const gh = fakeGitHub(sess, threads);
  const calls = { mutations: 0, sessionWrites: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (init.method && init.method !== 'GET' && /\/issues\//.test(url)) calls.sessionWrites += 1;
    if (url === 'https://api.github.com/graphql' && /resolveReviewThread/i.test(JSON.parse(init.body).query)) {
      calls.mutations += 1;
      return http ? new Response('{}', { status: 403 }) : Response.json({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
    }
    return gh.fetchImpl(url, init);
  };
  return { fetchImpl, calls, gh };
}

test('a refused token (GraphQL FORBIDDEN or HTTP 403) stops after one try and reports the rest as not tried', async () => {
  for (const http of [false, true]) {
    const sess = session({ 'Bug one': 'FIXED', 'Bug two': 'FIXED', 'Bug three': 'FIXED' });
    const { fetchImpl, calls } = denyAll(sess, [thread('T1', 'Bug one'), thread('T2', 'Bug two'), thread('T3', 'Bug three')], { http });
    const out = await syncReviewThreads({ env, fetchImpl, log: quiet });
    assert.equal(calls.mutations, 1);
    assert.deepEqual([out.resolved, out.failed, out.skipped, out.permissionDenied], [0, 1, 2, true]);
  }
});

test('a failure is reported in the Job Summary and an annotation, never as a PR comment or a session change', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const summary = `${mkdtempSync(`${tmpdir()}/sum-`)}/summary.md`;
  const warnings = [];
  const sess = session({ 'Bug one': 'FIXED' });
  const { fetchImpl, calls } = denyAll(sess, [thread('T1', 'Bug one')]);
  await syncReviewThreads({ env: { ...env, GITHUB_STEP_SUMMARY: summary }, fetchImpl, log: { log() {}, warn: (m) => warnings.push(m) } });
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /did not fully complete/);
  assert.match(text, /Contents: Read and write/);
  assert.match(text, /Contents: read/);
  assert.ok(warnings.some((m) => m.startsWith('::warning')));
  assert.equal(calls.sessionWrites, 0);
});

test('partial failure is counted exactly: a non-permission error on one thread does not hide the other successes', async () => {
  const sess = session({ 'Bug one': 'FIXED', 'Bug two': 'FIXED', 'Bug three': 'FIXED' });
  const gh = fakeGitHub(sess, [thread('T1', 'Bug one'), thread('T2', 'Bug two'), thread('T3', 'Bug three')], {});
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/graphql') && JSON.parse(init.body).variables?.id === 'T2') return Response.json({ errors: [{ message: 'Could not resolve to a node' }] });
    return gh.fetchImpl(url, init);
  };
  const out = await syncReviewThreads({ env, fetchImpl, log: quiet });
  assert.deepEqual(gh.resolved, ['T1', 'T3']);
  assert.deepEqual([out.resolved, out.failed, out.skipped, out.permissionDenied], [2, 1, 0, false]);
});

test('reopening: a refused unresolve is a failure and posts no reply; a failed reply still counts the thread as reopened', async () => {
  const sess = session({ 'Open bug': 'OPEN' });
  const byPerson = { ...thread('T1', 'Open bug', { resolved: true }), resolvedBy: { login: 'jiaze-li' } };
  const denied = denyAll(sess, [byPerson]);
  const out = await syncReviewThreads({ env: { ...env, REVIEW_MODE: 'verification' }, fetchImpl: denied.fetchImpl, log: quiet });
  assert.deepEqual([out.reopened, out.failed], [0, 1]);
  assert.deepEqual(denied.gh.replies, []);

  const gh = fakeGitHub(sess, [byPerson]);
  const fetchImpl = async (url, init) => (/\/replies$/.test(url) ? new Response('no', { status: 500 }) : gh.fetchImpl(url, init));
  const out2 = await syncReviewThreads({ env: { ...env, REVIEW_MODE: 'verification' }, fetchImpl, log: quiet });
  assert.deepEqual([out2.reopened, out2.failed, out2.replyFailed], [1, 0, 1]);
});

test('already-resolved threads cause no mutation and no problem report', async () => {
  const sess = session({ 'Fixed bug': 'FIXED' });
  const { fetchImpl, calls } = denyAll(sess, [thread('T1', 'Fixed bug', { resolved: true })]);
  const out = await syncReviewThreads({ env, fetchImpl, log: quiet });
  assert.equal(calls.mutations, 0);
  assert.deepEqual([out.resolved, out.failed, out.skipped], [0, 0, 0]);
});

test('the workflow never widens the token itself: Contents stays read-only', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(yml, /permission-contents: write/);
  assert.match(yml, /permission-contents: read\n\s+permission-pull-requests: write\n\s+permission-issues: read/);
});

test('a reply-only failure still makes the CLI step exit non-zero, like any other incomplete sync', async () => {
  const { needsAttention } = await import('../scripts/sync-review-threads.mjs');
  const base = { resolved: 1, reopened: 1, failed: 0, skipped: 0, replyFailed: 0 };
  assert.equal(needsAttention(base), false);
  assert.equal(needsAttention({ ...base, replyFailed: 1 }), true);
  assert.equal(needsAttention({ ...base, failed: 1 }), true);
  assert.equal(needsAttention({ ...base, skipped: 1 }), true);

  // end to end through the real CLI entry point, with fetch stubbed by a preload
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(`${tmpdir()}/cli-`);
  const sess = session({ 'Open bug': 'OPEN' });
  const byPerson = { ...thread('T1', 'Open bug', { resolved: true }), resolvedBy: { login: 'jiaze-li' } };
  const gh = fakeGitHub(sess, [byPerson]);
  writeFileSync(`${dir}/stub.mjs`, `
    const sessionBody = ${JSON.stringify(renderSessionComment(sess))};
    const thread = ${JSON.stringify(byPerson)};
    globalThis.fetch = async (url, init = {}) => {
      if (url.includes('/issues/7/comments')) return Response.json([{ id: 5, user: { login: '${BOT}[bot]' }, body: sessionBody }]);
      if (url.endsWith('/graphql')) {
        if (/unresolveReviewThread/.test(init.body)) return Response.json({ data: {} });
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread] } } } } });
      }
      return new Response('no', { status: 500 }); // the reply
    };`);
  void gh;
  const run = spawnSync(process.execPath, ['--import', `${dir}/stub.mjs`, new URL('../scripts/sync-review-threads.mjs', import.meta.url).pathname], {
    env: { ...process.env, ...env, REVIEW_MODE: 'verification', GITHUB_STEP_SUMMARY: `${dir}/summary.md` }, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /::warning/);
});
