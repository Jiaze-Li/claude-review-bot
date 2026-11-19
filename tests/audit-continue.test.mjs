import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { continueReview, decideContinuation, finalReviewOutlook, nextChainId, MAX_CONTINUATIONS } from '../scripts/continue-review.mjs';
import { applyDiscoveryResult, currentCoverage, renderSessionComment, sessionCommitStatus } from '../scripts/review-session-core.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';
import { syncCommitStatus } from '../scripts/sync-commit-status.mjs';

const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40), OLD = 'c'.repeat(40);
const awaiting = applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: HEAD, sourceCommentId: '1' });
const cov = (head) => ({ complete: false, ...(head ? { head } : {}), unreviewedCount: 2, unreviewedPaths: ['left/behind.js', 'also.js'], reviewedKeys: [] });
const input = (session, extra = {}) => ({ session, headSha: HEAD, sourceCommentId: '6492010062', planMode: 'verification', ...extra });
const legacy = { ...awaiting, coverage: cov(null) };
const stale = { ...awaiting, coverage: cov(OLD) };
const live = { ...awaiting, coverage: cov(HEAD) };

test('currentCoverage drops only records that provably belong to an older commit', () => {
  assert.equal(currentCoverage(stale), null);
  assert.equal(currentCoverage(live).head, HEAD);
  assert.equal(currentCoverage(legacy).unreviewedCount, 2); // no head: kept, the conservative reading
  assert.equal(currentCoverage(awaiting), null);
});

test('AC1/AC3: an older commit\'s leftover coverage no longer blocks the final review; this commit\'s own coverage and legacy records still do', () => {
  assert.equal(decideContinuation(input(stale)).continue, true);
  assert.equal(decideContinuation(input(live)).continue, false);
  assert.equal(decideContinuation(input(legacy)).continue, false);
  assert.equal(decideContinuation(input(awaiting)).continue, true);
  assert.equal(decideContinuation(input(stale, { planMode: 'threads' })).continue, false);
});

test('AC2/AC3: the comment lists unreviewed files only for this commit (or unknown) coverage', () => {
  assert.doesNotMatch(renderSessionComment(stale), /Review coverage/);
  assert.doesNotMatch(renderSessionComment(stale), /left\/behind\.js/);
  assert.match(renderSessionComment(live), /Review coverage: \*\*PARTIAL\*\*[\s\S]*left\/behind\.js/);
  assert.match(renderSessionComment(legacy), /left\/behind\.js/);
  const partial = { ...awaiting, status: 'PARTIAL', coverage: cov(HEAD) };
  assert.match(renderSessionComment(partial), /left\/behind\.js/);
});

test('AC4: automatic wording appears exactly when the continuation decision is yes', () => {
  const cases = [
    [input(stale), true], [input(awaiting), true],
    [input(live), false], [input(awaiting, { planMode: 'override' }), false],
    [input(awaiting, { sourceCommentId: nextChainId(nextChainId(nextChainId('6492010062', '1'), '2'), '3') }), false],
  ];
  for (const [args, yes] of cases) {
    assert.equal(decideContinuation(args).continue, yes);
    const text = renderSessionComment(args.session, { finalReview: finalReviewOutlook(args) });
    if (yes) { assert.match(text, /starting automatically/); assert.doesNotMatch(text, /NOT running/); }
    else {
      assert.match(text, /NOT running right now: .+\. Comment `@gemini review`/);
      assert.doesNotMatch(text, /starting automatically|runs automatically/);
    }
  }
  assert.match(renderSessionComment(awaiting, { finalReview: finalReviewOutlook(input(awaiting, { sourceCommentId: '8' + String(MAX_CONTINUATIONS) + '00000000000' })) }), /already continued by itself 3 times/);
});

test('AC4: without a caller verdict the comment never promises an automatic run', () => {
  const text = renderSessionComment(awaiting);
  assert.doesNotMatch(text, /runs automatically|starting automatically/);
  assert.match(text, /may not be running right now[\s\S]*@gemini review/);
});

test('AC6: other statuses read exactly as before', () => {
  const ready = { ...awaiting, status: 'READY', auditCompleted: true };
  assert.doesNotMatch(renderSessionComment(ready, { finalReview: { startsByItself: false, reason: 'x' } }), /NOT running/);
  assert.equal(sessionCommitStatus(ready, HEAD).state, 'success');
  assert.equal(sessionCommitStatus({ ...awaiting, status: 'REVIEW_IN_PROGRESS' }, HEAD).description, 'Full review in progress');
  assert.equal(sessionCommitStatus({ ...awaiting, status: 'REWORK' }, HEAD).state, 'failure');
  assert.equal(sessionCommitStatus({ ...awaiting, status: 'PARTIAL' }, HEAD).state, 'error');
  assert.equal(sessionCommitStatus({ ...awaiting, status: 'HUMAN_REQUIRED' }, HEAD).state, 'error');
  assert.equal(sessionCommitStatus(awaiting, OLD).state, 'pending'); // not this HEAD
  assert.equal(sessionCommitStatus(awaiting, OLD, { finalReviewStarted: false }).state, 'pending');
});

