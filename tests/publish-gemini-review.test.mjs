import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGeminiReview } from '../scripts/publish-gemini-review.mjs';
import { createFakePr, BOT } from './helpers/fake-pr.mjs';
import { renderFindingRecord } from '../scripts/review-ledger.mjs';
import { splitForParts } from '../scripts/github-review-api.mjs';
import { applyDiscoveryResult, beginDeepReview, completeDeepReview, sessionCommitStatus } from '../scripts/review-session-core.mjs';

const A = 'a'.repeat(40);
const ENV_AUTHOR = { EXPECTED_REVIEW_AUTHOR: BOT };
// the conversation comments the run wrote (receipts, closing handoff, visible summary), in order
const summaryOf = (pr) => pr.issue.at(-1).body;
const allBodies = (pr) => pr.issue.map((c) => c.body).join('\n');
// the fake PR answers comments/GraphQL; the test supplies the rest (pull request, files, review POST)
const withPr = (pr, own) => pr.layer(async (url, init = {}) => own(url, init));
const BASE = 'b'.repeat(40);
// The staged publisher only handles deltas on top of a reviewed state: here, a READY baseline for the previous HEAD.
const OLD = 'd'.repeat(40);
function readyBaseline() {
  const first = applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: OLD, sourceCommentId: '1' });
  return completeDeepReview({ session: beginDeepReview({ session: first, baseSha: BASE, headSha: OLD }), result: { summary: 'clean', findings: [], coverage: { complete: true, unreviewedPaths: [] } }, headSha: OLD });
}
const incrementalPlan = (extra = {}) => JSON.stringify({ decision: { mode: 'incremental', previousHead: OLD }, session: readyBaseline(), sessionCommentId: null, ...extra });

test('publisher writes durable session and exact-head PR review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    summary: 'Found one bug.',
    findings: [{
      severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.',
      path: 'a.js', line: 1, riskClass: 'state',
    }],
    _meta: { resolved_model: 'gemini-3.8-flash', effort: 'low', usage: { input_tokens: 10, output_tokens: 5, thoughts_tokens: 2 } },
  }));

  const calls = [];
  const pr = createFakePr();
  const fetchImpl = withPr(pr, async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (url.includes('/pulls/7/files')) return Response.json([{ filename: 'a.js', patch: '@@ -0,0 +1 @@\n+bug' }]);
    if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202, html_url: 'https://example/review' });
    assert.fail('unexpected URL ' + url);
  });

  const out = await publishGeminiReview({
    env: {
      GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
      SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, ...ENV_AUTHOR,
    },
    fetchImpl,
  });
  assert.equal(out.session.status, 'REWORK');
  assert.match(summaryOf(pr), /Independent Review Session/);
  assert.match(summaryOf(pr), /F001/);
  assert.equal(pr.session().status, 'REWORK'); // rebuilt from the PR records alone
  const reviewCall = calls.find((call) => call.url.endsWith('/pulls/7/reviews') && call.method === 'POST');
  assert.equal(reviewCall.body.commit_id, A);
  assert.match(reviewCall.body.body, /Gemini Incremental Review/);
  assert.match(reviewCall.body.body, /### Review Pending Handoff · comment 99/);
  assert.doesNotMatch(reviewCall.body.body, /Handled: comment 99/);
  assert.match(allBodies(pr), /Handled: comment 99 \(version created\)/);
  assert.equal(reviewCall.body.comments[0].line, 1);
});

test('publisher refuses stale HEAD before any write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-stale-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ summary: 'clean', findings: [] }));
  const calls = [];
  await assert.rejects(() => publishGeminiReview({
    env: {
      GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
      SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, ...ENV_AUTHOR,
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ base: { sha: BASE }, head: { sha: 'c'.repeat(40) } });
    },
  }), /refusing stale review/);
  assert.equal(calls.length, 1);
});


async function publishWhilePrMoves(findings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-race-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ summary: findings.length ? 'bug' : 'clean', findings }));
  const C = 'c'.repeat(40);
  let prReads = 0;
  const calls = [];
  const pr = createFakePr();
  const out = await publishGeminiReview({
    env: {
      GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A,
      SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, ...ENV_AUTHOR,
    },
    fetchImpl: withPr(pr, async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/pulls/7')) {
        prReads += 1;
        return Response.json({ base: { sha: BASE }, head: { sha: prReads === 1 ? A : C } });
      }
      if (/\/compare\//.test(url)) return Response.json({ ahead_by: 3 });
      if (url.includes('/pulls/7/files')) return Response.json([{ filename: 'a.js', patch: '@@ -0,0 +1 @@\n+bug' }]);
      if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202 });
      assert.fail('unexpected URL ' + url);
    }),
  });
  return { out, calls, C, pr };
}

