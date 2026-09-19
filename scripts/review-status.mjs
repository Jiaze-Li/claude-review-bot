import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positiveId = /^[1-9]\d*$/;
const reviewModes = new Set(['discovery', 'verification', 'claude', 'noop_ready', 'noop_waiting', 'human_required']);

function checked(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Missing or invalid ' + name);
  return value;
}

function safeReason(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, '').slice(0, 500);
}

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
  const mode = String(env.REVIEW_MODE || '');
  if (!reviewModes.has(mode)) throw new Error('Invalid REVIEW_MODE');
  if (!env.GH_TOKEN) throw new Error('Missing GH_TOKEN');
  const commentId = stage === 'finished'
    ? checked(env.STATUS_COMMENT_ID, positiveId, 'STATUS_COMMENT_ID')
    : null;

  const reason = safeReason(env.REVIEW_REASON);
  let state;
  if (stage === 'started') {
    if (mode === 'discovery') state = 'Exact-HEAD preflight passed. Gemini discovery review is running.';
    else if (mode === 'verification') state = 'Exact-HEAD preflight passed. Gemini targeted verification is running.';
    else if (mode === 'claude') state = 'Exact-HEAD preflight passed. Explicit Claude deep review is running.';
    else state = 'No model call is required for this trigger. ' + reason;
  } else if (['noop_ready', 'noop_waiting', 'human_required'].includes(mode)) {
    state = 'No model quota was spent. ' + reason;
  } else {
    const outcome = mode === 'claude' ? env.CLAUDE_PUBLISH_OUTCOME : env.GEMINI_PUBLISH_OUTCOME;
    state = outcome === 'success'
      ? 'Review publication completed. Read the PR review and durable review-session comment for the result.'
      : 'Review publication was not confirmed. Check the workflow run; no successful publication is being claimed.';
  }

  const body = [
    '<!-- jiaze-review-run:' + runId + ':' + attempt + ' -->',
    '### Independent review',
    state,
    '',
    '[Workflow run](https://github.com/' + controlRepo + '/actions/runs/' + runId + '/attempts/' + attempt + ')'
      + ' · [Source comment](https://github.com/' + repo + '/pull/' + pr + '#issuecomment-' + sourceId + ')',
    'Target HEAD: ' + head,
    'Mode: ' + mode,
    '',
    'The durable PR session decides discovery vs verification automatically; users do not need to track review rounds.',
  ].join('\n');

  const endpoint = commentId ? 'issues/comments/' + commentId : 'issues/' + pr + '/comments';
  const response = await fetchImpl('https://api.github.com/repos/' + repo + '/' + endpoint, {
    method: commentId ? 'PATCH' : 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Review status publication failed (HTTP ' + response.status + ')');
  const result = await response.json();
  const id = String(result.id || '');
  checked(id, positiveId, 'status response comment id');
  if (commentId && id !== commentId) throw new Error('Status response comment id mismatch');
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const id = await publishRunStatus();
    if (id && process.env.STATUS_STAGE === 'started' && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'comment_id=' + id + '\n');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
