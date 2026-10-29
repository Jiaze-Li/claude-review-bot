import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positiveId = /^[1-9]\d*$/;
const reviewModes = new Set(['incremental', 'verification', 'recover', 'claude', 'noop_ready', 'noop_waiting', 'human_required', 'deep_review_stale', 'override', 'dismiss', 'threads']);
const sourceKinds = new Set(['comment', 'pull_request']);

function checked(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Missing or invalid ' + name);
  return value;
}

function safeReason(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, '').slice(0, 500);
}

// Why the run failed, when a script recorded it (e.g. the diff is over Gemini's size limit).
function failureReason(env) {
  try {
    const file = (env.REVIEW_CONTEXT_DIR || '.review-context') + '/failure-reason.txt';
    const text = safeReason(fs.readFileSync(file, 'utf8'));
    return text ? ' Reason: ' + text : '';
  } catch {
    return '';
  }
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
  const sourceKind = String(env.SOURCE_KIND || 'comment');
  if (!sourceKinds.has(sourceKind)) throw new Error('Invalid SOURCE_KIND');
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
    // `@claude review` runs the same review with Claude as the only model.
    const model = env.REQUESTED_MODE === 'claude' ? 'Claude' : 'Gemini';
    if (mode === 'incremental') state = `Exact-HEAD preflight passed. ${model} delta review is running.`;
    else if (mode === 'verification') state = `Exact-HEAD preflight passed. ${model} targeted verification is running.`;
    else if (mode === 'claude') state = 'Exact-HEAD preflight passed. Sharded deep review is running (Gemini first, Claude where Gemini cannot). ' + reason;
    else if (mode === 'override') state = 'Exact-HEAD preflight passed. Applying manual override.';
    else if (mode === 'dismiss') state = 'Exact-HEAD preflight passed. Checking evidence for one finding (no model call).';
    else if (mode === 'threads') state = 'Exact-HEAD preflight passed. Applying review-thread decisions (no model call).';
    else if (mode === 'recover') state = 'A paid review is already published. Recovering durable session state with no model call.';
    else state = 'No model call is required for this trigger. ' + reason;
  } else if (mode === 'threads') {
    state = env.THREADS_OUTCOME === 'success'
      ? 'Review-thread decisions applied. No model quota was spent.'
      : 'Review-thread decisions were not confirmed. Check the workflow run.';
  } else if (mode === 'dismiss') {
    state = env.DISMISS_OUTCOME !== 'success'
      ? 'Finding dismissal was not confirmed; durable session did not acknowledge it.'
      : 'Finding dismissal recorded. No model quota was spent by dismissal.';
  } else if (['recover', 'noop_ready', 'noop_waiting', 'human_required', 'deep_review_stale'].includes(mode)) {
    state = 'No model quota was spent. ' + reason;
  } else {
    const outcome = mode === 'claude'
      ? env.CLAUDE_PUBLISH_OUTCOME
      : mode === 'override' ? env.OVERRIDE_OUTCOME : env.GEMINI_PUBLISH_OUTCOME;
    state = outcome === 'success'
      ? 'Review publication completed. Read the PR review and durable review-session comment for the result.'
      : 'Review publication was not confirmed. Check the workflow run; no successful publication is being claimed.'
        + failureReason(env);
  }

  const completedNoop = stage === 'finished' && ['recover', 'noop_ready', 'noop_waiting', 'human_required', 'deep_review_stale'].includes(mode);
  const isContinuation = /^8[0-9]\d{11}$/.test(sourceId);
  const sourceReference = isContinuation
    ? 'Trigger: automatic continuation of the previous run'
    : sourceKind === 'comment'
    ? '[Source comment](https://github.com/' + repo + '/pull/' + pr + '#issuecomment-' + sourceId + ')'
    : 'Trigger: automatic pull request event';

  const body = [
    '<!-- jiaze-review-run:' + runId + ':' + attempt + ' -->',
    ...(completedNoop ? ['<!-- jiaze-review-source-comment:' + sourceId + ' -->'] : []),
    '### Independent review',
    state,
    '',
    '[Workflow run](https://github.com/' + controlRepo + '/actions/runs/' + runId + '/attempts/' + attempt + ')'
      + ' · ' + sourceReference,
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