test('AC5: the final review is yellow only when it really was handed on, red otherwise', () => {
  assert.deepEqual(sessionCommitStatus(awaiting, HEAD, { finalReviewStarted: true }), { state: 'pending', description: 'Final review starting automatically' });
  const red = sessionCommitStatus(awaiting, HEAD, { finalReviewStarted: false });
  assert.equal(red.state, 'error');
  assert.match(red.description, /NOT running.*@gemini review/);
  // a run that never tried to hand the review on makes no claim: the old yellow stays
  for (const arg of [{}, undefined]) assert.deepEqual(sessionCommitStatus(awaiting, HEAD, arg), { state: 'pending', description: 'Final audit pending' });
});

const SYNC_ENV = { TARGET_REPO: 'acme/p', PR_NUMBER: '7', HEAD_SHA: HEAD, STATUS_TOKEN: 's', GH_TOKEN: 't', EXPECTED_REVIEW_AUTHOR: 'bot[bot]' };
async function mirror(extra) {
  const posted = [];
  const pr = createFakePr({ author: 'bot[bot]' });
  pr.seed(awaiting);
  await syncCommitStatus({
    env: { ...SYNC_ENV, ...extra },
    fetchImpl: pr.layer(async (url, init = {}) => {
      posted.push(JSON.parse(init.body)); return new Response(null, { status: 201 });
    }),
  });
  return posted[0];
}

test('AC5: the mirror step turns the dispatch result into the commit status', async () => {
  assert.equal((await mirror({ FINAL_REVIEW_DISPATCHED: 'true' })).state, 'pending');
  assert.equal((await mirror({ FINAL_REVIEW_DISPATCHED: 'false' })).state, 'error');
  assert.equal((await mirror({})).state, 'pending'); // the continue step was skipped (waiting/bookkeeping run): no claim, stays yellow
  assert.equal((await mirror({ FINAL_REVIEW_DISPATCHED: '' })).state, 'pending');
});

const RUN_ENV = { TARGET_REPO: 'acme/p', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: HEAD, SOURCE_COMMENT_ID: '6492010062', SOURCE_KIND: 'comment', REQUESTED_MODE: 'auto', TRIGGER_USER: 'j', REVIEW_MODE: 'verification', GH_TOKEN: 't', DISPATCH_TOKEN: 'd', GITHUB_REPOSITORY: 'ctl/repo', GITHUB_RUN_ID: '40844152995', EXPECTED_REVIEW_AUTHOR: 'bot[bot]' };
const runWith = (session, dispatchStatus, logs = []) => {
  const pr = createFakePr({ author: 'bot[bot]' });
  pr.seed(session);
  return continueReview({
    env: RUN_ENV, log: { log: (m) => logs.push(m) },
    fetchImpl: pr.layer(async () => {
      if (dispatchStatus === 'throw') throw new Error('socket hang up');
      return new Response(null, { status: dispatchStatus });
    }),
  });
};

test('AC1/AC4: an old-commit leftover dispatches once; a failed dispatch is reported, not thrown, not silent', async () => {
  assert.equal((await runWith(stale, 204)).dispatched, true);
  const logs = [];
  const failed = await runWith(stale, 500, logs);
  assert.equal(failed.dispatched, false);
  assert.match(logs.join('\n'), /::warning::.*HTTP 500.*@gemini review/);
  assert.equal((await runWith(stale, 'throw')).dispatched, false);
  assert.equal((await runWith(live, 204)).dispatched, false); // nothing to continue
});

test('the workflow names the continue step, hands its result to the status mirror, and stays best-effort', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');
  const start = yml.indexOf('- name: Continue a big review in the next run');
  const block = yml.slice(start, yml.indexOf('- name: Finalize workflow status'));
  assert.match(block, /id: continue\b/);
  assert.match(block, /continue-on-error: true/);
  const mirrorBlock = yml.slice(yml.indexOf('- name: Mirror review state to the required commit status'));
  assert.match(mirrorBlock, /FINAL_REVIEW_DISPATCHED: \$\{\{ steps\.continue\.outputs\.dispatched \}\}/);
  assert.match(fs.readFileSync(new URL('../scripts/continue-review.mjs', import.meta.url), 'utf8'), /GITHUB_OUTPUT/);
});
