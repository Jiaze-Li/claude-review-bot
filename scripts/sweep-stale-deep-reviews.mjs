import { pathToFileURL } from 'node:url';
import {
  DEEP_REVIEW_RUN_BUDGET_USD, failDeepReview, isDeepReviewStale, parseSessionComment, renderSessionComment,
} from './review-session-core.mjs';
import { postCommitStatus } from './sync-commit-status.mjs';

// Scheduled safety net: a deep review whose job died without cleanup would otherwise sit in
// REVIEW_IN_PROGRESS until someone triggers another review. This closes it to HUMAN_REQUIRED
// (and the required status to error) without any model call.
// Hard bounds so a scheduled run can never become an unbounded API crawl.
export const MAX_REPOS = 100;
export const MAX_PRS_PER_REPO = 100;

export async function sweepStaleDeepReviews({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const author = env.EXPECTED_REVIEW_AUTHOR;
  if (!author) throw new Error('Missing required environment variable: EXPECTED_REVIEW_AUTHOR');
  // Repositories come from the App installation itself: no list to maintain.
  const installed = await installationRepos(env.GH_TOKEN, fetchImpl);
  const repos = installed.filter((r) => r && !r.archived && !r.disabled && typeof r.full_name === 'string').slice(0, MAX_REPOS);
  const failed = [];
  for (const { full_name: repo } of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
    const prs = (await github(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${MAX_PRS_PER_REPO}`, env.GH_TOKEN, fetchImpl)).slice(0, MAX_PRS_PER_REPO);
    for (const pr of prs) {
      const latest = await latestSessionComment(repo, pr.number, author, env.GH_TOKEN, fetchImpl);
      const session = latest ? parseSessionComment(latest.body) : null;
      if (!session || !isDeepReviewStale(session, now)) continue;
      // A moved PR is replanned by its next review from the interrupted status; leave it.
      if (session.lastReviewedHead !== pr.head?.sha) continue;
      // Re-verify just before writing: the main workflow is not serialized with this job, so a
      // live review may have replaced the marker or moved the PR since the scan above.
      const fresh = await github(`https://api.github.com/repos/${repo}/issues/comments/${latest.id}`, env.GH_TOKEN, fetchImpl);
      const current = parseSessionComment(fresh.body);
      const livePr = await github(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, env.GH_TOKEN, fetchImpl);
      const newest = await latestSessionComment(repo, pr.number, author, env.GH_TOKEN, fetchImpl);
      if (!current || !isDeepReviewStale(current, now) || current.lastReviewedHead !== livePr.head?.sha || String(newest?.id) !== String(latest.id)) continue;
      const closed = failDeepReview({
        session: current, headSha: current.lastReviewedHead, reason: 'deep review never reported back (swept after timeout)',
        spentUsd: current.deepReview?.reservedUsd ?? DEEP_REVIEW_RUN_BUDGET_USD, now: new Date(now).toISOString(),
      });
      await github(`https://api.github.com/repos/${repo}/issues/comments/${latest.id}`, env.GH_TOKEN, fetchImpl, {
        method: 'PATCH', body: JSON.stringify({ body: renderSessionComment(closed) }),
      });
      await postCommitStatus({
        env, fetchImpl, target: repo, headSha: current.lastReviewedHead,
        status: { state: 'error', description: 'Claude deep review timed out: human judgment required' },
      });
      failed.push(`${repo}#${pr.number}`);
    }
  }
  console.log(failed.length ? `Closed stale deep reviews: ${failed.join(', ')}` : `No stale deep reviews (${repos.length} installed repositories checked).`);
  return failed;
}

async function installationRepos(token, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 5; page += 1) {
    const data = await github(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, token, fetchImpl);
    const batch = Array.isArray(data?.repositories) ? data.repositories : null;
    if (!batch) throw new Error('GitHub installation repositories response was malformed');
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function latestSessionComment(repo, prNumber, author, token, fetchImpl) {
  const comments = await pages(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`, token, fetchImpl);
  return comments
    .filter((c) => c?.user?.login === author && typeof c.body === 'string' && c.body.includes('<!-- jiaze-review-session:v1 -->'))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
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
