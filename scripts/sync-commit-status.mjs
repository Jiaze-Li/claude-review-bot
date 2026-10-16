import { pathToFileURL } from 'node:url';
import { parseSessionComment, sessionCommitStatus } from './review-session-core.mjs';

// Mirrors the durable review session onto the exact HEAD as a GitHub commit
// status, so a Required Status Check agrees with what the PR comment says.
// Statuses are per-SHA: a new commit has no status, so an old READY can never
// be reused. Uses a separate best-effort token so a missing App permission
// never breaks the review itself.
export const STATUS_CONTEXT = 'claude-review-bot/review';

export async function syncCommitStatus({ env = process.env, fetchImpl = fetch } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  const headSha = required(env, 'HEAD_SHA');
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('Invalid HEAD_SHA');
  if (!env.STATUS_TOKEN) return postCommitStatus({ env, fetchImpl, target, headSha, status: null }); // warns, or throws in strict mode
  const session = await latestSession({ target, prNumber, author: required(env, 'EXPECTED_REVIEW_AUTHOR'), token: required(env, 'GH_TOKEN'), fetchImpl });
  let status = sessionCommitStatus(session, headSha);
  if (env.JOB_FAILED === 'true' && status.state === 'pending' && (!session || session.lastReviewedHead !== headSha)) {
    status = { state: 'error', description: 'Review run failed for this commit; comment @gemini review to retry' };
  }
  // A deep review that was attempted but whose job failed must never leave an old green or a
  // forever-pending status, even if persisting the failure to the session comment itself failed.
  if (env.DEEP_REVIEW_ATTEMPTED === 'true' && env.JOB_FAILED === 'true'
    && !(session && session.lastReviewedHead === headSha && ['REWORK', 'HUMAN_REQUIRED'].includes(session.status))) {
    status = { state: 'error', description: 'Claude deep review did not complete: human judgment required' };
  }
  return postCommitStatus({ env, fetchImpl, target, headSha, status });
}

// Shared by begin (explicit pending BEFORE any durable write) and the final mirror.
export async function postCommitStatus({ env = process.env, fetchImpl = fetch, target = env.TARGET_REPO, headSha = env.HEAD_SHA, status }) {
  const strict = env.STATUS_STRICT === 'true';
  if (!env.STATUS_TOKEN) {
    if (strict) throw new Error('Commit status required (REQUIRE_STATUS_CHECK=true) but the GitHub App has no commit-status permission');
    console.warn('::warning::No status token (GitHub App lacks commit-status permission?); required check was NOT updated.');
    return null;
  }
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${target}/statuses/${headSha}`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.STATUS_TOKEN}`, 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot',
      },
      body: JSON.stringify({ state: status.state, context: STATUS_CONTEXT, description: status.description.slice(0, 140), ...(runUrl ? { target_url: runUrl } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      console.log(`Commit status ${status.state} posted for ${headSha.slice(0, 12)}: ${status.description}`);
      return status;
    }
    lastStatus = response.status;
    if (response.status < 500 && response.status !== 429) break; // permission/validation errors do not heal on retry
  }
  if (strict) throw new Error(`Commit status required but not posted (HTTP ${lastStatus})`);
  console.warn(`::warning::Commit status not posted (HTTP ${lastStatus}); required check was NOT updated.`);
  return null;
}

async function latestSession({ target, prNumber, author, token, fetchImpl }) {
  let latest = null;
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${target}/issues/${prNumber}/comments?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub session lookup failed (HTTP ${response.status})`);
    const batch = await response.json();
    for (const comment of batch) {
      if (comment?.user?.login === author && typeof comment.body === 'string' && comment.body.includes('<!-- jiaze-review-session:v1 -->')) {
        if (!latest || Number(comment.id) > Number(latest.id)) latest = comment;
      }
    }
    if (batch.length < 100) break;
  }
  return latest ? parseSessionComment(latest.body) : null;
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncCommitStatus();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
