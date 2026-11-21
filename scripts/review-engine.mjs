// Pure review logic for contract schema_version 2: should a model run happen, how the next batch is chosen, and how
// one model result is folded into the single state document. No network, no clock unless passed in.
import { createHash } from 'node:crypto';
import { filePriority } from './review-shards.mjs';
import {
  MAX_ATTEMPTS, MAX_FINDINGS, MAX_ROUNDS, SCHEMA_VERSION, SEVERITIES, STALL_LIMIT, isBlocking,
} from './review-contract.mjs';

// A claimed attempt with no result for this long is a crashed or killed run. Above the workflow's job timeout.
export const IN_PROGRESS_TIMEOUT_MS = 50 * 60 * 1000;
export const BATCH_LIMITS = Object.freeze({ maxFiles: 10, targetBytes: 70_000, maxInlineFileBytes: 40_000 });

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const VERDICT_RANK = { OPEN: 0, FIXED: 1, UNCERTAIN: 2, STILL_OPEN: 3 }; // a blocking verdict always beats FIXED
const iso = (now) => new Date(now).toISOString();
const clamp = (value, max) => String(value ?? '').slice(0, max);

export function makeScope({ mergeBase, files, skipped = 0 }) {
  const sorted = [...new Set(files)].sort();
  return { merge_base_sha: mergeBase, files_sha256: createHash('sha256').update(sorted.join('\n')).digest('hex'), total_files: sorted.length, skipped_files: skipped };
}
const sameScope = (a, b) => a.merge_base_sha === b.merge_base_sha && a.files_sha256 === b.files_sha256;

// ---------------------------------------------------------------- the "should a model run?" decision

// pr: { state, draft, head_sha }; read: readState() result; requestedHead: HEAD the queued event captured.
// -> { action, reason, state? }  actions: skip | wait_draft | stop_untrusted | wait_in_progress | reuse | hold | budget_stop | run
export function planRun({ pr, requestedHead, read, now = Date.now() }) {
  if (pr.state !== 'open') return { action: 'skip', reason: 'pull request is not open' };
  if (read.kind === 'conflict' || read.kind === 'invalid' || read.kind === 'legacy') return { action: 'stop_untrusted', reason: read.reason };
  if (pr.draft) return { action: 'wait_draft', reason: 'draft pull request: no review until it is marked ready' };
  if (requestedHead && requestedHead !== pr.head_sha) return { action: 'skip', reason: 'queued request is for an older HEAD; a newer event owns the current one' };
  let state = read.kind === 'ok' ? read.state : null;
  if (!state) return { action: 'run', reason: 'first review of this pull request', state: null };

  if (state.status === 'IN_PROGRESS') {
    const startedAt = Date.parse(state.claimed_at);
    if (!Number.isFinite(startedAt) || now - startedAt < IN_PROGRESS_TIMEOUT_MS) return { action: 'wait_in_progress', reason: 'a review attempt is still running', state };
    state = interrupted(state, now); // the attempt stays spent; nothing is credited
  }
  if (state.completed_head_sha === pr.head_sha) return { action: 'reuse', reason: 'a complete review already exists for this HEAD', state };
  if (state.completed_rounds >= MAX_ROUNDS) {
    return { action: 'budget_stop', reason: `Both review rounds are used (${MAX_ROUNDS}/${MAX_ROUNDS}); HEAD ${pr.head_sha.slice(0, 12)} was not reviewed and no further automatic round starts.`, state };
  }
  if (state.attempts_used >= MAX_ATTEMPTS) {
    return { action: 'budget_stop', reason: `Model execution budget used up (${MAX_ATTEMPTS}/${MAX_ATTEMPTS}); HEAD ${pr.head_sha.slice(0, 12)} cannot be reviewed automatically.`, state };
  }
  if (state.head_sha === pr.head_sha && state.stalled_attempts >= STALL_LIMIT) {
    return { action: 'hold', reason: 'repeated attempts on this HEAD made no progress; push a new commit to continue', state };
  }
  return { action: 'run', reason: `review round ${state.completed_rounds + 1} for this HEAD`, state };
}

// ---------------------------------------------------------------- state transitions

const baseFrom = (prev) => ({
  completed_rounds: prev?.completed_rounds ?? 0, completed_head_sha: prev?.completed_head_sha ?? null,
  attempts_used: prev?.attempts_used ?? 0,
});

function interrupted(state, now) {
  const { claimed_at, ...rest } = state; // eslint-disable-line no-unused-vars
  return { ...rest, status: 'STOPPED', reason: `Attempt ${state.attempts_used} was interrupted before it reported a result; it stays spent and nothing was credited.`, stalled_attempts: state.stalled_attempts + 1, updated_at: iso(now) };
}

