import { applyFullReview } from './helpers/full-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    applyDiscoveryResult,
  applyFindingDismissal,
  applyOverride,
  beginDeepReview,
  completeDeepReview,
  applyVerificationResult,
  knownIssuesPromptBlock,
  normalizeReviewResult,
  openMaterialFindings,
  unresolvedMaterialFindings,
  parseSessionComment,
  planReviewSession,
  recordDismissed,
  recordUncertainFindings,
  renderSessionComment,
  sessionCommitStatus,
  matchesKnownDismissal,
  similarity,
} from '../scripts/review-session-core.mjs';
import { buildGeminiRequest } from '../scripts/run-gemini-review.mjs';
import { applyManualOverride } from '../scripts/apply-override.mjs';
import { planSession } from '../scripts/plan-review-session.mjs';
import { parseReviewTrigger } from '../worker/src/review-trigger.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), BASE = 'd'.repeat(40);
const PATH_OK = 'Calling save() twice with the same id keeps the stale copy, so the second write is lost.';
const finding = (over = {}) => ({
  severity: 'P1', title: 'Lost update in save', body: 'Trigger X causes Y; expected Z.',
  path: 'src/a.js', line: 10, riskClass: 'state', failurePath: PATH_OK, ...over,
});
const session = (findings = []) => applyDiscoveryResult({
  result: { summary: 's', findings }, baseSha: BASE, headSha: A, sourceCommentId: '9',
});

// ---- evidence rule -------------------------------------------------------

test('material finding with a weak failurePath is demoted to non-blocking P3', () => {
  const r = normalizeReviewResult({ summary: 's', findings: [finding({ failurePath: 'might fail' })] });
  assert.equal(r.findings[0].severity, 'P3');
  assert.equal(r.findings[0].downgradedFrom, 'P1');
  const s = session(r.findings);
  assert.equal(openMaterialFindings(s).length, 0);
  assert.equal(s.status, 'AUDIT_PENDING');
});

test('material finding with a concrete failurePath stays blocking', () => {
  const r = normalizeReviewResult({ summary: 's', findings: [finding()] });
  assert.equal(r.findings[0].severity, 'P1');
  assert.equal(session(r.findings).status, 'REWORK');
});

test('legacy findings without a failurePath field keep their severity', () => {
  const legacy = finding();
  delete legacy.failurePath;
  assert.equal(normalizeReviewResult({ summary: 's', findings: [legacy] }).findings[0].severity, 'P1');
});

test('Gemini schema requires failurePath on every finding', () => {
  const req = buildGeminiRequest({
    mode: 'incremental', repo: 'a/b', prNumber: 1, headSha: A, prJson: '{}', diff: 'd', session: null,
  });
  assert.ok(req.schema.properties.findings.items.required.includes('failurePath'));
});

// ---- known-issue ledger --------------------------------------------------

const dismissal = (over = {}) => ({
  candidateId: 'D001', verdict: 'REJECTED', reason: 'guard in load() blocks it',
  path: 'src/a.js', line: 10, title: 'Lost update in save path', riskClass: 'state', ...over,
});

test('recordDismissed keeps only evidence-rejected candidates and caps the list', () => {
  const base = session();
  const s = recordDismissed(base, [
    dismissal(), dismissal({ verdict: 'CONFIRMED', title: 'other' }), dismissal({ verdict: 'UNCERTAIN', title: 'unsure thing here' }),
  ], A);
  assert.deepEqual(s.dismissed.map((d) => d.verdict), ['REJECTED']);
  let big = base;
  for (let i = 0; i < 30; i += 1) big = recordDismissed(big, [dismissal({ title: `unique concern number ${i}` })], A);
  assert.equal(big.dismissed.length, 20);
});

test('a reworded repeat of a dismissed concern is recognised; genuinely new ones and similar-but-distinct bugs are not', () => {
  const s = recordDismissed(session(), [dismissal()], A);
  assert.equal(matchesKnownDismissal(finding({ title: 'Save path suffers a lost update' }), s), true);
  assert.equal(matchesKnownDismissal(finding({ title: 'Token never expires', path: 'src/auth.js' }), s), false);
  // a distinct bug with a similarly worded title in the same file is NOT suppressed
  const timeout = recordDismissed(session(), [dismissal({ title: 'Save function returns wrong value on timeout' })], A);
  assert.equal(matchesKnownDismissal(finding({ title: 'Save function returns wrong value on invalid input' }), timeout), false);
  // the same title in a different file is not suppressed
  assert.equal(matchesKnownDismissal(finding({ path: 'src/b.js' }), s), false);
});

