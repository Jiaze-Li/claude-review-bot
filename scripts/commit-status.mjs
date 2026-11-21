import { STATUS_CONTEXT } from './review-contract.mjs';

// Projects the review state onto the commit-status context branch protection reads. With STATUS_STRICT=true a status
// that cannot be posted is an error instead of a warning.
export async function postCommitStatus({ env = process.env, fetchImpl = fetch, target = env.TARGET_REPO, headSha, status }) {
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
    if (response.ok) return status;
    lastStatus = response.status;
    if (response.status < 500 && response.status !== 429) break; // permission/validation errors do not heal on retry
  }
  if (strict) throw new Error(`Commit status required but not posted (HTTP ${lastStatus})`);
  console.warn(`::warning::Commit status not posted (HTTP ${lastStatus}); required check was NOT updated.`);
  return null;
}
