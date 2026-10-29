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

test('resolving some blocking findings keeps the session in REWORK; resolving the last makes READY by that person, without a review', () => {
  const session = reworkSession();
  assert.equal(session.status, 'REWORK');
  assert.deepEqual(session.findings.map((x) => [x.id, x.status]), [['F001', 'OPEN'], ['F002', 'OPEN'], ['F003', 'DEFERRED']]);
  const one = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'jiaze-li' }] });
  assert.equal(one.status, 'REWORK');
  assert.equal(byId(one).F001.status, 'WAIVED');
  assert.equal(byId(one).F001.resolvedBy, 'jiaze-li');
  assert.equal(sessionCommitStatus(one, HEAD).state, 'failure');
  const all = applyThreadDecisions({ session: one, headSha: HEAD, closed: [{ id: 'F002', by: 'jiaze-li' }] });
  assert.equal(all.status, 'READY');
  assert.equal(all.auditCompleted, true);
  assert.equal(all.override.via, 'review thread');
  assert.deepEqual(all.override.waived, ['F002']);
  assert.equal(sessionCommitStatus(all, HEAD).state, 'success');
  // the P3 is not a blocker, so it did not have to be resolved
  assert.equal(byId(all).F003.status, 'DEFERRED');
});

test('a P3 thread resolved by a person is closed too, and is never re-raised', () => {
  const next = applyThreadDecisions({ session: reworkSession(), headSha: HEAD, closed: [{ id: 'F003', by: 'jiaze-li' }] });
  assert.equal(byId(next).F003.status, 'WAIVED');
  assert.equal(next.status, 'REWORK'); // the two blockers are still open
});

test('on a HEAD pushed after the review, resolving the last finding makes the current HEAD READY by that person\'s decision', () => {
  const session = reworkSession({}, OLD);
  const next = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'b' }] });
  assert.equal(next.status, 'READY');
  assert.equal(next.lastReviewedHead, HEAD);
  assert.deepEqual(next.override.waived.sort(), ['F001', 'F002']);
  assert.equal(sessionCommitStatus(next, HEAD).state, 'success');
});

test('files still unreviewed keep the session PARTIAL even when every finding is resolved', () => {
  const session = reworkSession({ coverage: { complete: false, head: HEAD, unreviewedCount: 2, unreviewedPaths: ['x', 'y'], reviewedKeys: [] } });
  const next = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'a' }] });
  assert.equal(next.status, 'PARTIAL');
  assert.equal(next.override, undefined);
  assert.equal(sessionCommitStatus(next, HEAD).state, 'error');
});

test('a provider failure, an invalid login, an already-closed finding and a running review are not turned into READY', () => {
  const failed = reworkSession({ status: 'HUMAN_REQUIRED', reviewFailure: { code: 'REVIEWER_UNAVAILABLE', mode: 'discovery', head: HEAD, reason: 'x' } });
  assert.equal(applyThreadDecisions({ session: failed, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'a' }] }).status, 'HUMAN_REQUIRED');
  const session = reworkSession();
  assert.equal(applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'not a login!' }] }), session);
  const fixed = { ...session, findings: session.findings.map((x) => (x.id === 'F001' ? { ...x, status: 'FIXED' } : x)) };
  assert.equal(applyThreadDecisions({ session: fixed, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }] }), fixed);
  assert.throws(() => applyThreadDecisions({ session: { ...session, status: 'REVIEW_IN_PROGRESS' }, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }] }), /a review is running/);
});

test('reopening a thread a person resolved reopens the finding and takes READY away; other waivers are untouched', () => {
  const closed = applyThreadDecisions({ session: reworkSession(), headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'a' }] });
  assert.equal(closed.status, 'READY');
  const reopened = applyThreadDecisions({ session: closed, headSha: HEAD, reopened: ['F002'] });
  assert.equal(reopened.status, 'REWORK');
  assert.equal(byId(reopened).F002.status, 'OPEN');
  assert.equal(byId(reopened).F002.resolvedVia, undefined);
  assert.equal(reopened.override, undefined);
  assert.equal(sessionCommitStatus(reopened, HEAD).state, 'failure');
  // a finding waived by a manual override is not a thread decision and is never reopened by a thread
  const waived = { ...closed, findings: closed.findings.map((x) => (x.id === 'F001' ? { ...x, resolvedVia: undefined } : x)) };
  assert.equal(applyThreadDecisions({ session: waived, headSha: HEAD, reopened: ['F001'] }), waived);
  // reopening a P3 does not block anything
  const nit = applyThreadDecisions({ session: closed, headSha: HEAD, closed: [{ id: 'F003', by: 'a' }] });
  const nitOpen = applyThreadDecisions({ session: nit, headSha: HEAD, reopened: ['F003'] });
  assert.equal(nitOpen.status, 'READY');
  assert.equal(byId(nitOpen).F003.status, 'DEFERRED');
});

test('reopening restores what was true before the decision: no audit flag earned by a click, and the reviewed HEAD', () => {
  const session = reworkSession({}, OLD); // reviewed at OLD, audit never ran
  assert.equal(session.auditCompleted, false);
  const ready = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'a' }] });
  assert.equal(ready.auditCompleted, true);
  assert.equal(ready.lastReviewedHead, HEAD);
  const back = applyThreadDecisions({ session: ready, headSha: HEAD, reopened: ['F001'] });
  assert.equal(back.status, 'REWORK');
  assert.equal(back.auditCompleted, false);
  assert.equal(back.lastReviewedHead, OLD);
  assert.equal(back.override, undefined);
  // so the repair on the current HEAD is verified (from the reviewed HEAD) rather than waved through
  assert.equal(planReviewSession({ session: back, baseSha: BASE, headSha: HEAD }).mode, 'verification');
  // a session that really had its audit keeps that fact
  const audited = reworkSession({ auditCompleted: true });
  const readyAudited = applyThreadDecisions({ session: audited, headSha: HEAD, closed: [{ id: 'F001', by: 'a' }, { id: 'F002', by: 'a' }] });
  assert.equal(applyThreadDecisions({ session: readyAudited, headSha: HEAD, reopened: ['F001'] }).auditCompleted, true);
});

