/**
 * Unified notification decision rules for claude-review-bot.
 * Determines when PR conversation comments should be published, when idempotency markers
 * should be silently attached to the durable session, and when runs must remain completely silent.
 */

export const NOTIFICATION_ACTIONS = Object.freeze({
  SILENT: 'silent',                         // Post nothing to PR conversation
  POST_ERROR: 'post_error',                 // Post an exception / failure notification
  RECORD_SESSION_MARKER: 'session_marker',  // Silently record source comment marker into durable session comment
  POST_HUMAN_PROMPT: 'human_prompt',        // Post a required human operational prompt (e.g. command on PR with no session)
});

/**
 * Evaluates whether a workflow stage should announce a start or finish status,
 * update the session comment idempotency markers silently, or remain completely silent.
 */
export function decideNotificationAction({
  stage,
  mode,
  requestedMode = 'auto',
  outcomes = {},
  hasSessionComment = false,
  sourceCommentId = null,
  hasFailureReason = false,
} = {}) {
  // 1. Started stage: all ephemeral start announcements in PR conversation are suppressed.
  // Progress is tracked via GitHub commit status checks and session REVIEW_IN_PROGRESS state.
  if (stage === 'started') {
    return {
      action: NOTIFICATION_ACTIONS.SILENT,
      reason: 'Ephemeral start announcements in PR conversation are suppressed',
    };
  }

  if (stage !== 'finished') {
    return {
      action: NOTIFICATION_ACTIONS.SILENT,
      reason: `Unknown status stage: ${stage}`,
    };
  }

  // 2. Finished stage: check for real execution/publication failures first.
  const isFailure = hasFailureReason
    || (mode === 'claude' && outcomes.claudePublish !== 'success')
    || (['incremental', 'verification'].includes(mode) && outcomes.geminiPublish !== 'success')
    || (mode === 'override' && outcomes.override !== 'success')
    || (mode === 'dismiss' && outcomes.dismiss !== 'success')
    || (mode === 'threads' && outcomes.threads !== 'success')
    || (mode === 'recover' && outcomes.recover !== 'success')
    || (mode === 'deep_review_stale' && outcomes.failDeep !== 'success');

  if (isFailure) {
    return {
      action: NOTIFICATION_ACTIONS.POST_ERROR,
      reason: 'Report unconfirmed publication or execution failure to PR conversation',
    };
  }

  // 3. Human required mode: requires human intervention or explains exhausted budget.
  if (mode === 'human_required') {
    return {
      action: NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT,
      reason: 'Human judgment required: prompt explains why review stopped and required next action',
    };
  }

  // 4. No-op modes: noop_ready, noop_waiting, deep_review_stale
  // (Note: recover is handled separately as a successful session recovery)
  if (['noop_ready', 'noop_waiting', 'deep_review_stale'].includes(mode)) {
    // If a durable session comment exists and we have a sourceCommentId to dedupe:
    // silently record the marker into the session comment without conversational noise.
    if (hasSessionComment && sourceCommentId) {
      return {
        action: NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER,
        reason: `Silently record source comment marker for ${mode} in durable session comment`,
      };
    }

    // Edge case: an explicit human command (override/dismiss) before any session exists.
    // An informative prompt is necessary so the user knows why nothing was changed.
    if (!hasSessionComment && sourceCommentId && ['override', 'dismiss'].includes(requestedMode)) {
      return {
        action: NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT,
        reason: 'Informative human prompt explaining why manual command could not be applied',
      };
    }

    // Default for noop: completely silent.
    return {
      action: NOTIFICATION_ACTIONS.SILENT,
      reason: `No-op mode ${mode} produces no conversational notification`,
    };
  }

  // 4. Threads mode: thread sync must remain completely silent in PR conversation.
  // Material finding changes are reflected in the durable session comment.
  // Sync problems (PR #57) are reflected in Actions warnings and Job Summary.
  if (mode === 'threads') {
    if (hasSessionComment && sourceCommentId) {
      return {
        action: NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER,
        reason: 'Thread sync maintains idempotency marker silently in session comment',
      };
    }
    return {
      action: NOTIFICATION_ACTIONS.SILENT,
      reason: 'Thread sync produces no conversational status comments',
    };
  }

  // 5. Normal successful reviews (incremental, verification, claude) and mutations (override, dismiss):
  // The PR Review (with inline comments) and the updated durable session comment already speak for themselves.
  // Suppress redundant status echo comments.
  return {
    action: NOTIFICATION_ACTIONS.SILENT,
    reason: `Review outcome for ${mode} is already conveyed via PR review and durable session comment`,
  };
}

/**
 * Extracts all source comment IDs from an existing comment body.
 */
export function extractSourceCommentMarkers(body) {
  if (typeof body !== 'string' || !body) return [];
  const matches = body.matchAll(/<!-- (?:jiaze|claude)-review-source-comment:([1-9]\d*) -->/g);
  const ids = Array.from(matches, (m) => m[1]);
  return [...new Set(ids)];
}