// STOPPED without a model call (budget, rounds exhausted, scope too large...). Attempts are untouched.
export function stoppedState({ prev, repo, prNumber, head, scope, reason, now, stalled = false }) {
  const same = prev && prev.head_sha === head;
  return {
    schema_version: SCHEMA_VERSION, repo, pr_number: Number(prNumber), head_sha: head, status: 'STOPPED', reason: clamp(reason, 800),
    ...baseFrom(prev), stalled_attempts: stalled ? STALL_LIMIT : (same ? prev.stalled_attempts : 0),
    scope: scope ?? prev.scope, reviewed_files: same && scope && sameScope(scope, prev.scope) ? [...prev.reviewed_files] : [],
    findings: (prev?.findings ?? []).map((f) => ({ ...f })), updated_at: iso(now),
  };
}

// The attempt is recorded HERE, before the model is called. `spend: false` is the no-model path (empty scope).
export function claimAttempt({ prev, repo, prNumber, head, scope, now, spend = true }) {
  const keep = Boolean(prev) && prev.head_sha === head && sameScope(prev.scope, scope);
  const attempts = (prev?.attempts_used ?? 0) + (spend ? 1 : 0);
  const state = {
    schema_version: SCHEMA_VERSION, repo, pr_number: Number(prNumber), head_sha: head, status: 'IN_PROGRESS', reason: '',
    ...baseFrom(prev), attempts_used: attempts, stalled_attempts: keep ? prev.stalled_attempts : 0,
    scope, reviewed_files: keep ? [...prev.reviewed_files] : [],
    // A finding last checked on another HEAD must be re-verified here; its old verdict says nothing about this code.
    findings: (prev?.findings ?? []).map((f) => (f.checked_head_sha === head ? { ...f } : { ...f, verification: 'OPEN' })),
    updated_at: iso(now), claimed_at: iso(now),
  };
  state.reason = `Review round ${state.completed_rounds + 1} of ${MAX_ROUNDS} in progress: attempt ${attempts}/${MAX_ATTEMPTS}, ${state.reviewed_files.length}/${scope.total_files} file(s) reviewed.`;
  return state;
}

// Marks a state that was neither concluded nor continued (technical stop, HEAD moved, time up). Keeps all progress.
export function stopRun(state, reason, now) {
  const { claimed_at, ...rest } = state; // eslint-disable-line no-unused-vars
  return { ...rest, status: 'STOPPED', reason: clamp(reason, 800), updated_at: iso(now) };
}

// An attempt that produced nothing usable (provider failure, bad output, crash): spent, nothing credited.
export function failAttempt(state, now) {
  return { ...state, stalled_attempts: state.stalled_attempts + 1, updated_at: iso(now), claimed_at: iso(now) };
}

// A result for a HEAD that is no longer current is never credited: only the spent attempt remains.
export function discardAttempt(state, newHead, now) {
  return stopRun({ ...state, stalled_attempts: state.stalled_attempts + 1 }, `HEAD moved to ${String(newHead ?? 'unknown').slice(0, 12)} during the attempt; its result was discarded and the attempt stays spent.`, now);
}

export function isCovered(state, scopeFiles) {
  const reviewed = new Set(state.reviewed_files);
  return scopeFiles.every((file) => reviewed.has(file));
}

// ---------------------------------------------------------------- one model result -> state

export function parseBatchOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'model output is not an object' };
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.prior_findings)) return { ok: false, error: 'model output lacks findings or prior_findings' };
  const c = raw.coverage;
  if (!c || typeof c.complete !== 'boolean' || !Array.isArray(c.reviewedPaths) || !Array.isArray(c.unreviewedPaths)) return { ok: false, error: 'model output has no usable coverage report' };
  const findings = [];
  for (const f of raw.findings) {
    if (!f || !SEVERITIES.includes(f.severity) || typeof f.path !== 'string' || !f.path || typeof f.title !== 'string' || !f.title.trim()) return { ok: false, error: 'model output contains a malformed finding' };
    if (f.severity !== 'P3' && (typeof f.failure_path !== 'string' || !f.failure_path.trim())) return { ok: false, error: 'model output has a P0-P2 finding without a failure_path' };
    findings.push({ severity: f.severity, title: clamp(f.title.trim(), 200), path: clamp(f.path, 1000), failure_path: clamp(typeof f.failure_path === 'string' ? f.failure_path.trim() : '', 600) });
  }
  const verdicts = new Map();
  for (const p of raw.prior_findings) {
    if (!p || typeof p.id !== 'string' || !['FIXED', 'STILL_OPEN', 'UNCERTAIN'].includes(p.verification)) return { ok: false, error: 'model output contains a malformed prior finding verdict' };
    // FIXED has to come with evidence; otherwise it is only a claim.
    const verification = p.verification === 'FIXED' && !String(p.evidence ?? '').trim() ? 'UNCERTAIN' : p.verification;
    const old = verdicts.get(p.id);
    if (!old || VERDICT_RANK[verification] > VERDICT_RANK[old]) verdicts.set(p.id, verification);
  }
  return {
    ok: true,
    value: {
      findings, verdicts,
      coverage: { complete: c.complete, reviewed: new Set(c.reviewedPaths.map(String)), unreviewed: new Set(c.unreviewedPaths.map(String)) },
    },
  };
}

