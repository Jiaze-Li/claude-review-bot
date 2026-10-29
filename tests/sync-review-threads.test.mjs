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
  comments: { nodes: [{ author: { login: author }, body: `**[P2] ${title}**\n\nbody${marker ? `\n\n${findingMarker(`${title.replace(/\W+/g, '-')}.swift`, title)}` : ''}` }] },
});

function fakeGitHub(sess, threads, { failResolve = [] } = {}) {
  const resolved = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/issues/7/comments')) {
      return Response.json(sess ? [{ id: 5, user: { login: `${BOT}[bot]` }, body: renderSessionComment(sess) }] : []);
    }
    if (url === 'https://api.github.com/graphql') {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('resolveReviewThread')) {
        if (failResolve.includes(variables.id)) return Response.json({ errors: [{ message: 'Resource not accessible by integration' }] });
        resolved.push(variables.id);
        return Response.json({ data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } });
      }
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
    }
    assert.fail('unexpected URL ' + url);
  };
  return { fetchImpl, resolved };
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

test('a thread that cannot be resolved (missing permission) is counted, not thrown, and the rest still resolve', async () => {
  const sess = session({ 'Bug one': 'FIXED', 'Bug two': 'FIXED' });
  const warnings = [];
  const gh = fakeGitHub(sess, [thread('T1', 'Bug one'), thread('T2', 'Bug two')], { failResolve: ['T1'] });
  const out = await syncReviewThreads({ env, fetchImpl: gh.fetchImpl, log: { log() {}, warn: (m) => warnings.push(m) } });
  assert.deepEqual(gh.resolved, ['T2']);
  assert.deepEqual([out.resolved, out.failed], [1, 1]);
  assert.match(warnings[0], /Resource not accessible by integration/);
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