test('HEAD moving after the review was posted still records the review for the reviewed commit, marked out of date', async () => {
  const bug = [{ severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' }];
  const { out, calls, C, pr } = await publishWhilePrMoves(bug);
  assert.equal(calls.filter((c) => c.url.endsWith('/pulls/7/reviews')).length, 1);
  assert.ok(pr.issue.length > 0, 'the session records are written');
  assert.match(summaryOf(pr), /NOT current/);
  assert.match(summaryOf(pr), /3 newer commits/);
  assert.match(summaryOf(pr), /F001/);
  assert.equal(pr.session().staleHead, C);
  assert.equal(out.session.status, 'REWORK');
  assert.equal(out.session.lastReviewedHead, A);
  assert.equal(out.session.staleFor, A);
  assert.equal(out.session.staleHead, C);
  assert.notEqual(sessionCommitStatus(out.session, C).state, 'success');
});

test('a clean review whose HEAD moved is recorded for the old commit only', async () => {
  const { out, C } = await publishWhilePrMoves([]);
  assert.equal(out.session.status, 'READY');
  assert.equal(out.session.lastReviewedHead, A);
  assert.equal(out.session.staleHead, C);
  assert.notEqual(sessionCommitStatus(out.session, C).state, 'success');
});

test('review publication followed by session-write failure remains recoverable without processed marker', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-gemini-partial-'));
  fs.writeFileSync(path.join(dir,'session-plan.json'),incrementalPlan());
  const reviewPath=path.join(dir,'review.json');
  fs.writeFileSync(reviewPath,JSON.stringify({summary:'clean',findings:[]}));
  let reviewBody='';
  const pr=createFakePr();
  const own=async(url,init={})=>{
    if(url.endsWith('/pulls/7')) return Response.json({base:{sha:BASE},head:{sha:A}});
    if(url.includes('/pulls/7/files')) return Response.json([]);
    if(url.endsWith('/pulls/7/reviews')){
      reviewBody=JSON.parse(init.body).body;
      return Response.json({id:202});
    }
    assert.fail('unexpected URL '+url);
  };
  const base=pr.layer(own);
  await assert.rejects(()=>publishGeminiReview({
    env:{
      GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',BASE_SHA:BASE,HEAD_SHA:A,
      SOURCE_COMMENT_ID:'99',REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir,...ENV_AUTHOR,
    },
    // every write to the conversation fails after the review was posted
    fetchImpl:async(url,init={})=>(init.method==='POST'&&url.endsWith('/issues/7/comments'))?new Response('write failed',{status:503}):base(url,init),
  }),/HTTP 503/);
  assert.match(reviewBody,/### Review Pending Handoff · comment 99/);
  assert.doesNotMatch(reviewBody,/Handled: comment 99/);
  assert.equal(pr.issue.length,0); // nothing was marked handled, so a retry runs again
});


test('droppedFindings tells apart same-title findings in different files', async () => {
  const { droppedFindings } = await import('../scripts/publish-gemini-review.mjs');
  const reported = [
    { title: 'Stale read', path: 'src/a.js' },
    { title: 'Stale read', path: 'src/b.js' },
  ];
  const kept = [{ title: 'Stale read', path: 'src/b.js' }];
  assert.deepEqual(droppedFindings(reported, kept), [{ title: 'Stale read', path: 'src/a.js' }]);
  assert.deepEqual(droppedFindings(reported, reported), []);
});

test('publisher preserves a material UNCERTAIN candidate and never leaves an inconclusive review READY', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publish-uncertain-'));
  fs.writeFileSync(path.join(dir,'session-plan.json'),incrementalPlan({requestedMode:'auto'}));
  const reviewPath=path.join(dir,'review.json');
  fs.writeFileSync(reviewPath,JSON.stringify({
    summary:'Possible budget authorization bug',findings:[],
    _meta:{provider:'gemini',resolved_model:'gemini-flash-latest'},
    _validation:{status:'VALIDATED',validations:[{
      candidateId:'D001',verdict:'UNCERTAIN',severity:'P2',
      title:'Dismiss comment might bypass spending cap',path:'.github/workflows/review-v2.yml',
      line:462,riskClass:'budget',reason:'Caller context was missing for the validator.',
    }]},
  }));
  let reviewBody='';
  const pr=createFakePr();
  const out=await publishGeminiReview({
    env:{GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',
      BASE_SHA:BASE,HEAD_SHA:A,SOURCE_COMMENT_ID:'99',
      REVIEW_PATH:reviewPath,REVIEW_CONTEXT_DIR:dir,...ENV_AUTHOR},
    fetchImpl:withPr(pr,async(url,init={})=>{
      if(url.endsWith('/pulls/7')) return Response.json({base:{sha:BASE},head:{sha:A}});
      if(url.includes('/pulls/7/files')) return Response.json([]);
      if(url.endsWith('/pulls/7/reviews')){
        reviewBody=JSON.parse(init.body).body;
        return Response.json({id:202});
      }
      assert.fail('unexpected '+url);
    }),
  });
  const sessionComment=summaryOf(pr);
  assert.equal(out.session.status,'HUMAN_REQUIRED');
  assert.equal(out.session.findings[0].status,'UNCERTAIN');
  assert.equal(out.session.findings[0].id,'F001');
  assert.equal(out.session.dismissed.length,0);
  assert.equal(sessionCommitStatus(out.session,A).state,'error');
  assert.match(sessionComment,/Unresolved material candidates: \*\*1\*\*/);
  assert.match(reviewBody,/Not merge-ready/);
  assert.match(reviewBody,/F001 · P2/);
  assert.match(reviewBody,/\*\*HUMAN_REQUIRED\*\*/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'published-session.json'),'utf8')).session.status,
    'HUMAN_REQUIRED');
});