const sameIssue = (a, b) => a.path === b.path && a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
const nextId = (findings) => `F${String(findings.reduce((max, f) => Math.max(max, Number(f.id.slice(1)) || 0), 0) + 1).padStart(3, '0')}`;

// Files the program credits for one batch. The model's report is checked against the assignment and the tool log:
// a path outside the batch counts for nothing, a path the model itself marks unreviewed is never credited, a model
// that says it is incomplete without naming what is missing gets no credit at all, and a file whose diff was not
// fully inlined needs a real Read of that file.
export function creditedFiles({ assigned, coverage, needsRead = new Set(), readPaths = new Set() }) {
  if (!coverage.complete && coverage.unreviewed.size === 0) return [];
  const assignedSet = new Set(assigned);
  return [...coverage.reviewed].filter((p) => assignedSet.has(p) && !coverage.unreviewed.has(p) && (!needsRead.has(p) || readPaths.has(p))).sort();
}

// Folds one valid batch result into the state. Findings are only ever added or escalated; nothing a batch omits is
// removed or downgraded. -> { state, credited, overflow }
export function applyBatch({ state, assigned, output, needsRead, readPaths, now }) {
  const head = state.head_sha;
  const findings = state.findings.map((f) => ({ ...f }));
  for (const f of findings) {
    const verdict = output.verdicts.get(f.id);
    if (!verdict || f.severity === 'P3' && f.verification === 'FIXED') continue;
    f.verification = f.checked_head_sha === head ? (VERDICT_RANK[verdict] > VERDICT_RANK[f.verification] ? verdict : f.verification) : verdict;
    f.checked_head_sha = head;
  }
  let overflow = false;
  for (const reported of output.findings) {
    const index = findings.findIndex((f) => sameIssue(f, reported));
    if (index >= 0) {
      const existing = findings[index];
      if (reported.severity === 'P3') continue; // an old or new P3 never hides or replaces anything
      const severity = existing.severity !== 'P3' && SEVERITY_RANK[existing.severity] < SEVERITY_RANK[reported.severity] ? existing.severity : reported.severity;
      const pending = existing.checked_head_sha !== head;
      const verification = existing.verification === 'FIXED' || (pending && existing.severity !== 'P3') ? 'STILL_OPEN' : (existing.severity === 'P3' ? 'OPEN' : existing.verification);
      findings[index] = { ...existing, severity, verification, failure_path: reported.failure_path || existing.failure_path, checked_head_sha: head };
      continue;
    }
    const entry = { id: nextId(findings), severity: reported.severity, title: reported.title, path: reported.path, failure_path: reported.failure_path, verification: 'OPEN', checked_head_sha: head };
    if (findings.length >= MAX_FINDINGS) {
      const p3 = findings.findIndex((f) => f.severity === 'P3');
      if (p3 >= 0 && reported.severity !== 'P3') findings.splice(p3, 1); // suggestions make room for blockers, never the reverse
      else { if (reported.severity !== 'P3') overflow = true; continue; }
    }
    findings.push(entry);
  }
  const credited = creditedFiles({ assigned, coverage: output.coverage, needsRead, readPaths });
  const reviewed = [...new Set([...state.reviewed_files, ...credited])].sort();
  const next = {
    ...state, findings, reviewed_files: reviewed, stalled_attempts: credited.some((p) => !state.reviewed_files.includes(p)) ? 0 : state.stalled_attempts + 1,
    updated_at: iso(now), claimed_at: iso(now),
  };
  next.reason = `Review round ${state.completed_rounds + 1} of ${MAX_ROUNDS} in progress: attempt ${state.attempts_used}/${MAX_ATTEMPTS}, ${reviewed.length}/${state.scope.total_files} file(s) reviewed.`;
  return { state: next, credited, overflow };
}

export function overflowState(state, now) {
  return { ...stopRun(state, `More blocking findings than the ${MAX_FINDINGS} the review state can record; fix the listed ones and push for a new review.`, now), stalled_attempts: STALL_LIMIT };
}

