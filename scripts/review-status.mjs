import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NOTIFICATION_ACTIONS,
  decideNotificationAction,
  extractSourceCommentMarkers,
} from './notification-policy.mjs';
import { parseSessionComment, renderSessionComment } from './review-session-core.mjs';
import { saveSessionComment } from './session-comment.mjs';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positiveId = /^[1-9]\d*$/;
const reviewModes = new Set([
  'incremental', 'verification', 'recover', 'claude',
  'noop_ready', 'noop_waiting', 'human_required', 'deep_review_stale',
  'override', 'dismiss', 'threads',
]);
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
    const file = path.join(path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context'), 'failure-reason.txt');
    const text = safeReason(fs.readFileSync(file, 'utf8'));
    return text ? ' Reason: ' + text : '';
  } catch {
    return '';
  }
}

function loadSessionPlan(env) {
  try {
    const file = path.join(path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context'), 'session-plan.json');
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    // Ignore read or parse errors
  }
  return null;
}

export async function recordSessionMarker({
  targetRepo,
  prNumber,
  token,
  sessionCommentId,
  session = null,
  sourceCommentId,
  fetchImpl = fetch,
}) {
  if (!sessionCommentId || !sourceCommentId) return null;
  const root = `https://api.github.com/repos/${targetRepo}`;
  let response;
  try {
    response = await fetchImpl(`${root}/issues/comments/${sessionCommentId}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jiaze-review-bot',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const existingMarkers = extractSourceCommentMarkers(data?.body);
  if (existingMarkers.includes(String(sourceCommentId))) {
    return String(sessionCommentId);
  }
  // Fail closed: if the live session cannot be parsed, refuse to patch to prevent overwriting
  // findings, READY/REWORK status, cost records, or lastReviewedHead with stale data.
  const currentSession = parseSessionComment(data?.body);
  if (!currentSession) return null;
  const sourceCommentIds = [...existingMarkers, String(sourceCommentId)];
  const body = renderSessionComment(currentSession, { sourceCommentIds });
  return await saveSessionComment({
    target: targetRepo,
    prNumber,
    token,
    fetchImpl,
    existingId: sessionCommentId,
    previous: currentSession,
    session: currentSession,
    body,
  });
}

export async function publishRunStatus({ env = process.env, fetchImpl = fetch, plan = null } = {}) {
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

  const commentId = (stage === 'finished' && env.STATUS_COMMENT_ID)
    ? checked(env.STATUS_COMMENT_ID, positiveId, 'STATUS_COMMENT_ID')
    : null;

  const failure = failureReason(env);
  const resolvedPlan = plan || loadSessionPlan(env);
  const hasSessionComment = Boolean(resolvedPlan?.sessionCommentId && resolvedPlan?.session);
  const decision = decideNotificationAction({
    stage,
    mode,
    requestedMode: env.REQUESTED_MODE || 'auto',
    outcomes: {
      geminiPublish: env.GEMINI_PUBLISH_OUTCOME,
      claudePublish: env.CLAUDE_PUBLISH_OUTCOME,
      override: env.OVERRIDE_OUTCOME,
      dismiss: env.DISMISS_OUTCOME,
      threads: env.THREADS_OUTCOME,
    },
    hasSessionComment,
    sourceCommentId: env.SOURCE_COMMENT_ID,
    hasFailureReason: Boolean(failure),
  });

  if (decision.action === NOTIFICATION_ACTIONS.SILENT) {
    return null;
  }

  if (decision.action === NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER) {
    if (resolvedPlan?.sessionCommentId && resolvedPlan?.session) {
      await recordSessionMarker({
        targetRepo: repo,
        prNumber: pr,
        token: env.GH_TOKEN,
        sessionCommentId: resolvedPlan.sessionCommentId,
        session: resolvedPlan.session,
        sourceCommentId: env.SOURCE_COMMENT_ID,
        fetchImpl,
      });
    }
    return null;
  }

  const reason = safeReason(env.REVIEW_REASON);
  let state;
  if (decision.action === NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT) {
    state = 'No model quota was spent. ' + reason;
  } else if (mode === 'threads') {
    state = env.THREADS_OUTCOME === 'success'
      ? `Review-thread decisions applied. No model quota was spent.${Number(env.THREAD_PROBLEMS) > 0 ? ' Some review threads could not be changed (see the run Job Summary); the review result is unaffected.' : ''}`
      : 'Review-thread decisions were not confirmed. Check the workflow run.';
  } else if (mode === 'dismiss') {
    state = env.DISMISS_OUTCOME !== 'success'
      ? 'Finding dismissal was not confirmed; durable session did not acknowledge it.'
      : 'Finding dismissal recorded. No model quota was spent by dismissal.';
  } else if (mode === 'override') {
    state = env.OVERRIDE_OUTCOME !== 'success'
      ? 'Manual override was not confirmed. Check the workflow run.'
      : 'Manual override recorded.';
  } else {
    state = 'Review publication was not confirmed. Check the workflow run; no successful publication is being claimed.'
      + failure;
  }

  const isContinuation = /^8[0-9]\d{11}$/.test(sourceId);
  const sourceReference = isContinuation
    ? 'Trigger: automatic continuation of the previous run'
    : sourceKind === 'comment'
    ? '[Source comment](https://github.com/' + repo + '/pull/' + pr + '#issuecomment-' + sourceId + ')'
    : 'Trigger: automatic pull request event';

  const body = [
    '<!-- jiaze-review-run:' + runId + ':' + attempt + ' -->',
    ...(sourceId ? ['<!-- jiaze-review-source-comment:' + sourceId + ' -->'] : []),
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
