import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEDGER_CODES, buildLedger, flattenFields, ledgerIsReady, parseRecord, renderEventRecord, renderFindingRecord,
  renderHandoffParts, renderImportParts, renderReceipt, renderRunStart, renderVerdictRecord, unflattenFields,
} from '../scripts/review-ledger.mjs';
import { fetchLedgerSources } from '../scripts/review-ledger-fetch.mjs';
import { applyDiscoveryResult, applyVerificationResult, completeDeepReview, beginDeepReview } from '../scripts/review-session-core.mjs';
import { legacyStateComment } from './helpers/fake-pr.mjs';

const BASE = 'b'.repeat(40), A = 'a'.repeat(40), C = 'c'.repeat(40);
const BOT = 'claude-review-bot[bot]';
const bug = (title, extra = {}) => ({ severity: 'P1', title, body: `Trigger ${title} causes a wrong result; expected the right one.`, path: 'src/a.js', line: 3, riskClass: 'state', failurePath: 'a request with state X reaches Y and returns the wrong value', ...extra });
const session = (findings = [bug('One'), bug('Two', { severity: 'P3' })], head = A) =>
  applyDiscoveryResult({ result: { summary: 's', findings }, baseSha: BASE, headSha: head, sourceCommentId: '7' });

let clock = 0;
const rec = (body, over = {}) => {
  clock += 1;
  return { id: String(1000 + clock), source: 'issue', createdAt: `2026-11-18T10:${String(clock).padStart(2, '0')}:00Z`, body, login: BOT, type: 'Bot', lastEditedAt: null, minimizedReason: null, ...over };
};
const handoff = (s, opts = {}) => renderHandoffParts({ session: s, stage: 'first', seq: 1, ...opts });
const post = (bodies) => bodies.map((body) => rec(body));
const build = (records, extra = {}) => buildLedger({ records, botLogin: BOT, reads: { complete: true }, ...extra });
const norm = (value) => JSON.parse(JSON.stringify(value));

test('field lines round-trip any plain object and refuse prototype keys', () => {
  const value = { a: 1, b: 'x: y', c: [1, { d: null }, []], e: {}, f: { 'odd key': true }, g: 'line\nbreak' };
  const pairs = flattenFields(value, 'session');
  assert.ok(pairs.every(([, json]) => !json.includes('\n')));
  assert.deepEqual(unflattenFields(pairs).session, value);
  assert.equal(unflattenFields([['session.__proto__.x', '1']]), null);
  assert.equal(unflattenFields([['session.a', '{bad']]), null);
  assert.equal({}.x, undefined);
});

test('a session written as a handoff is rebuilt from the PR records alone, equal to the original', () => {
  const cases = [
    session(),
    session([]),
    { ...session([bug('Dismissed')]), findings: [{ ...session([bug('Dismissed')]).findings[0], status: 'DISMISSED', dismissal: { by: 'jack', reason: 'because', evidence: ['a.js:1', 'b.js:2-3'], verifiedBy: 'gemini' } }], status: 'AUDIT_PENDING' },
    (() => { const s = beginDeepReview({ session: session([]), baseSha: BASE, headSha: A, runId: 'r1', reserveUsd: 1.5 }); return completeDeepReview({ session: s, headSha: A, spentUsd: 0.4, result: { summary: 'ok', findings: [], coverage: { complete: false, unreviewedPaths: ['x/y.js', 'z.js'], reviewedPaths: ['a.js'] } } }); })(),
  ];
  for (const original of cases) {
    const ledger = build(post(handoff(original)));
    assert.equal(ledger.state, 'ok', ledger.message);
    assert.deepEqual(norm(ledger.session), norm(original));
    assert.equal(ledger.handoff.seq, 1);
    assert.equal(ledger.handoff.reviewedHead, original.lastReviewedHead);
  }
});

test('a very large session is split into parts under the size limit and still rebuilds exactly', () => {
  const findings = Array.from({ length: 6 }, (_, i) => bug(`Finding number ${i}`));
  const big = { ...session(findings), padding: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'v'.repeat(180)])) };
  const bodies = handoff(big, { maxPartBytes: 20_000 });
  assert.ok(bodies.length > 1);
  assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 20_000));
  assert.equal(bodies.filter((body) => body.includes('Handoff: COMPLETE')).length, 1);
  assert.ok(bodies.at(-1).includes('Handoff: COMPLETE'));
  const ledger = build(post(bodies));
  assert.equal(ledger.state, 'ok', ledger.message);
  assert.deepEqual(norm(ledger.session), norm(big));
  // a missing middle part (deleted comment) is an unfinished stage, not a smaller session
  const records = post(bodies);
  const stopped = build(records.filter((_, i) => i !== 0));
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.code, LEDGER_CODES.STAGE_NOT_CLOSED);
});