// Coverage is complete: turn the accumulated progress into this round's conclusion, counted in the SAME state.
export function concludeRound(state, now) {
  const head = state.head_sha;
  // An earlier blocker nobody verified on this HEAD is not fixed: omission is UNCERTAIN.
  const findings = state.findings.map((f) => (f.severity !== 'P3' && f.verification !== 'FIXED' && f.checked_head_sha !== head
    ? { ...f, verification: 'UNCERTAIN', checked_head_sha: head } : { ...f }));
  const round = state.completed_rounds + 1;
  const blocking = findings.filter(isBlocking);
  const { claimed_at, ...rest } = state; // eslint-disable-line no-unused-vars
  const next = { ...rest, findings, completed_rounds: round, completed_head_sha: head, reviewed_files: [], stalled_attempts: 0, updated_at: iso(now) };
  const skipped = state.scope.skipped_files ? ` ${state.scope.skipped_files} file(s) were outside the review scope (ignore rules or binary content).` : '';
  if (!blocking.length) {
    next.status = 'READY';
    next.reason = `Round ${round} complete: all ${state.scope.total_files} reviewable file(s) were covered and there is no unresolved P0-P2 finding (P3 items are suggestions).${skipped}`;
  } else if (round < MAX_ROUNDS) {
    next.status = 'CHANGES_REQUESTED';
    next.reason = `Round ${round} complete: ${blocking.length} blocking finding(s) (P0-P2). Fix them together, run local checks, then push once for the final round.${skipped}`;
  } else {
    const open = blocking.filter((f) => f.verification !== 'OPEN').length;
    next.status = 'STOPPED';
    next.reason = `Final round complete: ${blocking.length} blocking finding(s) remain (${open} still open or uncertain); no further automatic review.${skipped}`;
  }
  return next;
}

// ---------------------------------------------------------------- batch planning

// chunks: [{ path, bytes }] for the files still to review. Source files go before docs, tests and lockfiles. Both the
// number of files and the diff size bound a batch, so dozens of small files never land in one model session.
export function nextBatch({ remaining, bytesOf, limits = BATCH_LIMITS, shrink = 0 }) {
  const maxFiles = Math.max(1, Math.floor(limits.maxFiles / 2 ** shrink));
  const targetBytes = Math.max(1, Math.floor(limits.targetBytes / 2 ** shrink));
  const ordered = [...remaining].sort((a, b) => filePriority(b) - filePriority(a) || (a < b ? -1 : 1));
  const batch = [];
  let bytes = 0;
  for (const file of ordered) {
    const size = Math.min(bytesOf(file), limits.maxInlineFileBytes);
    if (batch.length && (batch.length >= maxFiles || bytes + size > targetBytes)) break;
    batch.push(file);
    bytes += size;
  }
  return batch;
}

// ---------------------------------------------------------------- one-time migration of the retired v1 document

// -> { ok: true, state } | { ok: false, reason }. Only what v1 actually recorded is converted; nothing is guessed.
export function convertV1(v1, { repo, prNumber, scope, now }) {
  if (v1?.schema_version !== 1 || v1.mode !== 'delivery-v1') return { ok: false, reason: 'not a schema_version 1 delivery state' };
  if (v1.repo?.toLowerCase() !== repo.toLowerCase() || v1.pr_number !== Number(prNumber)) return { ok: false, reason: 'state belongs to another repository or pull request' };
  const used = v1.review_runs_used;
  if (!Number.isInteger(used) || used < 0 || used > 2 || !Array.isArray(v1.findings)) return { ok: false, reason: 'v1 state is malformed' };
  if (v1.status === 'IN_PROGRESS' && Date.now() - Date.parse(v1.claimed_at ?? v1.updated_at ?? '') < IN_PROGRESS_TIMEOUT_MS) return { ok: false, reason: 'a v1 run may still be writing; migrate after it ends' };
  const complete = v1.coverage_complete === true && v1.status !== 'IN_PROGRESS';
  if (!complete && used === 2) return { ok: false, reason: 'v1 run 2 did not complete and run 1 is not recorded; the earlier completed rounds cannot be determined' };
  const rounds = complete ? used : 0;
  const head = v1.reviewed_head_sha;
  const findings = v1.findings.map((f) => ({
    id: f.id, severity: f.severity, title: String(f.title ?? f.failure_path ?? f.id).slice(0, 200), path: f.path, failure_path: f.failure_path ?? '',
    verification: f.verification, checked_head_sha: head,
  }));
  const state = {
    schema_version: SCHEMA_VERSION, repo: v1.repo, pr_number: v1.pr_number, head_sha: head,
    status: v1.status === 'IN_PROGRESS' ? 'STOPPED' : v1.status,
    reason: `Migrated from schema_version 1 (${used} model run(s) were already used; ${complete ? `${rounds} complete round(s)` : 'no complete round'}). Previous result: ${clamp(v1.reason, 400)}`,
    completed_rounds: rounds, completed_head_sha: rounds ? head : null, attempts_used: used, stalled_attempts: 0,
    scope, reviewed_files: [], findings, updated_at: iso(now),
  };
  return { ok: true, state };
}
