import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyThreadDecisions, planReviewSession, parseSessionComment, renderSessionComment, sessionCommitStatus, applyDiscoveryResult } from '../scripts/review-session-core.mjs';
import { applyThreadResolutions } from '../scripts/apply-thread-resolutions.mjs';
import { findingMarker } from '../scripts/review-anchors.mjs';

const BASE = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const BOT = 'jiaze-claude-review-bot';
const f = (title, severity = 'P2') => ({ severity, title, body: 'Trigger X causes wrong result Y.', path: `${title.replace(/\W+/g, '-')}.swift`, line: 3 });

function reworkSession(extra = {}, head = HEAD) {
  const base = applyDiscoveryResult({ result: { summary: 's', findings: [f('Bug one'), f('Bug two'), f('Small nit', 'P3')] }, baseSha: BASE, headSha: head, sourceCommentId: '1' });
  return { ...base, ...extra };
}
const byId = (session) => Object.fromEntries(session.findings.map((finding) => [finding.id, finding]));

test('resolving a P3 thread closes it for good without touching the status; reopening the thread reopens it', () => {
  const session = reworkSession();
  const closed = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F003', by: 'jiaze-li' }] });
  assert.equal(byId(closed).F003.status, 'WAIVED');
  assert.equal(byId(closed).F003.resolvedVia, 'thread');
  assert.equal(closed.status, 'REWORK');
  assert.match(renderSessionComment(closed), /Closed by people \(review thread resolved\):\n- F003 resolved by @jiaze-li/);
  const reopened = applyThreadDecisions({ session: closed, headSha: HEAD, reopened: ['F003'] });
  assert.equal(byId(reopened).F003.status, 'DEFERRED');
  assert.equal(applyThreadDecisions({ session, headSha: HEAD }), session);
});

test('a resolved blocking finding is never closed by the click alone: no READY, no waiver', () => {
  const session = reworkSession();
  const next = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'jiaze-li' }, { id: 'F002', by: 'jiaze-li' }] });
  assert.equal(next.status, 'REWORK');
  assert.deepEqual(['F001', 'F002'].map((id) => byId(next)[id].status), ['OPEN', 'OPEN']);
  assert.equal(sessionCommitStatus(next, HEAD).state, 'failure');
});

test('a thread decision cannot be applied while a review is running', () => {
  const running = reworkSession({ status: 'REVIEW_IN_PROGRESS' });
  assert.throws(() => applyThreadDecisions({ session: running, headSha: HEAD, closed: [{ id: 'F003', by: 'a' }] }));
});

// ---- the workflow script: reconcile the threads with the session ----

function threadNode(id, finding, { resolvedBy = null, author = BOT } = {}) {
  return {
    id, isResolved: Boolean(resolvedBy), resolvedBy: resolvedBy ? { login: resolvedBy } : null,
    comments: { nodes: [{ databaseId: 1000 + Number(id.replace(/\D/g, '')), author: { login: author }, body: `**[P2] ${finding.title}**\n\nbody\n\n${findingMarker(finding.path, finding.title)}` }] },
  };
}

function setup(session, threads, { permission = {}, head = HEAD } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-apply-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'threads' }, session, sessionCommentId: '55' }));
  const patches = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/graphql')) return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } } } });
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: head } });
    if (url.includes('/collaborators/')) {
      const login = decodeURIComponent(url.split('/collaborators/')[1].split('/')[0]);
      return Response.json({ permission: permission[login] ?? 'write' });
    }
    if (url.includes('/issues/comments/55') && init.method === 'PATCH') { patches.push(JSON.parse(init.body).body); return Response.json({ id: 55 }); }
    assert.fail('unexpected URL ' + url);
  };
  const env = { GH_TOKEN: 't', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: HEAD, SOURCE_COMMENT_ID: '99', EXPECTED_REVIEW_AUTHOR: `${BOT}[bot]`, REVIEW_CONTEXT_DIR: dir };
  return { env, fetchImpl, patches };
}
const quiet = { log() {}, warn() {} };