test('an edited or collapsed bot record stops the ledger; humans and look-alike accounts are only inputs', () => {
  const bodies = handoff(session());
  const edited = build([rec(bodies[0], { lastEditedAt: '2026-11-18T11:00:00Z' })]);
  assert.equal(edited.code, LEDGER_CODES.INTEGRITY_FAILED);
  assert.match(edited.message, /changed after the bot wrote/);
  const collapsed = build([rec(bodies[0], { minimizedReason: 'OUTDATED' })]);
  assert.equal(collapsed.code, LEDGER_CODES.INTEGRITY_FAILED);
  // a human posting a perfect handoff changes nothing
  const forged = build([rec(bodies[0], { login: 'someone', type: 'User' })]);
  assert.equal(forged.state, 'new');
  const lookAlike = build([rec(bodies[0], { login: BOT, type: 'User' })]);
  assert.equal(lookAlike.state, 'new');
  // the editable status projection may be edited freely
  const projection = rec('<!-- jiaze-review-session:v1 -->\n### Independent Review Session\nStatus: READY', { lastEditedAt: '2026-11-18T11:00:00Z' });
  assert.equal(build([...post(bodies), projection]).state, 'ok');
});

test('an incomplete read stops instead of reporting an empty history', () => {
  const stopped = buildLedger({ records: [], botLogin: BOT, reads: { complete: false, problems: ['more than 250 comments'] } });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.code, LEDGER_CODES.READ_INCOMPLETE);
  assert.match(stopped.message, /could not be read in full/);
  assert.equal(buildLedger({ records: [], botLogin: '', reads: { complete: true } }).code, LEDGER_CODES.READ_INCOMPLETE);
});

test('no bot records at all is a new PR; deleted records never read as a clean pass', () => {
  assert.equal(build([]).state, 'new');
  assert.equal(ledgerIsReady(build([]), A), false);
});

test('the handoff chain must be unbroken and every stage closed', () => {
  const s1 = session();
  const first = post(handoff(s1));
  const s2 = { ...s1, status: 'AUDIT_PENDING', findings: s1.findings.map((f) => ({ ...f, status: 'FIXED' })) };
  const chain = (prev, seq = 2) => post(renderHandoffParts({ session: s2, stage: 'verification', seq, prev }));
  const good = build([...first, ...chain(first[0].id)]);
  assert.equal(good.state, 'ok', good.message);
  assert.equal(good.handoff.seq, 2);
  assert.deepEqual(good.handoffs.map((h) => h.seq), [1, 2]);
  assert.equal(build([...first, ...chain('999999')]).code, LEDGER_CODES.HANDOFF_CHAIN_BROKEN);
  assert.equal(build([...first, ...chain(first[0].id, 3)]).code, LEDGER_CODES.HANDOFF_CHAIN_BROKEN);
  assert.equal(build(chain(null, 2)).code, LEDGER_CODES.HANDOFF_CHAIN_BROKEN);
});

test('records written after the last handoff mean the previous stage never closed', () => {
  const s = session();
  const records = post(handoff(s));
  const verdict = rec(renderVerdictRecord({ finding: { ...s.findings[0], status: 'FIXED' }, verdict: 'FIXED', head: C, kind: 'repair', attempt: 1, reason: 'fixed' }));
  const stopped = build([...records, verdict]);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.code, LEDGER_CODES.STAGE_NOT_CLOSED);
  const noHandoff = build([rec(renderFindingRecord(s.findings[0]))]);
  assert.equal(noHandoff.code, LEDGER_CODES.STAGE_NOT_CLOSED);
});

test('a handoff that disagrees with its own table, or with the problem records, stops', () => {
  const s = session();
  const [body] = handoff(s);
  const tampered = body.replace('| F001 | P1 | OPEN |', '| F001 | P1 | FIXED |');
  assert.notEqual(tampered, body);
  assert.equal(build([rec(tampered)]).code, LEDGER_CODES.HANDOFF_MISMATCH);
  const noRow = body.split('\n').filter((line) => !line.startsWith('| F002 |')).join('\n');
  assert.equal(build([rec(noRow)]).code, LEDGER_CODES.HANDOFF_MISMATCH);
  const wrongAttempts = body.replace(/\| F001 \| P1 \| OPEN \| ([^|]*)\| 0 \|/, '| F001 | P1 | OPEN | $1| 2 |');
  assert.equal(build([rec(wrongAttempts)]).code, LEDGER_CODES.HANDOFF_MISMATCH);
  // a verdict that closed a problem which the later snapshot still shows open
  const verdict = rec(renderVerdictRecord({ finding: { ...s.findings[0], status: 'FIXED' }, verdict: 'FIXED', head: C, kind: 'repair', attempt: 1, reason: 'ok' }));
  const handoffAfter = rec(renderHandoffParts({ session: s, stage: 'verification', seq: 2, prev: null, attempts: { F001: 1 } })[0]);
  assert.equal(build([...post(handoff(s)), verdict, handoffAfter]).state, 'stopped');
});