test('repair regressions matching a dismissed concern are dropped during verification', () => {
  const open = session([finding()]);
  const s = recordDismissed(open, [dismissal({ title: 'Cache never invalidated on write', path: 'src/c.js' })], A);
  const out = applyVerificationResult({
    session: s, headSha: B,
    result: { summary: 'v', verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'ok' }],
      findings: [finding({ title: 'Cache is never invalidated after write', path: 'src/c.js' })] },
  });
  assert.equal(out.findings.length, 1);
});

test('prompt block lists dismissed and settled items, and is empty when none exist', () => {
  assert.equal(knownIssuesPromptBlock(session()), '');
  const block = knownIssuesPromptBlock(recordDismissed(session(), [dismissal()], A));
  assert.match(block, /ALREADY EXAMINED/);
  assert.match(block, /\[REJECTED\] src\/a\.js/);
  const audit = buildGeminiRequest({
    mode: 'verification', repo: 'a/b', prNumber: 1, headSha: A, prJson: '{}', diff: 'd',
    session: recordDismissed(session(), [dismissal()], A),
  });
  assert.match(audit.prompt, /ALREADY EXAMINED/);
});

test('similarity ignores case and short words', () => {
  assert.ok(similarity('Lost Update in save', 'lost update in SAVE path') > 0.5);
  assert.equal(similarity('', 'x'), 0);
});

test('dismissed ledger survives the session-comment round trip', () => {
  const s = recordDismissed(session(), [dismissal()], A);
  assert.equal(parseSessionComment(renderSessionComment(s)).dismissed.length, 1);
});

// ---- manual override -----------------------------------------------------

test('override waives open findings and ends the session as READY on the current HEAD', () => {
  const s = session([finding()]);
  const out = applyOverride({ session: s, headSha: B, by: 'alice' });
  assert.equal(out.status, 'READY');
  assert.equal(out.lastReviewedHead, B);
  assert.equal(out.findings[0].status, 'WAIVED');
  assert.deepEqual(out.override.waived, ['F001']);
  assert.equal(openMaterialFindings(out).length, 0);
  assert.match(renderSessionComment(out), /manually overridden by @alice/);
});

test('after an override the same HEAD is a no-op and a new commit starts a fresh session', () => {
  const out = applyOverride({ session: session([finding()]), headSha: B, by: 'alice' });
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: B }).mode, 'noop_ready');
  assert.equal(planReviewSession({ session: out, baseSha: BASE, headSha: C }).mode, 'full_review');
});

test('override rejects READY sessions and unsafe user names', () => {
  const ready = applyOverride({ session: session([finding()]), headSha: A, by: 'alice' });
  assert.throws(() => applyOverride({ session: ready, headSha: A, by: 'alice' }), /already READY/);
  assert.throws(() => applyOverride({ session: session([finding()]), headSha: A, by: 'x -->' }), /invalid override user/);
});

test('override command parses only as a standalone first-line command', () => {
  assert.deepEqual(parseReviewTrigger('@jiaze-claude-review-bot override review'), { requestedMode: 'override' });
  assert.equal(parseReviewTrigger('please @jiaze-claude-review-bot override review'), null);
  assert.equal(parseReviewTrigger('> @jiaze-claude-review-bot override review'), null);
  assert.equal(parseReviewTrigger('@jiaze-claude-review-bot override'), null);
});

const author = 'jiaze-claude-review-bot[bot]';
const planEnv = (extra = {}) => ({
  GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
  REQUESTED_MODE: 'override', EXPECTED_REVIEW_AUTHOR: author, ...extra,
});
const listFetch = (comments) => async (url) => {
  if (/issues\/7\/comments/.test(url)) return Response.json(comments);
  if (/pulls\/7\/reviews/.test(url)) return Response.json([]);
  assert.fail('unexpected ' + url);
};

test('planner chooses override only for an unfinished session', async () => {
  const body = renderSessionComment(session([finding()]));
  const plan = await planSession({ env: planEnv(), fetchImpl: listFetch([{ id: 5, user: { login: author }, body }]) });
  assert.equal(plan.decision.mode, 'override');
  const none = await planSession({ env: planEnv(), fetchImpl: listFetch([]) });
  assert.equal(none.decision.mode, 'noop_waiting');
  const ready = renderSessionComment(applyOverride({ session: session([finding()]), headSha: A, by: 'bob' }));
  const done = await planSession({ env: planEnv(), fetchImpl: listFetch([{ id: 5, user: { login: author }, body: ready }]) });
  assert.equal(done.decision.mode, 'noop_waiting');
});

