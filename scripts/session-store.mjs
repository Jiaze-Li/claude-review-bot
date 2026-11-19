// The one place the review session is read from, and written to, the PR itself (see review-ledger.mjs).
// Reading rebuilds the session from the bot's own readable comments; writing appends new comments. Old-format
// comments are ignored (a PR with only those is read as new).
import { fetchLedgerSources } from './review-ledger-fetch.mjs';
import {
  LEDGER_CODES, buildLedger, parsePendingHandoff, renderHandoffParts, renderEventRecord, renderReceipt, renderRunStart, renderVerdictRecord, repairAttempts,
} from './review-ledger.mjs';

export class LedgerStopped extends Error {
  constructor(ledger) {
    super(`Review stopped safely: ${ledger.message}`);
    this.name = 'LedgerStopped';
    this.code = ledger.code;
    this.ledger = ledger;
  }
}

const API = 'https://api.github.com';

// A verdict belongs next to the code it is about: a reply in the finding's own review thread. A finding without a
// thread (no inline anchor) gets an ordinary conversation comment instead, and so does a reply GitHub refuses.
async function postVerdict({ target, prNumber, token, fetchImpl, body, threadCommentId }) {
  if (threadCommentId) {
    try {
      const response = await fetchImpl(`${API}/repos/${target}/pulls/${prNumber}/comments/${threadCommentId}/replies`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) { const created = await response.json(); if (created?.id) return String(created.id); }
    } catch { /* fall through to a conversation comment */ }
  }
  return postComment({ target, prNumber, token, fetchImpl, body });
}

async function postComment({ target, prNumber, token, fetchImpl, body }) {
  const response = await fetchImpl(`${API}/repos/${target}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  const created = await response.json();
  if (!created?.id) throw new Error('GitHub did not return the id of the posted record');
  return String(created.id);
}

export async function readLedger({ target, prNumber, token, fetchImpl = fetch, botLogin, headSha = null, closingStage = false }) {
  const [owner, repo] = String(target).split('/');
  if (!owner || !repo) throw new Error('Invalid target repository');
  const { records, reads } = await fetchLedgerSources({ owner, repo, number: Number(prNumber), token, fetchImpl });
  return { ledger: buildLedger({ records, botLogin, reads, headSha, closingStage }), records };
}

// -> a ledger result. Old-format comments are ignored: a PR with only those reads as `new`.
export async function loadLedger(options) {
  return readLedger(options);
}

// Same as loadLedger, for callers that cannot continue without a trustworthy read.
export async function loadSession(options) {
  const { ledger, records } = await loadLedger(options);
  if (ledger.state === 'stopped') throw new LedgerStopped(ledger);
  return { ledger, records, session: ledger.session ?? null, projection: ledger.projection ?? null };
}

// The options every writer passes to saveSessionComment so the record lands on the PR.
export function ledgerOptions(env, extra = {}) {
  return { botLogin: env.EXPECTED_REVIEW_AUTHOR, ...extra };
}

// Records that a command comment was handled (the visible, idempotent "Receipt"), without changing the session.
// -> the receipt's comment id, the existing one's marker 'existing', or null when the ledger cannot be trusted.
export async function recordReceipt({ target, prNumber, token, fetchImpl = fetch, botLogin, commentId, version = 'created', result }) {
  const { ledger } = await loadLedger({ target, prNumber, token, fetchImpl, botLogin, closingStage: true });
  if (ledger.state === 'stopped') return null;
  if (ledger.receipts?.has(`${commentId}@${version}`)) return 'existing';
  return postComment({ target, prNumber, token, fetchImpl, body: renderReceipt({ commentId, version, result }) });
}

export function deriveStage(session) {
  if (session.auditCompleted === true) return session.fullAuditHead === session.lastReviewedHead ? 'audit' : 'closing';
  const checked = (session.findings ?? []).some((f) => f.lastCheckedHead && f.lastCheckedHead !== f.introducedHead);
  return checked || (session.verificationRound ?? 0) > 0 ? 'verification' : 'first';
}

// Appends, in order: Receipts for the commands this run handled, then either a Run Start (a review is running) or
// the closing Handoff (always last: until it exists, the stage is not closed).
// -> { ids: [...], handoffCommentId, seq, projectionId }
export async function writeSessionRecords({
  target, prNumber, token, fetchImpl = fetch, botLogin, session, stage = null, sourceCommentIds = [], commentVersion = 'created',
  spendThisRun = 0, next = '', readyReason = '', recordIds = {}, expectedSeq = null, runId = null, intro = [], verdicts = [],
}) {
  if (!botLogin) throw new Error('Missing EXPECTED_REVIEW_AUTHOR: cannot read or write the review ledger');
  const { ledger } = await loadLedger({ target, prNumber, token, fetchImpl, botLogin, closingStage: true });
  if (ledger.state === 'stopped') throw new LedgerStopped(ledger);
  const currentSeq = ledger.handoff?.seq ?? 0;
  if (expectedSeq != null && Number(expectedSeq) !== currentSeq) {
    throw new Error(`The review ledger moved while this run was working (planned at handoff Seq ${expectedSeq}, now Seq ${currentSeq}); not writing, plan again`);
  }
  const ids = [];
  for (const sourceId of [...new Set(sourceCommentIds.map(String).filter((id) => /^[1-9]\d*$/.test(id)))]) {
    if (ledger.receipts?.has(`${sourceId}@${commentVersion}`)) continue;
    ids.push(await postComment({ target, prNumber, token, fetchImpl, body: renderReceipt({ commentId: sourceId, version: commentVersion, result: `${session.status} for ${String(session.lastReviewedHead).slice(0, 12)}` }) }));
  }
  // Verdict records: one per (finding, HEAD, kind); a verdict already on the PR is never written twice.
  const known = new Set((ledger.verdicts ?? []).map((v) => `${v.findingId}@${v.head}/${v.kind}`));
  const written = [];
  const eventKeys = new Set((ledger.events ?? []).map((e) => e.key));
  for (const entry of verdicts) {
    const key = `${entry.finding.id}@${String(entry.head).toLowerCase()}/${entry.kind}`;
    if (known.has(key)) continue;
    known.add(key);
    const heads = new Set([...(ledger.verdicts ?? []), ...written].filter((v) => v.findingId === entry.finding.id && v.kind === 'repair').map((v) => v.head));
    const attempt = entry.kind === 'repair' ? (entry.attempt ?? heads.size + 1) : null;
    const home = (ledger.findingRecords ?? []).find((r) => r.id === entry.finding.id && r.source === 'thread');
    ids.push(await postVerdict({ target, prNumber, token, fetchImpl, body: renderVerdictRecord({ ...entry, attempt }), threadCommentId: home?.recordId }));
    written.push({ findingId: entry.finding.id, head: String(entry.head).toLowerCase(), kind: entry.kind });
    // The third independent repair attempt of one finding raises exactly one REPEATED_REWORK event (a signal only).
    // A dismissal is not a repair attempt; later attempts add nothing because the event key already exists.
    const eventKey = `${entry.finding.id}#repeated-rework`;
    if (entry.kind === 'repair' && attempt === 3 && !eventKeys.has(eventKey)) {
      eventKeys.add(eventKey);
      ids.push(await postComment({ target, prNumber, token, fetchImpl, body: renderEventRecord({ findingId: entry.finding.id, attempt }) }));
    }
  }
  if (session.status === 'REVIEW_IN_PROGRESS') {
    const id = await postComment({
      target, prNumber, token, fetchImpl,
      body: renderRunStart({ runId: runId ?? session.deepReview?.runId ?? `run-${Date.now()}`, reservedUsd: session.deepReview?.reservedUsd ?? 0, stage: stage ?? deriveStage(session), head: session.lastReviewedHead, session }),
    });
    return { ids: [...ids, id], handoffCommentId: null, seq: currentSeq, projectionId: ledger.projection?.id ?? null };
  }
  // GitHub comments have no compare-and-swap, so this can only narrow the race (the per-PR workflow queue is what
  // serialises runs; a reader sets aside a doubled Seq deterministically). Look once more right before closing.
  const { ledger: latest } = await loadLedger({ target, prNumber, token, fetchImpl, botLogin, closingStage: true });
  if (latest.state === 'stopped') throw new LedgerStopped(latest);
  if ((latest.handoff?.seq ?? 0) !== currentSeq) {
    throw new Error(`The review ledger moved while this run was writing (handoff Seq ${currentSeq} -> ${latest.handoff?.seq ?? 0}); not closing the stage, plan again`);
  }
  const seq = currentSeq + 1;
  const attempts = repairAttempts(session.findings ?? [], [...(ledger.verdicts ?? []), ...written]);
  const bodies = renderHandoffParts({
    session, stage: stage ?? deriveStage(session), seq, prev: ledger.handoff?.commentId ?? null,
    attempts, recordIds, spendThisRun, next: next || nextStepFor(session), readyReason: readyReason || readyReasonFor(session), intro,
  });
  let handoffCommentId = null;
  for (const body of bodies) {
    handoffCommentId = await postComment({ target, prNumber, token, fetchImpl, body });
    ids.push(handoffCommentId);
  }
  return { ids, handoffCommentId, seq, projectionId: ledger.projection?.id ?? null };
}

