import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stagedDiffFits } from './review-shards.mjs';
import { latestSession } from './sync-commit-status.mjs';

// A review that has to be finished in several runs (a PR too big for one) continues by itself: when a run ends
// with work left, the next run is started with the same inputs, so nobody has to type the command again.
// - the engine ran out of room (PARTIAL coverage on this HEAD): run again, it picks up the files left;
// - the review is done except for a final audit too big for one staged request: the audit runs in shards.
// The chain is capped and stops at the first run that did not leave exactly that kind of work behind.
export const MAX_CONTINUATIONS = 3;
const CHAIN_ID = /^8([0-9])\d{11}$/; // 13 digits: '8', continuation number, run id; real comment ids never look like this

export function chainIndex(sourceCommentId) {
  const match = CHAIN_ID.exec(String(sourceCommentId ?? ''));
  return match ? Number(match[1]) : 0;
}

export function nextChainId(sourceCommentId, runId) {
  const run = String(runId ?? '').replace(/\D/g, '').slice(-11).padStart(11, '0');
  return `8${chainIndex(sourceCommentId) + 1}${run}`;
}

// -> { continue: boolean, reason }
export function decideContinuation({ session, headSha, sourceCommentId, planMode, stagedFits }) {
  if (!session || session.lastReviewedHead !== headSha) return { continue: false, reason: 'no review of this HEAD to continue' };
  if (chainIndex(sourceCommentId) >= MAX_CONTINUATIONS) return { continue: false, reason: 'continuation limit reached' };
  if (session.status === 'PARTIAL' && session.coverage?.head === headSha && planMode === 'claude') {
    return { continue: true, reason: `${session.coverage.unreviewedCount ?? 'some'} file(s) are still unreviewed` };
  }
  if (session.status === 'AUDIT_PENDING' && !session.coverage && stagedFits === false) {
    return { continue: true, reason: 'the final audit is too large for one run and continues in shards' };
  }
  return { continue: false, reason: 'nothing left to continue' };
}

export async function continueReview({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const need = (key) => { if (!env[key]) throw new Error(`Missing required environment variable: ${key}`); return String(env[key]); };
  const target = need('TARGET_REPO');
  const headSha = need('HEAD_SHA');
  const sourceCommentId = need('SOURCE_COMMENT_ID');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const read = (name) => { try { return fs.readFileSync(path.join(contextRoot, name), 'utf8'); } catch { return ''; } };
  const session = await latestSession({ target, prNumber: need('PR_NUMBER'), author: need('EXPECTED_REVIEW_AUTHOR'), token: need('GH_TOKEN'), fetchImpl });
  const decision = decideContinuation({
    session, headSha, sourceCommentId, planMode: env.REVIEW_MODE,
    stagedFits: stagedDiffFits(read('pr.diff'), read('ignore-patterns.txt')),
  });
  if (!decision.continue) { log.log?.(`No continuation: ${decision.reason}.`); return decision; }
  const next = nextChainId(sourceCommentId, env.GITHUB_RUN_ID);
  const response = await fetchImpl(`https://api.github.com/repos/${need('GITHUB_REPOSITORY')}/actions/workflows/review-v2.yml/dispatches`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${need('DISPATCH_TOKEN')}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({
      ref: env.CONTROL_REF || 'main',
      inputs: {
        target_repo: target, pr_number: need('PR_NUMBER'), base_sha: need('BASE_SHA'), head_sha: headSha,
        trigger_user: need('TRIGGER_USER'), source_comment_id: next,
        source_kind: env.SOURCE_KIND || 'comment', requested_mode: env.REQUESTED_MODE || 'auto',
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Could not start the next review run (HTTP ${response.status})`);
  log.log?.(`Continuing in another run (${decision.reason}); trigger ${next}.`);
  return { ...decision, next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await continueReview();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
