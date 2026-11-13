import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSessionComment } from './review-session-core.mjs';
import { saveSessionComment } from './session-comment.mjs';

// A new commit was pushed after the last review. Pushes never start a review, so the session comment would keep
// saying READY about an older commit. This records that the result is out of date: the commit it covers, the
// commit now at the head and how many commits no review has covered. No model call, and nothing else in the
// session changes (status, findings, spend and the reviewed commit stay exactly as they were). Any later review
// moves the reviewed commit, which makes this mark stop applying by itself.
export async function applyStale({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const need = (key) => { if (!env[key]) throw new Error(`Missing required environment variable: ${key}`); return String(env[key]); };
  const target = need('TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = need('PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const headSha = need('HEAD_SHA');
  const sourceCommentId = need('SOURCE_COMMENT_ID');
  const token = need('GH_TOKEN');
  const plan = JSON.parse(fs.readFileSync(path.join(path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context'), 'session-plan.json'), 'utf8'));
  const session = plan.session;
  if (plan.decision?.mode !== 'stale' || !session || !plan.sessionCommentId) {
    throw new Error('Stale marking needs an existing review session');
  }
  if (session.lastReviewedHead === headSha) throw new Error('The reviewed commit is the current head; nothing is out of date');

  const pr = await rest(`https://api.github.com/repos/${target}/pulls/${prNumber}`, token, fetchImpl);
  if (pr.head?.sha !== headSha) {
    log.log?.('The PR moved on before the mark was written; the newer push has its own run.');
    return { session, marked: false };
  }
  let commits = null;
  try {
    const compare = await rest(`https://api.github.com/repos/${target}/compare/${session.lastReviewedHead}...${headSha}`, token, fetchImpl);
    if (Number.isInteger(compare.ahead_by) && compare.ahead_by >= 0) commits = compare.ahead_by;
  } catch (error) {
    log.warn?.(`::warning::Could not count the newer commits: ${String(error.message).slice(0, 160)}`);
  }
  const next = { ...session, staleFor: session.lastReviewedHead, staleHead: headSha, staleCommits: commits };
  const body = renderSessionComment(next, { sourceCommentIds: [sourceCommentId] });
  await saveSessionComment({ target, prNumber, token, fetchImpl, existingId: plan.sessionCommentId, previous: session, session: next, body });
  log.log?.(`Marked the review result for ${session.lastReviewedHead.slice(0, 12)} as out of date (${commits ?? 'unknown number of'} newer commit(s)).`);
  return { session: next, marked: true };
}

async function rest(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status})`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await applyStale(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