test('a finding whose line is outside the diff is still pinned as a resolvable thread, with its marker; a file outside the PR stays in the body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gemini-anchor-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    summary: 'Found three.',
    findings: [
      { severity: 'P2', title: 'Line far from the change', body: 'b1', path: 'a.js', line: 534, riskClass: 'state' },
      { severity: 'P3', title: 'No line given', body: 'b2', path: 'a.js', line: null, riskClass: 'state' },
      { severity: 'P3', title: 'In a file the PR does not touch', body: 'b3', path: 'untouched.js', line: 5, riskClass: 'state' },
    ],
    _meta: { resolved_model: 'gemini-x', effort: 'low', usage: { input_tokens: 1, output_tokens: 1, thoughts_tokens: 0 } },
  }));
  const calls = [];
  const fetchImpl = withPr(createFakePr(), async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (url.includes('/pulls/7/files')) return Response.json([{ filename: 'a.js', patch: '@@ -1,2 +1,3 @@\n keep\n+new line\n keep too' }]);
    if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202, html_url: 'https://example/review' });
    assert.fail('unexpected URL ' + url);
  });
  await publishGeminiReview({
    env: { GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, ...ENV_AUTHOR },
    fetchImpl,
  });
  const review = calls.find((call) => call.url.endsWith('/pulls/7/reviews') && call.method === 'POST').body;
  assert.equal(review.comments.length, 2);
  assert.ok(review.comments.every((c) => c.path === 'a.js' && c.line === 2 && c.side === 'RIGHT'));
  assert.match(review.comments[0].body, /Pinned to the nearest changed line: line 534 is outside the changed lines/);
  assert.match(review.comments[1].body, /file-level finding/);
  assert.ok(review.comments.every((c) => /<!-- jiaze-finding:[0-9a-f]{10} -->/.test(c.body)));
  assert.match(review.body, /Findings without an inline anchor[\s\S]*In a file the PR does not touch/);
  assert.doesNotMatch(review.body, /Line far from the change<\/b>|Line far from the change.*untouched/);
});

// ---- verification answers become readable Verdict records, once per finding/HEAD ---------------------------------
function verificationRun({ pr, status = 'FIXED', head = A, previous = OLD, failHandoff = false, summary = 'checked', before = null, reviews = null, findings = [] }) {
  const base = applyDiscoveryResult({
    result: { summary: 'bug', findings: [{ severity: 'P1', title: 'Bug', body: 'Trigger X causes Y; expected Z.', path: 'a.js', line: 1, riskClass: 'state' }] },
    baseSha: BASE, headSha: previous, sourceCommentId: '1',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-verify-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'verification', previousHead: previous }, session: base, sessionCommentId: null }));
  before?.(base);
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ summary, verifications: [{ findingId: 'F001', status, reason: 'The guard is now checked before the write.' }], findings }));
  return publishGeminiReview({
    env: { GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: head, SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, GITHUB_RUN_ID: '4242', ...ENV_AUTHOR },
    fetchImpl: (() => {
      const base = withPr(pr, async (url, init = {}) => {
        if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: head } });
        if (url.includes('/pulls/7/files')) return Response.json([]);
        if (url.endsWith('/pulls/7/reviews')) { reviews?.(JSON.parse(init.body)); return Response.json({ id: 202 }); }
        assert.fail('unexpected URL ' + url);
      });
      // a crash between the verdict and the closing handoff: the handoff write fails
      return async (url, init = {}) => (failHandoff && init.method === 'POST' && /Handoff: COMPLETE/.test(init.body ?? '') && /issues\/7\/comments$/.test(url))
        ? new Response('boom', { status: 503 }) : base(url, init);
    })(),
  });
}

