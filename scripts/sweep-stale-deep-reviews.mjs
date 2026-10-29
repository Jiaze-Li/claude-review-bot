import { saveSessionComment } from './session-comment.mjs';
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
export const MAX_CANDIDATES = 50;

// Phase 1 (no writes): list PRs whose latest session looks like a dead deep review.
export async function findStaleDeepReviews({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const author = env.EXPECTED_REVIEW_AUTHOR;
  if (!author) throw new Error('Missing required environment variable: EXPECTED_REVIEW_AUTHOR');
  // Repositories come from the App installation itself: no list to maintain.
  const installed = await installationRepos(env.GH_TOKEN, fetchImpl);
  const repos = installed.filter((r) => r && !r.archived && !r.disabled && typeof r.full_name === 'string').slice(0, MAX_REPOS);
  const candidates = [];
  for (const { full_name: repo } of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
    const prs = (await github(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${MAX_PRS_PER_REPO}`, env.GH_TOKEN, fetchImpl)).slice(0, MAX_PRS_PER_REPO);
    for (const pr of prs) {
      const latest = await latestSessionComment(repo, pr.number, author, env.GH_TOKEN, fetchImpl);
      const session = latest ? parseSessionComment(latest.body) : null;
      if (session && isDeepReviewStale(session, now) && session.lastReviewedHead === pr.head?.sha) {
        candidates.push({ repo, pr: pr.number });
        if (candidates.length >= MAX_CANDIDATES) return candidates;
      }
    }
  }
  console.log(candidates.length ? `Stale deep review candidates: ${candidates.map((c) => `${c.repo}#${c.pr}`).join(', ')}` : `No stale deep reviews (${repos.length} installed repositories checked).`);
  return candidates;
}

// Phase 2 (writes): MUST run inside the same per-PR concurrency group as the main review
// workflow (see the workflow), so no review can start or finish between the read and the
// PATCH below. State is re-read here, inside that lock.
export async function closeStaleDeepReview({ repo, prNumber, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const author = env.EXPECTED_REVIEW_AUTHOR;
  if (!author) throw new Error('Missing required environment variable: EXPECTED_REVIEW_AUTHOR');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo))) throw new Error('Invalid repository');
  if (!/^[1-9]\d*$/.test(String(prNumber))) throw new Error('Invalid PR number');
  const pr = await github(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, env.GH_TOKEN, fetchImpl);
  const latest = await latestSessionComment(repo, prNumber, author, env.GH_TOKEN, fetchImpl);
  const session = latest ? parseSessionComment(latest.body) : null;
  if (!session || !isDeepReviewStale(session, now) || session.lastReviewedHead !== pr.head?.sha) {
    console.log(`${repo}#${prNumber}: no longer a stale deep review; leaving it alone.`);
    return false;
  }
  const closed = failDeepReview({
    session, headSha: session.lastReviewedHead, reason: 'deep review never reported back (swept after timeout)',
    spentUsd: session.deepReview?.reservedUsd ?? DEEP_REVIEW_RUN_BUDGET_USD, now: new Date(now).toISOString(),
  });
  await saveSessionComment({
    target: repo, prNumber, token: env.GH_TOKEN, fetchImpl, existingId: String(latest.id), previous: session, session: closed,
    body: renderSessionComment(closed),
  });
  await postCommitStatus({
    env, fetchImpl, target: repo, headSha: session.lastReviewedHead,
    status: { state: 'error', description: 'Claude deep review timed out: human judgment required' },
  });
  console.log(`${repo}#${prNumber}: stale deep review closed to HUMAN_REQUIRED.`);
  return true;
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
    if (process.argv[2] === 'find') {
      const candidates = await findStaleDeepReviews();
      if (process.env.GITHUB_OUTPUT) {
        const fs = await import('node:fs');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: candidates })}\ncount=${candidates.length}\n`);
      }
    } else if (process.argv[2] === 'close') {
      await closeStaleDeepReview({ repo: process.env.SWEEP_REPO, prNumber: process.env.SWEEP_PR });
    } else {
      throw new Error('usage: sweep-stale-deep-reviews.mjs find|close');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
