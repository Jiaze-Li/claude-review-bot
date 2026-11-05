import { pathToFileURL } from 'node:url';
import { fetchReviewThreads, replyToThread, reportThreadProblem, resolveThread, threadsByFinding, unresolveThread } from './review-threads.mjs';
import { latestSession } from './sync-commit-status.mjs';

// Keeps the PR's review threads in step with the durable session at the end of a review run.
//
// - A finding that is now FIXED, DISMISSED or WAIVED: its thread is resolved, so "unresolved threads" on the PR
//   means "problems still open".
// - After a verification run: a finding that is still open (or uncertain) but whose thread a person resolved
//   is put back, with the reviewer's reason, because resolving it was a claim that the change fixed it and the
//   review has just checked that claim.
// Only threads the bot started are touched, a person's own resolve of a closed finding is never undone, and a
// failure here never fails a review (best effort).
const CLOSED = new Set(['FIXED', 'DISMISSED', 'WAIVED']);
const MATERIAL = new Set(['P0', 'P1', 'P2']);

export async function syncReviewThreads({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const token = required(env, 'GH_TOKEN');
  const author = required(env, 'EXPECTED_REVIEW_AUTHOR');
  const botLogin = author.replace(/\[bot\]$/, '');
  const [owner, repo] = target.split('/');

  const session = await latestSession({ target, prNumber, author, token, fetchImpl });
  if (!session) return { resolved: 0, reopened: 0, failed: 0, skipped: 0, replyFailed: 0, closed: 0, permissionDenied: false, errors: [] };
  const bounce = env.REVIEW_MODE === 'verification';
  const wantsResolved = session.findings.filter((finding) => CLOSED.has(finding.status));
  const stillOpen = session.findings.filter((finding) => MATERIAL.has(finding.severity) && ['OPEN', 'UNCERTAIN'].includes(finding.status));
  if (!wantsResolved.length && !(bounce && stillOpen.length)) return { resolved: 0, reopened: 0, failed: 0, skipped: 0, replyFailed: 0, closed: 0, permissionDenied: false, errors: [] };

  const threads = await fetchReviewThreads({ owner, repo, number: Number(prNumber), token, fetchImpl });
  const byFinding = threadsByFinding({ session, threads, botLogin });
  let resolved = 0;
  let reopened = 0;
  let failed = 0;
  let skipped = 0; // wanted but not tried: the token was refused once, every further try would be refused too
  let replyFailed = 0;
  let denied = false;
  const errors = [];
  const attempt = async (work) => {
    if (denied) { skipped += 1; return false; }
    try {
      await work();
      return true;
    } catch (error) {
      failed += 1;
      if (error.permissionDenied) denied = true;
      const message = String(error.message).slice(0, 200);
      if (!errors.includes(message)) errors.push(message);
      log.warn?.(`Could not update a review thread: ${message}`);
      return false;
    }
  };

  for (const finding of wantsResolved) {
    for (const thread of byFinding.get(finding.id) ?? []) {
      if (thread.isResolved) continue;
      if (await attempt(() => resolveThread({ token, fetchImpl, id: thread.id }))) resolved += 1;
    }
  }
  if (bounce) {
    for (const finding of stillOpen) {
      for (const thread of byFinding.get(finding.id) ?? []) {
        if (!thread.isResolved || !thread.resolvedBy || thread.resolvedBy === botLogin) continue;
        const reason = String(finding.resolutionReason ?? 'the change does not address it').slice(0, 600);
        if (!await attempt(() => unresolveThread({ token, fetchImpl, id: thread.id }))) continue;
        reopened += 1;
        if (!thread.commentId) continue;
        try {
          await replyToThread({ target, prNumber, commentId: thread.commentId, token, fetchImpl,
            body: `Reopened: I checked the changes since this finding and it still looks open.\n\n${reason}\n\nFix it and resolve the thread again, or, if it is not a bug, comment \`@gemini dismiss ${finding.id}\` with a Reason and Evidence link.` });
        } catch (error) {
          replyFailed += 1;
          log.warn?.(`Reopened a review thread but could not explain why: ${String(error.message).slice(0, 200)}`);
        }
      }
    }
  }
  const closed = wantsResolved.length;
  log.log?.(`Review threads: ${resolved} resolved for closed findings${reopened ? `, ${reopened} reopened because the finding is still open` : ''}${failed ? `, ${failed} could not be updated` : ''}${skipped ? `, ${skipped} not tried after the token was refused` : ''}.`);
  const result = { resolved, reopened, failed, skipped, replyFailed, closed, permissionDenied: denied, errors };
  if (needsAttention(result)) reportProblem({ env, log, result });
  return result;
}

export const needsAttention = (result) => Boolean(result.failed || result.skipped || result.replyFailed);

function reportProblem({ env, log, result }) {
  reportThreadProblem({
    env, log,
    heading: 'Review thread sync did not fully complete',
    counts: `Resolved: ${result.resolved}, reopened: ${result.reopened}, failed: ${result.failed}, not tried: ${result.skipped}${result.replyFailed ? `, reopen notes not posted: ${result.replyFailed}` : ''}`,
    errors: result.errors,
    permissionDenied: result.permissionDenied,
    warning: `${result.failed} failed, ${result.skipped} not tried${result.replyFailed ? `, ${result.replyFailed} reopen note(s) not posted` : ''}${result.permissionDenied ? ' (permission refused by GitHub)' : ''}.`,
  });
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await syncReviewThreads();
    // A red step (the workflow keeps it from failing the job) so a partial or total failure is never shown as success.
    if (needsAttention(result)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
