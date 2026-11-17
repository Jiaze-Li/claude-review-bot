import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { currentCoverage } from './review-session-core.mjs';
import { latestSession } from './sync-commit-status.mjs';

// A review that is not finished when a run ends continues by itself: the next run is started on the same HEAD,
// so nobody has to type the command again.
// - the engine ran out of room (PARTIAL coverage on this HEAD): run again, it picks up the files left;
// - every finding is settled (fixed, dismissed) and only the final full review is left (AUDIT_PENDING).
// The chain is capped and stops at the first run that did not leave exactly that kind of work behind.
export const MAX_CONTINUATIONS = 3;
const REVIEW_WORK = new Set(['verification', 'incremental', 'claude', 'dismiss', 'recover']);
const CHAIN_ID = /^8([0-9])\d{11}$/; // 13 digits: '8', continuation number, run id; real comment ids never look like this

// A continuation resumes; it must never repeat a one-shot command (reset, override, dismiss, threads).
// Only `claude` (Claude alone) is carried over, so the model choice holds for the whole chain.
export function continuationMode(requestedMode) {
  return requestedMode === 'claude' ? 'claude' : 'auto';
}

// Money rules follow who asked. A person's review command (and a resolved-threads verification) keeps its manual
// $5-per-call allowance for the whole chain; a dismissal or override is not a request for more review, so what
// follows it is an automatic review under the per-PR allowance.
export function continuationSourceKind(requestedMode, sourceKind) {
  if (['dismiss', 'override'].includes(requestedMode)) return 'pull_request';
  return requestedMode === 'threads' ? 'comment' : (sourceKind || 'comment');
}

export function chainIndex(sourceCommentId) {
  const match = CHAIN_ID.exec(String(sourceCommentId ?? ''));
  return match ? Number(match[1]) : 0;
}

export function nextChainId(sourceCommentId, runId) {
  const run = String(runId ?? '').replace(/\D/g, '').slice(-11).padStart(11, '0');
  return `8${chainIndex(sourceCommentId) + 1}${run}`;
}

// What the session comment says about the final review, from the very same decision that starts it.
// -> { startsByItself: boolean, reason }
export function finalReviewOutlook(input) {
  const decision = decideContinuation(input);
  return { startsByItself: decision.continue, reason: decision.continue ? decision.reason : explainNoContinuation(decision.reason) };
}

function explainNoContinuation(reason) {
  if (reason === 'continuation limit reached') return `it already continued by itself ${MAX_CONTINUATIONS} times in a row`;
  if (reason === 'nothing left to continue') return 'this run did not leave a review to continue automatically';
  return reason;
}

// -> { continue: boolean, reason }
export function decideContinuation({ session, headSha, sourceCommentId, planMode }) {
  if (!session || session.lastReviewedHead !== headSha) return { continue: false, reason: 'no review of this HEAD to continue' };
  if (chainIndex(sourceCommentId) >= MAX_CONTINUATIONS) return { continue: false, reason: 'continuation limit reached' };
  if (session.status === 'PARTIAL' && session.coverage?.head === headSha && planMode === 'claude') {
    return { continue: true, reason: `${session.coverage.unreviewedCount ?? 'some'} file(s) are still unreviewed` };
  }
  // Only a run that did review work leads straight into the final review; a bookkeeping run (a closed P3 thread,
  // an override) does not start paid work on its own.
  if (session.status === 'AUDIT_PENDING' && !currentCoverage(session) && REVIEW_WORK.has(planMode)) {
    return { continue: true, reason: 'only the final full review is left' };
  }
  return { continue: false, reason: 'nothing left to continue' };
}

export async function continueReview({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const need = (key) => { if (!env[key]) throw new Error(`Missing required environment variable: ${key}`); return String(env[key]); };
  const target = need('TARGET_REPO');
  const headSha = need('HEAD_SHA');
  const sourceCommentId = need('SOURCE_COMMENT_ID');
  const session = await latestSession({ target, prNumber: need('PR_NUMBER'), author: need('EXPECTED_REVIEW_AUTHOR'), token: need('GH_TOKEN'), fetchImpl });
  const decision = decideContinuation({
    session, headSha, sourceCommentId, planMode: env.REVIEW_MODE,
  });
  if (!decision.continue) { log.log?.(`No continuation: ${decision.reason}.`); return { ...decision, dispatched: false }; }
  const next = nextChainId(sourceCommentId, env.GITHUB_RUN_ID);
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${need('GITHUB_REPOSITORY')}/actions/workflows/review-v2.yml/dispatches`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${need('DISPATCH_TOKEN')}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({
      ref: env.CONTROL_REF || 'main',
      inputs: {
        target_repo: target, pr_number: need('PR_NUMBER'), base_sha: need('BASE_SHA'), head_sha: headSha,
        trigger_user: need('TRIGGER_USER'), source_comment_id: next,
        source_kind: continuationSourceKind(env.REQUESTED_MODE, env.SOURCE_KIND), requested_mode: continuationMode(env.REQUESTED_MODE),
        ...(env.REVIEW_PROVIDERS ? { review_providers: env.REVIEW_PROVIDERS } : {}),
        ...(env.PROVIDER_BUDGETS ? { provider_budgets: env.PROVIDER_BUDGETS } : {}),
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  } catch (error) {
    return failedDispatch(decision, `network error: ${error.message}`, log);
  }
  if (!response.ok) return failedDispatch(decision, `HTTP ${response.status}`, log);
  log.log?.(`Continuing in another run (${decision.reason}); trigger ${next}.`);
  return { ...decision, next, dispatched: true };
}

// Best effort: a failed dispatch must not fail the run, but it must never be silent either.
function failedDispatch(decision, why, log) {
  log.log?.(`::warning::Could not start the next review run (${why}); comment @gemini review to continue by hand.`);
  return { continue: true, reason: decision.reason, dispatched: false, failure: why };
}

// The status mirror reads this to say whether the final review really is on its way.
function publishOutcome(result, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `dispatched=${result.dispatched === true}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    publishOutcome(await continueReview());
  } catch (error) {
    console.error(error.message);
    publishOutcome({ dispatched: false }); // it tried and could not: never leave the mirror guessing
    process.exitCode = 1;
  }
}
