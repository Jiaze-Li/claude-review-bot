import { pathToFileURL } from 'node:url';
import { fetchReviewThreads, replyToThread, resolveThread, threadsByFinding, unresolveThread } from './review-threads.mjs';
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
  if (!session) return { resolved: 0, reopened: 0, failed: 0, closed: 0 };
  const bounce = env.REVIEW_MODE === 'verification';
  const wantsResolved = session.findings.filter((finding) => CLOSED.has(finding.status));
  const stillOpen = session.findings.filter((finding) => MATERIAL.has(finding.severity) && ['OPEN', 'UNCERTAIN'].includes(finding.status));
  if (!wantsResolved.length && !(bounce && stillOpen.length)) return { resolved: 0, reopened: 0, failed: 0, closed: 0 };

  const threads = await fetchReviewThreads({ owner, repo, number: Number(prNumber), token, fetchImpl });
  const byFinding = threadsByFinding({ session, threads, botLogin });
  let resolved = 0;
  let reopened = 0;
  let failed = 0;
  const attempt = async (work) => {
    try {
      await work();
      return true;
    } catch (error) {
      failed += 1;
      log.warn?.(`Could not update a review thread: ${String(error.message).slice(0, 200)}`);
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
        const ok = await attempt(async () => {
          await unresolveThread({ token, fetchImpl, id: thread.id });
          if (thread.commentId) {
            await replyToThread({ target, prNumber, commentId: thread.commentId, token, fetchImpl,
              body: `Reopened: I checked the changes since this finding and it still looks open.\n\n${reason}\n\nFix it and resolve the thread again, or, if it is not a bug, comment \`@gemini dismiss ${finding.id}\` with a Reason and Evidence link.` });
          }
        });
        if (ok) reopened += 1;
      }
    }
  }
  const closed = wantsResolved.length;
  log.log?.(`Review threads: ${resolved} resolved for closed findings${reopened ? `, ${reopened} reopened because the finding is still open` : ''}${failed ? `, ${failed} could not be updated` : ''}.`);
  return { resolved, reopened, failed, closed };
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncReviewThreads();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