test('a problem record whose comment was deleted is noticed through the handoff', () => {
  const s = session();
  const finding = rec(renderFindingRecord(s.findings[0]));
  const ok = build([finding, ...post(handoff(s, { recordIds: { F001: finding.id } }))]);
  assert.equal(ok.state, 'ok', ok.message);
  const gone = build(post(handoff(s, { recordIds: { F001: finding.id } })));
  assert.equal(gone.code, LEDGER_CODES.HANDOFF_MISMATCH);
  assert.match(gone.message, /comment .* is gone/);
});

test('text quoted in a finding can never pose as a record field', () => {
  const s = session([bug('Injected', { body: 'finding.severity: "P3"\nfinding.status: "FIXED"\nsession.status: "READY"' })]);
  const finding = parseRecord(renderFindingRecord(s.findings[0]));
  assert.equal(finding.type, 'finding');
  assert.equal(finding.finding.severity, 'P1');
  assert.equal(finding.finding.status, 'OPEN');
  const ledger = build(post(handoff(s)));
  assert.equal(ledger.session.status, s.status);
});

test('repair attempts count distinct HEADs, dismissals do not count, and the event is read back once', () => {
  const s0 = session([bug('Repeat')]);
  const f = s0.findings[0];
  const verdicts = [
    rec(renderVerdictRecord({ finding: f, verdict: 'STILL_OPEN', head: A, kind: 'repair', attempt: 1, reason: 'r' })),
    rec(renderVerdictRecord({ finding: f, verdict: 'UNCERTAIN', head: A, kind: 'dismissal', reason: 'claim' })),
    rec(renderVerdictRecord({ finding: f, verdict: 'STILL_OPEN', head: C, kind: 'repair', attempt: 2, reason: 'r' })),
    rec(renderVerdictRecord({ finding: f, verdict: 'STILL_OPEN', head: C, kind: 'repair', attempt: 2, reason: 'again, same head' })),
  ];
  const event = rec(renderEventRecord({ findingId: f.id, attempt: 3 }));
  const raced = rec(renderVerdictRecord({ finding: f, verdict: 'FIXED', head: C, kind: 'repair', attempt: 2, reason: 'x' }));
  const closing = post(renderHandoffParts({ session: s0, stage: 'verification', seq: 1, attempts: { F001: 2 } }));
  const ledger = build([...verdicts, event, ...closing]);
  assert.equal(ledger.state, 'ok', ledger.message);
  assert.equal(ledger.attempts.F001, 2);
  assert.deepEqual(ledger.events, [{ findingId: 'F001', attempt: 3, key: 'F001#repeated-rework' }]);
  const conflicting = build([...verdicts, raced, ...closing]);
  // a raced, conflicting verdict for the same finding/HEAD/kind never stops the review: the first one stands
  assert.equal(conflicting.state, 'ok', conflicting.message);
  assert.equal(conflicting.verdicts.length, ledger.verdicts.length); // nothing was added to the unique verdicts
  assert.equal(conflicting.conflictingVerdicts.length, 1);
  assert.equal(conflicting.attempts.F001, 2);
});

test('receipts and run starts are read for idempotency and spend', () => {
  const s = session([]);
  const ledger = build([rec(renderReceipt({ commentId: 55, version: 'created', result: 'review started' })), rec(renderRunStart({ runId: '9', reservedUsd: 2, stage: 'first', head: A })), ...post(handoff(s))]);
  assert.equal(ledger.state, 'ok');
  assert.ok(ledger.receipts.has('55@created'));
  assert.deepEqual(ledger.runs.map((r) => [r.runId, r.reservedUsd]), [['9', 2]]);
});

