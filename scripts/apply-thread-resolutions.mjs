import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchReviewThreads, isWriter, replyToThread, threadsByFinding, unresolveThread, blockingClaims } from './review-threads.mjs';
import { saveSessionComment } from './session-comment.mjs';
import { applyThreadDecisions, renderSessionComment } from './review-session-core.mjs';

// A person resolving or reopening the bot's review threads. No model call here (when a review of the changes is
// needed the planner picks the verification mode instead; see planSession). This reconciles what is left:
//
// - A non-blocking finding (P3) whose thread a writer resolved is closed and never re-raised; unresolving the
//   thread reopens it.
// - Blocking findings that a person has now ALL resolved, when nothing has been pushed since the review, cannot be
//   checked: there is no change to look at. Their threads are reopened with a reply saying what to do.
// - Anything else (some blocking threads still unresolved) is left alone, so a person can work through them.
// The threads' current state is what is applied, so a missed or repeated event cannot leave things out of step.
export async function applyThreadResolutions({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID');
  const token = required(env, 'GH_TOKEN');
  const botLogin = required(env, 'EXPECTED_REVIEW_AUTHOR').replace(/\[bot\]$/, '');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'threads' || !plan.session || !plan.sessionCommentId) {
    throw new Error('Thread decisions need an existing review session');
  }
  const session = plan.session;
  const [owner, repo] = target.split('/');

  const pr = await rest(`https://api.github.com/repos/${target}/pulls/${prNumber}`, token, fetchImpl);
  if (pr.base?.sha !== baseSha || pr.head?.sha !== headSha) throw new Error('PR moved before thread decisions; refusing stale update');

  const threads = await fetchReviewThreads({ owner, repo, number: Number(prNumber), token, fetchImpl });
  const byFinding = threadsByFinding({ session, threads, botLogin });
  const writers = new Map();
  const writer = async (login) => {
    if (!writers.has(login)) writers.set(login, await isWriter({ target, login, token, fetchImpl }));
    return writers.get(login);
  };

  const closed = [];
  const reopened = [];
  for (const finding of session.findings) {
    const own = byFinding.get(finding.id) ?? [];
    if (!own.length) continue;
    if (finding.status === 'DEFERRED' && own.every((thread) => thread.isResolved)) {
      const by = own.map((thread) => thread.resolvedBy).find((login) => login && login !== botLogin);
      if (by && await writer(by)) closed.push({ id: finding.id, by });
    } else if (finding.status === 'WAIVED' && finding.resolvedVia === 'thread' && own.some((thread) => !thread.isResolved)) {
      reopened.push(finding.id);
    }
  }

  // Everything blocking is resolved but nothing new was pushed: there is nothing to verify. Put the threads back.
  let bounced = 0;
  const claims = blockingClaims({ session, byFinding, botLogin });
  if (claims.allClaimed && session.lastReviewedHead === headSha) {
    for (const finding of claims.claimed) {
      for (const thread of byFinding.get(finding.id)) {
        try {
          await unresolveThread({ token, fetchImpl, id: thread.id });
          if (thread.commentId) {
            await replyToThread({ target, prNumber, commentId: thread.commentId, token, fetchImpl,
              body: `Reopened: nothing has been pushed since I reported this, so there is no change for me to check.\n\nPush a fix and resolve the thread again, or, if it is not a bug, comment \`@gemini dismiss ${finding.id}\` with a Reason and Evidence link.` });
          }
          bounced += 1;
        } catch (error) {
          log.warn?.(`Could not reopen a thread: ${String(error.message).slice(0, 200)}`);
        }
      }
    }
  }

  const next = applyThreadDecisions({ session, headSha, closed, reopened });
  if (next !== session) {
    const body = renderSessionComment(next, { sourceCommentIds: [sourceCommentId] });
    await saveSessionComment({ target, prNumber, token, fetchImpl, existingId: plan.sessionCommentId, previous: session, session: next, body });
  }
  log.log?.(`Review-thread decisions: ${closed.length} non-blocking finding(s) closed, ${reopened.length} reopened, ${bounced} thread(s) put back (nothing to verify).`);
  return { session: next, closed, reopened, bounced };
}

async function rest(url, token, fetchImpl, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await applyThreadResolutions();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