function nextStepFor(session) {
  switch (session.status) {
    case 'READY': return 'Maintainer: confirm CI and merge requirements, then decide whether to merge.';
    case 'REWORK': return 'Author: fix the open findings and push; the bot verifies the repair.';
    case 'AUDIT_PENDING': return 'Bot: the final full review runs next (or comment @gemini review to start it).';
    case 'PARTIAL': return 'Maintainer: comment @claude review to cover the files that were not reviewed.';
    case 'REVIEW_IN_PROGRESS': return 'Bot: the review is running.';
    default: return 'Maintainer: human judgment is required before this PR can continue.';
  }
}

function readyReasonFor(session) {
  if (session.status === 'READY') return 'final audit complete, no blocking finding open';
  return `session status is ${session.status}`;
}

// A review body that carries the session it was about to save (see renderPendingHandoff), read back from the
// PR's reviews. -> { reviewId, sourceCommentId, session } | null  (newest first)
export function pendingFromRecords(records, botLogin) {
  const bot = String(botLogin ?? '').replace(/\[bot\]$/i, '').toLowerCase();
  return records
    .filter((r) => r.source === 'review' && String(r.login ?? '').replace(/\[bot\]$/i, '').toLowerCase() === bot && String(r.type).toLowerCase() === 'bot')
    .map((r) => ({ reviewId: r.id, pending: parsePendingHandoff(r.body), createdAt: r.createdAt }))
    .filter((r) => r.pending)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : Number(b.reviewId) - Number(a.reviewId)))
    .map((r) => ({ reviewId: r.reviewId, sourceCommentId: r.pending.sourceCommentId, session: r.pending.session }))[0] ?? null;
}

export { LEDGER_CODES };