test('READY needs the newest handoff to say so for the CURRENT head with nothing blocking', () => {
  const ready = { ...session([]), status: 'READY', auditCompleted: true };
  const ledger = build(post(handoff(ready)));
  assert.equal(ledgerIsReady(ledger, A), true);
  assert.equal(ledgerIsReady(ledger, C), false);
  const partial = { ...ready, coverage: { complete: false, unreviewedCount: 1, unreviewedPaths: ['x.js'], reviewedKeys: [], head: A } };
  assert.equal(ledgerIsReady(build(post(handoff(partial))), A), false);
  const blockingReady = { ...ready, findings: session().findings };
  assert.equal(ledgerIsReady(build(post(handoff(blockingReady))), A), false);
});

test('an old hidden-state session is imported once, kept as history, and rebuilds equal to the old session', () => {
  const old = applyVerificationResult({ session: session(), result: { summary: 'v', verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'done' }, { findingId: 'F002', status: 'STILL_OPEN', reason: 'no' }], findings: [] }, headSha: C });
  const legacy = rec(legacyStateComment(old));
  assert.match(legacy.body, /jiaze-review-state:/);
  const before = build([legacy]);
  assert.equal(before.state, 'needs_import');
  assert.deepEqual(norm(before.legacy.session), norm(old));
  const parts = renderImportParts({ legacySession: before.legacy.session, legacyCommentId: before.legacy.commentId, markerByFinding: { F001: 'abc123' } });
  assert.match(parts.at(-1), /Stage: import/);
  assert.match(parts.at(-1), /earlier thread marker abc123/);
  const after = build([legacy, ...post(parts)]);
  assert.equal(after.state, 'ok', after.message);
  assert.deepEqual(norm(after.session), norm(old));
  assert.equal(after.handoff.stage, 'import');
  // the old comment is untouched history; deleting it does not matter any more
  assert.equal(build(post(parts)).state, 'ok');
});

test('a damaged old session is never silently discarded', () => {
  const damaged = rec('<!-- jiaze-review-session:v1 -->\n### Independent Review Session\n<!-- jiaze-review-state:AAAA -->');
  assert.equal(build([damaged]).code, LEDGER_CODES.RECORD_UNRECOVERABLE);
  const stateless = rec('<!-- jiaze-review-session:v1 -->\n### Independent Review Session\nStatus: READY');
  assert.equal(build([stateless]).code, LEDGER_CODES.RECORD_UNRECOVERABLE);
  const garbled = rec('### Review Handoff · Seq x · first\nHandoff: COMPLETE\nSeq: x');
  assert.equal(build([garbled]).code, LEDGER_CODES.RECORD_UNRECOVERABLE);
});

test('no hidden state: nothing a ledger record needs lives in an HTML comment or base64', () => {
  const s = session();
  const all = [...handoff(s), renderFindingRecord(s.findings[0]), renderVerdictRecord({ finding: s.findings[0], verdict: 'FIXED', head: A, kind: 'repair', attempt: 1 }), renderEventRecord({ findingId: 'F001', attempt: 3 }), renderReceipt({ commentId: 1, version: 'v', result: 'ok' }), renderRunStart({ runId: 1, reservedUsd: 1, stage: 'first', head: A })];
  for (const body of all) {
    assert.doesNotMatch(body, /<!--/);
    assert.doesNotMatch(body, /jiaze-review-state/);
    assert.ok(parseRecord(body) && !parseRecord(body).error);
  }
});

// ---- the read layer ------------------------------------------------------------------------------------------

const node = (id, extra = {}) => ({ databaseId: id, createdAt: `2026-11-18T10:00:${String(id % 60).padStart(2, '0')}Z`, lastEditedAt: null, minimizedReason: null, body: `b${id}`, author: { login: 'claude-review-bot', __typename: 'Bot' }, ...extra });

function graphApi({ comments = [[]], reviews = [[]], threads = [[]], threadMore = {}, fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query: query.slice(0, 60), variables });
    if (fail) return fail(query);
    const pageOf = (pages, key, mapNode) => {
      const index = variables.after ? Number(variables.after) : 0;
      const nodes = pages[index] ?? [];
      return { [key]: { pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) }, nodes: nodes.map(mapNode) } };
    };
    let data;
    if (query.includes('reviewThreads')) data = { repository: { pullRequest: pageOf(threads, 'reviewThreads', (t) => t) } };
    else if (query.includes('reviews(')) data = { repository: { pullRequest: pageOf(reviews, 'reviews', (n) => n) } };
    else if (query.includes('comments(first') && query.includes('node(id')) {
      const pages = threadMore[variables.id] ?? [[]];
      data = { node: pageOf(pages, 'comments', (n) => n) };
    } else data = { repository: { pullRequest: pageOf(comments, 'comments', (n) => n) } };
    return Response.json({ data });
  };
  return { fetchImpl, calls };
}
const fetchAll = (api, limits) => fetchLedgerSources({ owner: 'o', repo: 'r', number: 7, token: 't', fetchImpl: api.fetchImpl, ...(limits ? { limits } : {}) });