test('the commit status says it was a person\'s decision, not an independent review', () => {
  const ready = applyThreadDecisions({ session: reworkSession(), headSha: HEAD, closed: [{ id: 'F001', by: 'jiaze-li' }, { id: 'F002', by: 'jiaze-li' }] });
  const status = sessionCommitStatus(ready, HEAD);
  assert.equal(status.state, 'success');
  assert.match(status.description, /READY: findings resolved by @jiaze-li via review threads \(HEAD not re-reviewed\)/);
  assert.ok(status.description.length <= 140); // GitHub's limit for a status description
  assert.equal(sessionCommitStatus({ ...ready, override: undefined }, HEAD).description, 'Independent review complete: READY');
});

test('the session comment says who resolved what and that the HEAD was not re-reviewed, and round-trips', () => {
  const next = applyThreadDecisions({ session: reworkSession(), headSha: HEAD, closed: [{ id: 'F001', by: 'jiaze-li' }, { id: 'F002', by: 'jiaze-li' }] });
  const body = renderSessionComment(next);
  assert.match(body, /Status: \*\*READY\*\* \(findings resolved by @jiaze-li via review threads; this HEAD was not re-reviewed\)/);
  assert.match(body, /Closed by people \(review thread resolved\):\n- F001 resolved by @jiaze-li\n- F002 resolved by @jiaze-li/);
  const back = parseSessionComment(body);
  assert.equal(back.status, 'READY');
  assert.equal(byId(back).F001.resolvedBy, 'jiaze-li');
});

// ---- the workflow script: reconcile the threads with the session ----

function threadNode(id, finding, { resolvedBy = null, author = BOT } = {}) {
  return {
    id, isResolved: Boolean(resolvedBy), resolvedBy: resolvedBy ? { login: resolvedBy } : null,
    comments: { nodes: [{ author: { login: author }, body: `**[P2] ${finding.title}**\n\nbody\n\n${findingMarker(finding.path, finding.title)}` }] },
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

test('a writer resolving the last blocking threads writes READY into the session comment, with no model involved', async () => {
  const session = reworkSession();
  const [one, two] = session.findings;
  const { env, fetchImpl, patches } = setup(session, [threadNode('T1', one, { resolvedBy: 'jiaze-li' }), threadNode('T2', two, { resolvedBy: 'jiaze-li' })]);
  const next = await applyThreadResolutions({ env, fetchImpl, log: quiet });
  assert.equal(next.status, 'READY');
  assert.equal(patches.length, 1);
  assert.match(patches[0], /Status: \*\*READY\*\*/);
  assert.match(patches[0], /jiaze-review-source-comment:99/);
});

test('only writers\' resolves count; the bot\'s own resolves, marker-less threads and other authors\' threads do not', async () => {
  const session = reworkSession();
  const [one, two] = session.findings;
  const { env, fetchImpl, patches } = setup(session, [
    threadNode('T1', one, { resolvedBy: 'stranger' }),
    threadNode('T2', two, { resolvedBy: BOT }),
    { ...threadNode('T3', two, { resolvedBy: 'jiaze-li' }), comments: { nodes: [{ author: { login: BOT }, body: 'no marker' }] } },
    threadNode('T4', two, { resolvedBy: 'jiaze-li', author: 'jiaze-li' }),
  ], { permission: { stranger: 'read' } });
  const next = await applyThreadResolutions({ env, fetchImpl, log: quiet });
  assert.equal(next.status, 'REWORK');
  assert.equal(patches.length, 0);
});

test('unresolving a thread a person had resolved reopens it and withdraws READY', async () => {
  const session = reworkSession();
  const [one, two] = session.findings;
  const closed = applyThreadDecisions({ session, headSha: HEAD, closed: [{ id: one.id, by: 'jiaze-li' }, { id: two.id, by: 'jiaze-li' }] });
  assert.equal(closed.status, 'READY');
  const { env, fetchImpl, patches } = setup(closed, [threadNode('T1', one, { resolvedBy: 'jiaze-li' }), threadNode('T2', two)]);
  const next = await applyThreadResolutions({ env, fetchImpl, log: quiet });
  assert.equal(next.status, 'REWORK');
  assert.equal(byId(next).F002.status, 'OPEN');
  assert.match(patches[0], /Status: \*\*REWORK\*\*/);
});

test('the same threads again change nothing, and a PR that moved is refused', async () => {
  const session = reworkSession();
  const closed = applyThreadDecisions({ session, headSha: HEAD, closed: session.findings.slice(0, 2).map((x) => ({ id: x.id, by: 'jiaze-li' })) });
  const threads = session.findings.slice(0, 2).map((x, i) => threadNode(`T${i}`, x, { resolvedBy: 'jiaze-li' }));
  const again = setup(closed, threads);
  await applyThreadResolutions({ env: again.env, fetchImpl: again.fetchImpl, log: quiet });
  assert.equal(again.patches.length, 0);
  const moved = setup(session, threads, { head: 'd'.repeat(40) });
  await assert.rejects(applyThreadResolutions({ env: moved.env, fetchImpl: moved.fetchImpl, log: quiet }), /PR moved/);
});