test('a verification run writes one readable Verdict record per finding and HEAD before the closing handoff', async () => {
  const pr = createFakePr();
  const out = await verificationRun({ pr });
  assert.equal(out.session.findings[0].status, 'FIXED');
  const verdicts = pr.issue.filter((c) => /^### Review Verdict · F001 · FIXED/.test(c.body));
  assert.equal(verdicts.length, 1);
  assert.match(verdicts[0].body, new RegExp('Range: ' + OLD + '\\.\\.' + A));
  assert.match(verdicts[0].body, /Kind: repair/);
  assert.match(verdicts[0].body, /Attempt: 1/);
  // the handoff that closes the stage is written after the verdict and counts the repair attempt
  const handoff = pr.issue.findLast((c) => /Handoff: COMPLETE/.test(c.body));
  assert.ok(pr.issue.indexOf(handoff) > pr.issue.indexOf(verdicts[0]));
  assert.match(handoff.body, /\| F001 \| P1 \| FIXED \| [0-9a-f]{40} \| 1 \| no \|/);
  assert.equal(pr.ledger().state, 'ok');
  assert.equal(pr.ledger().attempts.F001, 1);
});

test('the same verdict for the same finding and HEAD is never written twice, even when the run repeats', async () => {
  const pr = createFakePr();
  await verificationRun({ pr });
  await verificationRun({ pr }).catch(() => {}); // a repeat may be refused by the ledger; it must never duplicate the verdict
  assert.equal(pr.issue.filter((c) => /^### Review Verdict · F001/.test(c.body)).length, 1);
});

test('crash between the verdict and the closing handoff: the stage stays open, then the retry only writes what is missing', async () => {
  const pr = createFakePr();
  await assert.rejects(() => verificationRun({ pr, failHandoff: true }), /HTTP 503/);
  assert.equal(pr.issue.filter((c) => /^### Review Verdict · F001/.test(c.body)).length, 1);
  assert.equal(pr.issue.some((c) => /Handoff: COMPLETE/.test(c.body)), false);
  // a reader that does not know the retry refuses to trust a stage that never closed
  assert.equal(pr.ledger().state, 'stopped');
  assert.equal(pr.ledger().code, 'STAGE_NOT_CLOSED');
  // the retry (same command) writes the missing handoff and does not repeat the verdict
  const out = await verificationRun({ pr });
  assert.equal(out.session.findings[0].status, 'FIXED');
  assert.equal(pr.issue.filter((c) => /^### Review Verdict · F001/.test(c.body)).length, 1);
  assert.equal(pr.ledger().state, 'ok');
  assert.equal(pr.session().findings[0].status, 'FIXED');
});

test('the readable summary and the handoff table say the same thing about every finding', async () => {
  const pr = createFakePr();
  const out = await verificationRun({ pr, status: 'STILL_OPEN' });
  const summary = pr.issue.at(-1).body;
  const handoff = pr.issue.findLast((c) => /Handoff: COMPLETE/.test(c.body)).body;
  for (const finding of out.session.findings) {
    assert.match(summary, new RegExp(finding.id + '\\b'));
    assert.match(handoff, new RegExp('\\| ' + finding.id + ' \\| ' + finding.severity + ' \\| ' + finding.status + ' \\|'));
  }
  assert.match(summary, /Status: \*\*REWORK\*\*/);
  assert.match(handoff, /session\.status: "REWORK"/);
  assert.match(handoff, /Ready: no/);
});

// ---- REPEATED_REWORK: exactly one event, at the third independent repair attempt ----------------------------------
test('the third repair attempt of one finding raises exactly one REPEATED_REWORK event, the fourth none, a dismissal never counts', async () => {
  const pr = createFakePr();
  const heads = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  // the same finding stays open across four different HEADs: each verification pass is one repair attempt
  let previous = OLD;
  const seen = [];
  for (const head of heads) {
    await verificationRun({ pr, status: 'STILL_OPEN', head, previous });
    previous = head;
    seen.push(pr.issue.filter((c) => /^### Review Event · F001 · REPEATED_REWORK/.test(c.body)).length);
  }
  assert.deepEqual(seen, [0, 0, 1, 1]);
  const attempts = pr.issue.filter((c) => /^### Review Verdict · F001/.test(c.body)).map((c) => /Attempt: (\d+)/.exec(c.body)[1]);
  assert.deepEqual(attempts, ['1', '2', '3', '4']);
  assert.match(pr.issue.findLast((c) => /Handoff: COMPLETE/.test(c.body)).body, /\| F001 \| P1 \| OPEN \| [0-9a-f]{40} \| 4 \| yes \|/);
  assert.equal(pr.ledger().state, 'ok');
  assert.equal(pr.ledger().events.length, 1);
});

// ---- the verdict sits in the finding's own thread; a long report continues in numbered parts --------------------------
test('a verdict is written as a reply inside the finding\'s own thread, and the ledger still reads it', async () => {
  const pr = createFakePr();
  let thread;
  const out = await verificationRun({
    pr, before: (base) => { thread = pr.addThread([{ body: renderFindingRecord(base.findings[0], { headSha: OLD }) }]); },
  });
  assert.equal(out.session.findings[0].status, 'FIXED');
  assert.equal(thread.comments.length, 2);
  assert.match(thread.comments[1].body, /^### Review Verdict · F001 · FIXED/);
  assert.equal(pr.issue.filter((c) => /^### Review Verdict/.test(c.body)).length, 0);
  assert.equal(pr.ledger().state, 'ok');
  assert.equal(pr.ledger().verdicts.length, 1);
});

test('a finding with no thread gets its verdict as a conversation comment instead', async () => {
  const pr = createFakePr();
  await verificationRun({ pr });
  assert.equal(pr.issue.filter((c) => /^### Review Verdict · F001/.test(c.body)).length, 1);
});

test('a report too long for one comment continues in numbered parts and loses nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-long-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), incrementalPlan());
  const reviewPath = path.join(dir, 'review.json');
  // 150 targeted-validation lines: the details are the part of a report that can grow without bound
  const validations = Array.from({ length: 150 }, (_, i) => ({ candidateId: `C${i}`, severity: 'P2', verdict: 'REJECTED', title: `Candidate ${i}`, reason: 'r'.repeat(500) }));
  fs.writeFileSync(reviewPath, JSON.stringify({ summary: 'Nothing material.', findings: [], _validation: { status: 'DONE', validations } }));
  const pr = createFakePr();
  let review;
  await publishGeminiReview({
    env: { GH_TOKEN: 'token', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, ...ENV_AUTHOR },
    fetchImpl: withPr(pr, async (url, init = {}) => {
      if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
      if (url.includes('/pulls/7/files')) return Response.json([]);
      if (url.endsWith('/pulls/7/reviews')) { review = JSON.parse(init.body); return Response.json({ id: 202 }); }
      assert.fail('unexpected URL ' + url);
    }),
  });
  assert.ok(Buffer.byteLength(review.body, 'utf8') <= 60000);
  assert.match(review.body, /The rest of this report .* continues in \d+ comments? right below/);
  assert.match(review.body, /### Session result/); // the verdict stays in the review itself
  const parts = pr.issue.filter((c) => /^### Review Report · Part \d+\/\d+/.test(c.body));
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((c) => Buffer.byteLength(c.body, 'utf8') < 60000));
  assert.ok(parts.every((c) => c.body.includes('<details>') && c.body.includes('</details>')));
  const joined = parts.map((c) => c.body).join('\n');
  assert.ok(joined.includes('Candidate 0') && joined.includes('Candidate 149'));
  assert.equal(pr.ledger().state, 'ok'); // the parts are readable reports, not records the ledger would trip on
});

test('splitForParts cuts at line boundaries, never exceeds the size, and keeps every byte', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} 中文`).join('\n');
  const parts = splitForParts(text, 700);
  assert.ok(parts.length > 3 && parts.every((p) => Buffer.byteLength(p, 'utf8') <= 700));
  assert.equal(parts.join('\n'), text);
  const oneHuge = splitForParts('y'.repeat(5000), 700);
  assert.ok(oneHuge.every((p) => Buffer.byteLength(p, 'utf8') <= 700));
  assert.equal(oneHuge.join(''), 'y'.repeat(5000));
});