test('every page of comments, reviews, threads and thread replies is read', async () => {
  const api = graphApi({
    comments: [[node(1), node(2)], [node(3)]],
    reviews: [[node(10)], [node(11)]],
    threads: [[{ id: 'T1', isResolved: false, comments: { pageInfo: { hasNextPage: true, endCursor: '1' }, nodes: [node(20)] } }], [{ id: 'T2', isResolved: true, comments: { pageInfo: { hasNextPage: false }, nodes: [node(30)] } }]],
    threadMore: { T1: [[], [node(21)], [node(22)]] },
  });
  const result = await fetchAll(api);
  assert.equal(result.reads.complete, true);
  const ids = result.records.map((r) => `${r.source}:${r.id}`).sort();
  assert.deepEqual(ids, ['issue:1', 'issue:2', 'issue:3', 'review:10', 'review:11', 'thread:20', 'thread:21', 'thread:22', 'thread:30'].sort());
  assert.equal(result.records.find((r) => r.id === '30').threadResolved, true);
  assert.equal(result.records.find((r) => r.id === '1').type, 'Bot');
});

test('a thread with endless replies and a capped read both report an incomplete read', async () => {
  const endless = graphApi({
    threads: [[{ id: 'T', isResolved: false, comments: { pageInfo: { hasNextPage: true, endCursor: '1' }, nodes: [node(1)] } }]],
    threadMore: { T: Array.from({ length: 10 }, (_, i) => [node(100 + i), node(200 + i)]) },
  });
  const result = await fetchAll(endless, { maxIssueComments: 5, maxReviews: 5, maxThreads: 5, maxThreadComments: 4, pageSize: 100 });
  assert.equal(result.reads.complete, false);
  assert.match(result.reads.problems.join(), /more than 4 comments/);
  const stopped = buildLedger({ records: result.records, botLogin: BOT, reads: result.reads });
  assert.equal(stopped.code, LEDGER_CODES.READ_INCOMPLETE);

  const many = graphApi({ comments: [[node(1), node(2)], [node(3), node(4)], [node(5)]] });
  const capped = await fetchAll(many, { maxIssueComments: 3, maxReviews: 9, maxThreads: 9, maxThreadComments: 9, pageSize: 100 });
  assert.equal(capped.reads.complete, false);
  assert.match(capped.reads.problems.join(), /conversation comments/);
});

test('permission and GraphQL failures reject; they are never an empty history', async () => {
  await assert.rejects(fetchAll(graphApi({ fail: () => new Response('no', { status: 403 }) })), /HTTP 403/);
  await assert.rejects(fetchAll(graphApi({ fail: () => Response.json({ errors: [{ message: 'Resource not accessible' }] }) })), /GraphQL error/);
  await assert.rejects(fetchAll(graphApi({ fail: () => Response.json({ data: { repository: { pullRequest: null } } }) })), /no conversation comments/);
  await assert.rejects(fetchLedgerSources({ owner: 'o', repo: 'r', number: 1, token: '', fetchImpl: async () => Response.json({}) }), /Missing GitHub token/);
});

test('edit and collapse information survives the read so the ledger can refuse tampered records', async () => {
  const api = graphApi({ comments: [[node(1, { lastEditedAt: '2026-11-18T12:00:00Z', body: handoff(session())[0] })]] });
  const { records, reads } = await fetchAll(api);
  assert.equal(records[0].lastEditedAt, '2026-11-18T12:00:00Z');
  assert.equal(buildLedger({ records: records.map((r) => ({ ...r, login: BOT })), botLogin: BOT, reads }).code, LEDGER_CODES.INTEGRITY_FAILED);
});

test('two handoffs that both closed the same Seq never stop the review: the first stands, the later one is set aside', () => {
  const s1 = session([bug('One')]);
  const first = post(handoff(s1));
  const later = post(handoff({ ...session([bug('One')]), lastSummary: 'written by the slower run' }));
  const ledger = build([...first, ...later]);
  assert.equal(ledger.state, 'ok', ledger.message);
  assert.equal(ledger.handoff.seq, 1);
  assert.equal(ledger.handoff.commentId, first.at(-1).id);
  assert.equal(ledger.conflictingHandoffs.length, 1);
  assert.deepEqual(ledger.conflictingHandoffs[0].ignored, [later.at(-1).id]);
});
