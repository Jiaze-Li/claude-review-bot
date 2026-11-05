import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_ACTIONS,
  decideNotificationAction,
  extractSourceCommentMarkers,
} from '../scripts/notification-policy.mjs';

test('started stage: start announcements in PR conversation are always suppressed', () => {
  for (const mode of ['incremental', 'verification', 'claude', 'threads', 'recover', 'noop_ready', 'noop_waiting']) {
    const decision = decideNotificationAction({
      stage: 'started',
      mode,
      requestedMode: 'auto',
      hasSessionComment: true,
      sourceCommentId: '12345',
    });
    assert.equal(decision.action, NOTIFICATION_ACTIONS.SILENT);
    assert.match(decision.reason, /suppressed/);
  }
});

test('threads mode: successful or no-op thread sync is silent or silently records session marker', () => {
  // With existing session and source comment ID -> silent session marker recording
  const withSession = decideNotificationAction({
    stage: 'finished',
    mode: 'threads',
    requestedMode: 'threads',
    outcomes: { threads: 'success' },
    hasSessionComment: true,
    sourceCommentId: '99',
  });
  assert.equal(withSession.action, NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER);

  // Without source comment ID -> completely silent
  const withoutSource = decideNotificationAction({
    stage: 'finished',
    mode: 'threads',
    requestedMode: 'threads',
    outcomes: { threads: 'success' },
    hasSessionComment: true,
    sourceCommentId: null,
  });
  assert.equal(withoutSource.action, NOTIFICATION_ACTIONS.SILENT);
});

test('threads mode: failure publishes error notification', () => {
  const failed = decideNotificationAction({
    stage: 'finished',
    mode: 'threads',
    requestedMode: 'threads',
    outcomes: { threads: 'failure' },
    hasSessionComment: true,
    sourceCommentId: '99',
  });
  assert.equal(failed.action, NOTIFICATION_ACTIONS.POST_ERROR);
});

test('noop_ready: silently records marker in session comment; never posts spam comment', () => {
  const ready = decideNotificationAction({
    stage: 'finished',
    mode: 'noop_ready',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: '101',
  });
  assert.equal(ready.action, NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER);

  const readyNoSource = decideNotificationAction({
    stage: 'finished',
    mode: 'noop_ready',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: null,
  });
  assert.equal(readyNoSource.action, NOTIFICATION_ACTIONS.SILENT);
});

test('noop_waiting: silently records marker in session comment; never posts spam comment', () => {
  const waiting = decideNotificationAction({
    stage: 'finished',
    mode: 'noop_waiting',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: '202',
  });
  assert.equal(waiting.action, NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER);
});

test('noop_waiting on manual override/dismiss without prior session produces informative human prompt', () => {
  const overrideNoSession = decideNotificationAction({
    stage: 'finished',
    mode: 'noop_waiting',
    requestedMode: 'override',
    hasSessionComment: false,
    sourceCommentId: '303',
  });
  assert.equal(overrideNoSession.action, NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT);

  const dismissNoSession = decideNotificationAction({
    stage: 'finished',
    mode: 'noop_waiting',
    requestedMode: 'dismiss',
    hasSessionComment: false,
    sourceCommentId: '304',
  });
  assert.equal(dismissNoSession.action, NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT);
});

test('successful review publication is silent because PR review and session comment speak for themselves', () => {
  for (const mode of ['incremental', 'verification', 'claude', 'recover', 'override', 'dismiss']) {
    const success = decideNotificationAction({
      stage: 'finished',
      mode,
      requestedMode: 'auto',
      outcomes: {
        geminiPublish: 'success',
        claudePublish: 'success',
        override: 'success',
        dismiss: 'success',
        recover: 'success',
        failDeep: 'success',
      },
      hasSessionComment: true,
      sourceCommentId: '404',
    });
    assert.equal(success.action, NOTIFICATION_ACTIONS.SILENT);
  }
});

test('failed review publication publishes error notification', () => {
  const geminiFailed = decideNotificationAction({
    stage: 'finished',
    mode: 'incremental',
    outcomes: { geminiPublish: 'failure' },
    hasSessionComment: true,
  });
  assert.equal(geminiFailed.action, NOTIFICATION_ACTIONS.POST_ERROR);

  const claudeFailed = decideNotificationAction({
    stage: 'finished',
    mode: 'claude',
    outcomes: { claudePublish: 'failure' },
    hasSessionComment: true,
  });
  assert.equal(claudeFailed.action, NOTIFICATION_ACTIONS.POST_ERROR);

  const failureReasonRecorded = decideNotificationAction({
    stage: 'finished',
    mode: 'incremental',
    outcomes: { geminiPublish: 'skipped' },
    hasFailureReason: true,
    hasSessionComment: true,
  });
  assert.equal(failureReasonRecorded.action, NOTIFICATION_ACTIONS.POST_ERROR);
});

test('human_required mode at finished stage produces human prompt', () => {
  const hr = decideNotificationAction({
    stage: 'finished',
    mode: 'human_required',
    requestedMode: 'auto',
    hasSessionComment: true,
    sourceCommentId: '505',
  });
  assert.equal(hr.action, NOTIFICATION_ACTIONS.POST_HUMAN_PROMPT);
  assert.match(hr.reason, /Human judgment required/);
});

test('extractSourceCommentMarkers extracts both new and old marker formats without duplicates', () => {
  const body = [
    '<!-- jiaze-review-session:v1 -->',
    '<!-- jiaze-review-source-comment:1001 -->',
    '<!-- claude-review-source-comment:1002 -->',
    '<!-- jiaze-review-source-comment:1001 -->',
    '### Independent Review Session',
  ].join('\n');

  const markers = extractSourceCommentMarkers(body);
  assert.deepEqual(markers, ['1001', '1002']);
  assert.deepEqual(extractSourceCommentMarkers(''), []);
  assert.deepEqual(extractSourceCommentMarkers(null), []);
});

test("recover mode notification policy: success is silent, failure/skipped is POST_ERROR", () => {
  const success = decideNotificationAction({
    stage: "finished",
    mode: "recover",
    outcomes: { recover: "success" },
    hasSessionComment: true,
  });
  assert.equal(success.action, NOTIFICATION_ACTIONS.SILENT);

  for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
    const failed = decideNotificationAction({
      stage: "finished",
      mode: "recover",
      outcomes: { recover: outcome },
      hasSessionComment: true,
    });
    assert.equal(failed.action, NOTIFICATION_ACTIONS.POST_ERROR);
    assert.match(failed.reason, /execution failure/);
  }
});

test("deep_review_stale mode notification policy: success records marker or silent, failure is POST_ERROR", () => {
  const withMarker = decideNotificationAction({
    stage: "finished",
    mode: "deep_review_stale",
    outcomes: { failDeep: "success" },
    hasSessionComment: true,
    sourceCommentId: "909",
  });
  assert.equal(withMarker.action, NOTIFICATION_ACTIONS.RECORD_SESSION_MARKER);

  for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
    const failed = decideNotificationAction({
      stage: "finished",
      mode: "deep_review_stale",
      outcomes: { failDeep: outcome },
      hasSessionComment: true,
    });
    assert.equal(failed.action, NOTIFICATION_ACTIONS.POST_ERROR);
    assert.match(failed.reason, /execution failure/);
  }
});