test('a writer resolving a P3 thread writes it into the session comment, with no model involved', async () => {
  const session = reworkSession();
  const [, , nit] = session.findings;
  const { env, fetchImpl, patches } = setup(session, [threadNode('T3', nit, { resolvedBy: 'jiaze-li' }), threadNode('T1', session.findings[0])]);
  const out = await applyThreadResolutions({ env, fetchImpl, log: quiet });
  assert.deepEqual(out.closed, [{ id: 'F003', by: 'jiaze-li' }]);
  assert.equal(out.session.status, 'REWORK');
  assert.equal(patches.length, 1);
  assert.match(patches[0], /jiaze-review-source-comment:99/);
});

test('only writers\' resolves count; the bot\'s own resolves, marker-less threads and other authors\' threads do not', async () => {
  const session = reworkSession();
  const nit = session.findings[2];
  const { env, fetchImpl, patches } = setup(session, [
    threadNode('T1', nit, { resolvedBy: 'stranger' }),
  ], { permission: { stranger: 'read' } });
  assert.deepEqual((await applyThreadResolutions({ env, fetchImpl, log: quiet })).closed, []);
  const bot = setup(session, [threadNode('T2', nit, { resolvedBy: BOT }), threadNode('T4', nit, { resolvedBy: 'jiaze-li', author: 'jiaze-li' }),
    { ...threadNode('T3', nit, { resolvedBy: 'jiaze-li' }), comments: { nodes: [{ author: { login: BOT }, body: 'no marker' }] } }]);
  assert.deepEqual((await applyThreadResolutions({ env: bot.env, fetchImpl: bot.fetchImpl, log: quiet })).closed, []);
  assert.equal(patches.length + bot.patches.length, 0);
});

test('unresolving a closed P3 thread reopens the finding', async () => {
  const session = reworkSession();
  const nit = session.findings[2];
  const closed = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: nit.id, by: 'jiaze-li' }] });
  const { env, fetchImpl, patches } = setup(closed, [threadNode('T3', nit)]);
  const out = await applyThreadResolutions({ env, fetchImpl, log: quiet });
  assert.equal(byId(out.session).F003.status, 'DEFERRED');
  assert.equal(patches.length, 1);
});

test('all blocking threads resolved but nothing pushed since the review: the threads are put back with a reply, status unchanged', async () => {
  const session = reworkSession();
  const [one, two] = session.findings;
  const gh = setup(session, [threadNode('T1', one, { resolvedBy: 'jiaze-li' }), threadNode('T2', two, { resolvedBy: 'jiaze-li' })]);
  const calls = [];
  const inner = gh.fetchImpl;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/graphql') && /unresolveReviewThread/.test(init.body)) { calls.push(['unresolve', JSON.parse(init.body).variables.id]); return Response.json({ data: {} }); }
    if (/\/comments\/\d+\/replies$/.test(url)) { calls.push(['reply', url]); return Response.json({ id: 1 }); }
    return inner(url, init);
  };
  const out = await applyThreadResolutions({ env: gh.env, fetchImpl, log: quiet });
  assert.equal(out.bounced, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'unresolve').map((c) => c[1]).sort(), ['T1', 'T2']);
  assert.equal(calls.filter((c) => c[0] === 'reply').length, 2);
  assert.equal(out.session.status, 'REWORK');
  assert.equal(gh.patches.length, 0);
});

test('some blocking threads still unresolved: nothing is bounced, the person is still working', async () => {
  const session = reworkSession();
  const [one, two] = session.findings;
  const gh = setup(session, [threadNode('T1', one, { resolvedBy: 'jiaze-li' }), threadNode('T2', two)]);
  const out = await applyThreadResolutions({ env: gh.env, fetchImpl: gh.fetchImpl, log: quiet });
  assert.equal(out.bounced, 0);
});

test('a PR that moved is refused', async () => {
  const session = reworkSession();
  const moved = setup(session, [], { head: 'd'.repeat(40) });
  await assert.rejects(applyThreadResolutions({ env: moved.env, fetchImpl: moved.fetchImpl, log: quiet }), /PR moved/);
});
