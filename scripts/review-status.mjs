import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positiveId = /^[1-9]\d*$/;

function checked(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

// Only the actual workflow calls this, after dedupe and exact-HEAD preflight.
// No reaction is ever posted by the webhook or by this helper. A run URL and
// bot-authored status are unambiguous even when another App adds its own eyes.
export async function publishRunStatus({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.GITHUB_ACTIONS !== 'true') throw new Error('Status requires a real GitHub Actions run');
  if (env.DUPLICATE === 'true') return null;
  const stage = env.STATUS_STAGE;
  if (stage !== 'started' && stage !== 'finished') throw new Error('Invalid status stage');
  if (stage === 'started' && env.PREFLIGHT_OUTCOME !== 'success') {
    throw new Error('Cannot announce a review before exact-HEAD preflight succeeds');
  }
  const repo = checked(env.TARGET_REPO, repoPattern, 'TARGET_REPO');
  const controlRepo = checked(env.GITHUB_REPOSITORY, repoPattern, 'GITHUB_REPOSITORY');
  const pr = checked(env.PR_NUMBER, positiveId, 'PR_NUMBER');
  const sourceId = checked(env.SOURCE_COMMENT_ID, positiveId, 'SOURCE_COMMENT_ID');
  const runId = checked(env.GITHUB_RUN_ID, positiveId, 'GITHUB_RUN_ID');
  const attempt = checked(env.GITHUB_RUN_ATTEMPT, positiveId, 'GITHUB_RUN_ATTEMPT');
  const head = checked(env.HEAD_SHA, /^[0-9a-f]{40}$/i, 'HEAD_SHA');
  if (!env.GH_TOKEN) throw new Error('Missing GH_TOKEN');
  const commentId = stage === 'finished'
    ? checked(env.STATUS_COMMENT_ID, positiveId, 'STATUS_COMMENT_ID')
    : null;
  const state = stage === 'started'
    ? 'Workflow started; preflight passed. Claude review is next.'
    : env.PUBLISH_OUTCOME === 'success'
      ? 'Review publication step completed. Read the PR review for findings; this is not an approval.'
      : 'Review publication was not confirmed. The workflow failed, was cancelled, or skipped publication; check the run and PR for details.';
  const body = [
    `<!-- claude-review-run:${runId}:${attempt} -->`,
    '### Self-hosted Claude review',
    state,
    '',
    `[Workflow run](https://github.com/${controlRepo}/actions/runs/${runId}/attempts/${attempt})`
      + ` · [Source comment](https://github.com/${repo}/pull/${pr}#issuecomment-${sourceId})`,
    `Target HEAD: \`${head}\``,
    '',
    'This status is from the central review workflow. Reactions from other Apps are not its execution status.',
  ].join('\n');
  const endpoint = commentId ? `issues/comments/${commentId}` : `issues/${pr}/comments`;
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/${endpoint}`, {
    method: commentId ? 'PATCH' : 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-review-bot',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15_000),
  });
  // Never echo raw responses or tokens into the Actions log.
  if (!response.ok) throw new Error(`Review status publication failed (HTTP ${response.status})`);
  const result = await response.json();
  const id = String(result.id ?? '');
  checked(id, positiveId, 'status response comment id');
  if (commentId && id !== commentId) throw new Error('Status response comment id mismatch');
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const id = await publishRunStatus();
    if (id && process.env.STATUS_STAGE === 'started' && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `comment_id=${id}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