test('apply-override posts the new session comment with the processed-source marker and removes the old one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
  const s = session([finding()]);
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'override' }, session: s, sessionCommentId: '5',
  }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (!init.method) return Response.json({ base: { sha: BASE }, head: { sha: B } });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 6 });
  };
  const out = await applyManualOverride({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
      TRIGGER_USER: 'alice', SOURCE_COMMENT_ID: '77', REVIEW_CONTEXT_DIR: dir },
    fetchImpl,
  });
  assert.equal(out.status, 'READY');
  // READY is a new result for the PR: posted as the newest comment, and the old session comment removed
  const post = calls.find((c) => c.method === 'POST');
  assert.match(post.url, /issues\/7\/comments$/);
  assert.match(calls.find((c) => c.method === 'DELETE').url, /issues\/comments\/5$/);
  const body = JSON.parse(post.body).body;
  assert.match(body, /jiaze-review-source-comment:77/);
  assert.equal(parseSessionComment(body).status, 'READY');
});

test('apply-override refuses when the PR HEAD moved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({
    decision: { mode: 'override' }, session: session([finding()]), sessionCommentId: '5',
  }));
  await assert.rejects(() => applyManualOverride({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: B,
      TRIGGER_USER: 'alice', SOURCE_COMMENT_ID: '77', REVIEW_CONTEXT_DIR: dir },
    fetchImpl: async () => Response.json({ base: { sha: BASE }, head: { sha: C } }),
  }), /PR moved/);
});

const uncertainCandidate = (over={}) => ({
  candidateId:'D001',verdict:'UNCERTAIN',severity:'P2',title:'Possible lost update during save',
  path:'src/a.js',line:10,riskClass:'state',reason:'Validator could not inspect the call site.',...over,
});
const adjudicate = (s,id='F001',head=A) => applyFindingDismissal({
  session:s,findingId:id,headSha:head,by:'maintainer',
  reason:'The changed caller has an exact-HEAD guard that prevents this write path.',
  evidence:['https://github.com/Jiaze-Li/claude-review-bot/blob/main/README.md'],
  sourceCommentId:'304',
});

test('UNCERTAIN P2 from targeted validation persists, blocks READY and is not suppressed',()=>{
  const pending=recordUncertainFindings(session(),[uncertainCandidate()],A);
  assert.equal(pending.status,'HUMAN_REQUIRED');
  assert.equal(openMaterialFindings(pending).length,0);
  assert.equal(unresolvedMaterialFindings(pending).length,1);
  assert.equal(unresolvedMaterialFindings(pending)[0].id,'F001');
  assert.equal(sessionCommitStatus(pending,A).state,'error');
  assert.equal(planReviewSession({session:pending,baseSha:BASE,headSha:A}).mode,'human_required');
  assert.equal(planReviewSession({session:pending,baseSha:BASE,headSha:B}).mode,'full_review');
  assert.equal(knownIssuesPromptBlock(pending),'');
  assert.equal(matchesKnownDismissal(finding({title:'Possible lost update during save'}),pending),false);
  const body=renderSessionComment(pending);
  assert.match(body,/Unresolved material candidates: \*\*1\*\*/);
  assert.match(body,/F001 \*\*P2 · UNCERTAIN \(not confirmed\)\*\*/);
  assert.deepEqual(parseSessionComment(body),pending);
  assert.equal(sessionCommitStatus({...pending,status:'READY'},A).state,'error');
});

test('an evidence-backed dismissal resolves UNCERTAIN; final audit is still required',()=>{
  const pending=recordUncertainFindings(session(),[uncertainCandidate()],A);
  const decided=adjudicate(pending);
  assert.equal(decided.status,'AUDIT_PENDING');
  assert.equal(unresolvedMaterialFindings(decided).length,0);
  assert.equal(decided.findings[0].status,'DISMISSED');
  const audited=applyFullReview({session:decided,headSha:A,result:{summary:'verified',findings:[]}});
  assert.equal(audited.status,'READY');
  assert.equal(sessionCommitStatus(audited,A).state,'success');
  assert.match(renderSessionComment(audited),/dismissed by @maintainer/);
});

test('a confirmed bug may be fixed, but concurrent uncertainty must remain blocking',()=>{
  const withBug=session([finding()]);
  const mixed=recordUncertainFindings(withBug,[uncertainCandidate({title:'Separate uncertain error'})],A);
  assert.equal(mixed.status,'REWORK');
  const fixed=applyVerificationResult({session:mixed,headSha:B,result:{
    summary:'confirmed issue fixed',verifications:[{findingId:'F001',status:'FIXED',reason:'guard added'}],findings:[],
  }});
  assert.equal(fixed.status,'HUMAN_REQUIRED');
  assert.equal(unresolvedMaterialFindings(fixed)[0].id,'F002');
  assert.equal(sessionCommitStatus(fixed,B).state,'error');
  assert.equal(adjudicate(fixed,'F002',B).status,'AUDIT_PENDING');
});

