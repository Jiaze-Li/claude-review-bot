import { pathToFileURL } from 'node:url';
import {
  DEEP_REVIEW_RUN_BUDGET_USD, failDeepReview, isDeepReviewStale, parseSessionComment, renderSessionComment,
} from './review-session-core.mjs';
import { postCommitStatus } from './sync-commit-status.mjs';

// Scheduled safety net: a deep review whose job died without cleanup would otherwise sit in
// REVIEW_IN_PROGRESS until someone triggers another review. This closes it to HUMAN_REQUIRED
// (and the required status to error) without any model call.
export async function sweepStaleDeepReviews({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const repos = String(env.REVIEW_TARGET_REPOS || '').split(/[\s,]+/).filter(Boolean);
  const author = env.EXPECTED_REVIEW_AUTHOR;
  if (!author) throw new Error('Missing required environment variable: EXPECTED_REVIEW_AUTHOR');
  const failed = [];
  for (const repo of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Invalid repository in REVIEW_TARGET_REPOS: ${repo}`);
    const prs = await pages(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, env.GH_TOKEN, fetchImpl);
    for (const pr of prs) {
      const comments = await pages(`https://api.github.com/repos/${repo}/issues/${pr.number}/comments?per_page=100`, env.GH_TOKEN, fetchImpl);
      const latest = comments
        .filter((c) => c?.user?.login === author && typeof c.body === 'string' && c.body.includes('<!-- jiaze-review-session:v1 -->'))
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      const session = latest ? parseSessionComment(latest.body) : null;
      if (!session || !isDeepReviewStale(session, now)) continue;
      // A moved PR is replanned by its next review from the interrupted status; leave it.
      if (session.lastReviewedHead !== pr.head?.sha) continue;
      const closed = failDeepReview({
        session, headSha: session.lastReviewedHead, reason: 'deep review never reported back (swept after timeout)',
        spentUsd: session.deepReview?.reservedUsd ?? DEEP_REVIEW_RUN_BUDGET_USD, now: new Date(now).toISOString(),
      });
      await github(`https://api.github.com/repos/${repo}/issues/comments/${latest.id}`, env.GH_TOKEN, fetchImpl, {
        method: 'PATCH', body: JSON.stringify({ body: renderSessionComment(closed) }),
      });
      await postCommitStatus({
        env, fetchImpl, target: repo, headSha: session.lastReviewedHead,
        status: { state: 'error', description: 'Claude deep review timed out: human judgment required' },
      });
      failed.push(`${repo}#${pr.number}`);
    }
  }
  console.log(failed.length ? `Closed stale deep reviews: ${failed.join(', ')}` : 'No stale deep reviews.');
  return failed;
}

async function pages(url, token, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await github(`${url}&page=${page}`, token, fetchImpl);
    if (!Array.isArray(batch)) throw new Error('GitHub list response was not an array');
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new Error('GitHub pagination exceeded safety limit');
}

async function github(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await sweepStaleDeepReviews();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