test('an inconclusive material candidate from a delta review blocks READY until a human decides',()=>{
  const clean=applyFullReview({session:session(),headSha:A,result:{summary:'clean model output',findings:[]}});
  assert.equal(clean.status,'READY');
  const withheld=recordUncertainFindings(clean,[uncertainCandidate()],A);
  assert.equal(withheld.status,'HUMAN_REQUIRED');
  assert.equal(sessionCommitStatus(withheld,A).state,'error');
  const decided=adjudicate(withheld);
  assert.equal(decided.status,'READY');
  assert.equal(unresolvedMaterialFindings(decided).length,0);
});

test('old UNCERTAIN suppression markers must not hide later P2 claims',()=>{
  const old={...session(),dismissed:[dismissal({verdict:'UNCERTAIN',title:'Lost update in save path'})]};
  assert.equal(matchesKnownDismissal(finding({title:'Lost update in save path'}),old),false);
  assert.doesNotMatch(knownIssuesPromptBlock(old),/UNCERTAIN/);
});

test('a manual explicit waiver of an uncertain candidate is recorded as human override',()=>{
  const uncertain=recordUncertainFindings(session(),[uncertainCandidate()],A);
  const accepted=applyOverride({session:uncertain,headSha:A,by:'maintainer'});
  assert.equal(accepted.status,'READY');
  assert.equal(accepted.findings[0].status,'WAIVED');
  assert.deepEqual(accepted.override.waived,['F001']);
  assert.match(renderSessionComment(accepted),/manually overridden by @maintainer/);
});

test('manual scoped dismissal planner can select an UNCERTAIN finding without pretending it was confirmed',async()=>{
  const pending=recordUncertainFindings(session(),[uncertainCandidate()],A);
  const result=await planSession({env:planEnv({HEAD_SHA:A,REQUESTED_MODE:'dismiss',SOURCE_KIND:'comment'}),
    fetchImpl:listFetch([{id:5,user:{login:author},body:renderSessionComment(pending)}])});
  assert.equal(result.decision.mode,'dismiss');
});

test('READY never passes for an unaudited tree or any unresolved material issue',()=>{
  const clean=session();
  const audited=applyFullReview({session:clean,headSha:A,result:{summary:'clean',findings:[]}});
  assert.equal(sessionCommitStatus(audited,A).state,'success');
  for(const broken of [
    {...audited,auditCompleted:false},
    {...audited,findings:[{...finding(),id:'F001',status:'OPEN'}]},
    {...audited,findings:[{...finding(),id:'F001',status:'UNCERTAIN'}]},
  ]){
    assert.equal(sessionCommitStatus(broken,A).state,'error');
    assert.equal(planReviewSession({session:broken,baseSha:BASE,headSha:A}).mode,'human_required');
  }
});

test('an unresolved candidate survives a new HEAD and a reset; silence from the next full review never clears it, only a human decision does',()=>{
  const prior=recordUncertainFindings(session(),[uncertainCandidate()],A);
  const full={summary:'model silent',findings:[],coverage:{complete:true,unreviewedPaths:[]}};
  // a new HEAD starts a fresh session with the candidate carried over
  const begun=beginDeepReview({session:prior,baseSha:BASE,headSha:B});
  assert.equal(begun.findings[0].origin,'CARRIED_UNCERTAIN');
  assert.equal(begun.findings[0].status,'UNCERTAIN');
  assert.equal(begun.findings[0].lastCheckedHead,A);
  const done=completeDeepReview({session:begun,headSha:B,result:full});
  assert.equal(done.status,'HUMAN_REQUIRED');
  assert.equal(unresolvedMaterialFindings(done).length,1);
  assert.equal(sessionCommitStatus(done,B).state,'error');
  // the same HEAD (an explicit reset) keeps the session as it is
  const again=completeDeepReview({session:beginDeepReview({session:prior,baseSha:BASE,headSha:A}),headSha:A,result:full});
  assert.equal(again.status,'HUMAN_REQUIRED');
  assert.equal(unresolvedMaterialFindings(again).length,1);
  // a human decision clears it; the final full review is still owed
  const decided=adjudicate(done,'F001',B);
  assert.equal(unresolvedMaterialFindings(decided).length,0);
  assert.equal(decided.status,'AUDIT_PENDING');
});
