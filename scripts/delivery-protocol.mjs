// Delivery v1: the shared protocol for the opt-in two-run review mode.
//
// ONE state document per PR: a JSON block inside a single comment created and PATCHed by the GitHub App.
// That JSON is the only authority for mode, HEAD, run budget and findings. The commit status is a projection.
// Everything here is pure (no network, no clock unless passed in), so the Worker-side routing, the runner, the
// fixtures and the compat check all call the same functions.
//
// Known limitation (by design): an admin who deletes or edits the state comment can reset the budget. There is no
// signature, database or append-only ledger behind it; GitHub's author/type fields on the comment are the trust root.

export const DELIVERY_MODE = 'delivery-v1';
export const DELIVERY_LABEL = 'delivery-v1';
export const DELIVERY_MARKER = '<!-- agent-delivery:v1 -->';
export const SCHEMA_VERSION = 1;
export const RUN_LIMIT = 2;
export const STATUS_CONTEXT = 'claude-review-bot/review'; // same context the legacy path uses
export const BOT_LOGIN = 'jiaze-claude-review-bot[bot]';
// A run that claimed its slot but never wrote a result (crash, runner killed) is recognised after this long.
// Must stay above the delivery workflow's job timeout.
export const IN_PROGRESS_TIMEOUT_MS = 45 * 60 * 1000;

export const STATUSES = Object.freeze(['IN_PROGRESS', 'CHANGES_REQUESTED', 'READY', 'STOPPED']);
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const VERIFICATIONS = Object.freeze(['OPEN', 'FIXED', 'STILL_OPEN', 'UNCERTAIN']);
export const DECISIONS = Object.freeze(['READY', 'CHANGES_REQUESTED', 'STOPPED', 'WAIT']);

const SHA_RE = /^[0-9a-f]{40}$/;
const MIN_FAILURE_PATH = 30;
const MAX_FINDINGS = 40;

export const isBlocking = (finding) => ['P0', 'P1', 'P2'].includes(finding?.severity) && finding?.verification !== 'FIXED';
export const normalizeLogin = (login) => String(login ?? '').replace(/\[bot\]$/i, '').toLowerCase();
export const sameRepo = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// ---------------------------------------------------------------- validation

export function validateFinding(f) {
  const errors = [];
  if (!f || typeof f !== 'object' || Array.isArray(f)) return ['finding is not an object'];
  if (typeof f.id !== 'string' || !/^F\d{3,}$/.test(f.id)) errors.push('finding.id must look like F001');
  if (!SEVERITIES.includes(f.severity)) errors.push(`finding ${f.id}: bad severity`);
  if (typeof f.path !== 'string' || !f.path) errors.push(`finding ${f.id}: path required`);
  if (typeof f.failure_path !== 'string') errors.push(`finding ${f.id}: failure_path required`);
  else if (['P0', 'P1', 'P2'].includes(f.severity) && f.failure_path.trim().length < MIN_FAILURE_PATH) {
    errors.push(`finding ${f.id}: P0-P2 needs a concrete failure_path`);
  }
  if (!VERIFICATIONS.includes(f.verification)) errors.push(`finding ${f.id}: bad verification`);
  return errors;
}

// -> { ok, errors }. `expected` binds the document to the repo / PR it is read for.
export function validateState(state, expected = {}) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, errors: ['state is not an object'] };
  if (state.schema_version !== SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (state.mode !== DELIVERY_MODE) errors.push('mode is not delivery-v1');
  if (typeof state.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(state.repo)) errors.push('repo must be owner/repo');
  else if (expected.repo && !sameRepo(state.repo, expected.repo)) errors.push('state belongs to a different repository');
  if (!Number.isInteger(state.pr_number) || state.pr_number < 1) errors.push('pr_number must be a positive integer');
  else if (expected.prNumber != null && state.pr_number !== Number(expected.prNumber)) errors.push('state belongs to a different pull request');
  if (typeof state.reviewed_head_sha !== 'string' || !SHA_RE.test(state.reviewed_head_sha)) errors.push('reviewed_head_sha must be a full commit SHA');
  if (!STATUSES.includes(state.status)) errors.push('bad status');
  if (typeof state.reason !== 'string' || !state.reason.trim()) errors.push('reason required');
  if (!Number.isInteger(state.review_runs_limit) || state.review_runs_limit !== RUN_LIMIT) errors.push('review_runs_limit must be 2');
  if (!Number.isInteger(state.review_runs_used) || state.review_runs_used < 0 || state.review_runs_used > RUN_LIMIT) errors.push('review_runs_used out of range');
  if (typeof state.coverage_complete !== 'boolean') errors.push('coverage_complete must be boolean');
  if (!Array.isArray(state.findings)) errors.push('findings must be an array');
  else {
    if (state.findings.length > MAX_FINDINGS * 2) errors.push('too many findings');
    const seen = new Set();
    for (const f of state.findings) {
      errors.push(...validateFinding(f));
      if (f?.id && seen.has(f.id)) errors.push(`duplicate finding id ${f.id}`);
      seen.add(f?.id);
    }
  }
  if (errors.length === 0) {
    const blocking = state.findings.some(isBlocking);
    if (state.status === 'READY' && (!state.coverage_complete || blocking)) errors.push('READY needs complete coverage and no unresolved P0-P2');
    if (state.status === 'IN_PROGRESS' && state.review_runs_used < 1) errors.push('IN_PROGRESS must have consumed a run');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- comment <-> state

const safeText = (value, max = 300) => String(value ?? '').replace(/<!--/g, '<​!--').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').slice(0, max);

// Marker, then immediately a strict JSON code block (the machine-readable part), then text generated from it.
export function renderDeliveryComment(state) {
  const json = JSON.stringify(state, null, 2);
  const lines = [
    DELIVERY_MARKER,
    '```json',
    json,
    '```',
    '',
    `**Delivery review: ${state.status}** (run ${state.review_runs_used}/${state.review_runs_limit}, HEAD \`${state.reviewed_head_sha.slice(0, 12)}\`)`,
    '',
    safeText(state.reason, 600),
  ];
  if (state.findings.length) {
    lines.push('', '| ID | Severity | State | Path | Failure path |', '| --- | --- | --- | --- | --- |');
    for (const f of state.findings) {
      lines.push(`| ${f.id} | ${f.severity} | ${f.verification} | \`${safeText(f.path, 120).replace(/`/g, "'")}\` | ${safeText(f.failure_path || f.title || '', 240)} |`);
    }
    lines.push('', 'P3 items are suggestions and never block. This comment is generated from the JSON above.');
  }
  return `${lines.join('\n')}\n`;
}

export function parseDeliveryJson(body) {
  if (typeof body !== 'string') return null;
  const text = body.replace(/^﻿/, '').trimStart();
  if (!text.startsWith(DELIVERY_MARKER)) return null;
  const match = /^\s*```json\r?\n([\s\S]*?)\r?\n```/.exec(text.slice(DELIVERY_MARKER.length));
  if (!match) return { error: 'marker is not followed by a JSON code block' };
  try {
    return { value: JSON.parse(match[1]) };
  } catch {
    return { error: 'state JSON does not parse' };
  }
}

// Reads the state out of a PR's conversation-comment records ({ id, source, login, type, body }).
// Only comments authored by the bot identity (and of type Bot) count: the body's own claims prove nothing.
// -> { kind: 'none' | 'ok' | 'invalid' | 'conflict', state?, commentId?, reason?, ignoredForged }
export function readDeliveryState(records, { botLogin = BOT_LOGIN, repo, prNumber } = {}) {
  const bot = normalizeLogin(botLogin);
  let ignoredForged = 0;
  const valid = [];
  const broken = [];
  for (const record of records ?? []) {
    if (record?.source && record.source !== 'issue') continue;
    const parsed = parseDeliveryJson(record?.body);
    if (!parsed) continue;
    if (normalizeLogin(record.login) !== bot || String(record.type ?? '').toLowerCase() !== 'bot') { ignoredForged += 1; continue; }
    if (parsed.error) { broken.push({ id: String(record.id), reason: parsed.error }); continue; }
    const check = validateState(parsed.value, { repo, prNumber });
    if (!check.ok) { broken.push({ id: String(record.id), reason: check.errors[0] }); continue; }
    valid.push({ id: String(record.id), state: parsed.value });
  }
  const total = valid.length + broken.length;
  if (total === 0) return { kind: 'none', ignoredForged };
  if (total > 1) return { kind: 'conflict', reason: `${total} delivery state comments from the bot; refusing to guess which one is current`, ignoredForged };
  if (broken.length) return { kind: 'invalid', reason: `delivery state comment is not trustworthy: ${broken[0].reason}`, commentId: broken[0].id, ignoredForged };
  return { kind: 'ok', state: valid[0].state, commentId: valid[0].id, ignoredForged };
}

// ---------------------------------------------------------------- planning (the "should a model run?" decision)

// pr: { state, draft, head_sha, labels: [names] }; read: readDeliveryState result;
// requestedHead: the HEAD the queued event was captured at; legacy: whether an old review session exists on the PR.
// -> { action, reason, state?, round? }
export function planDelivery({ pr, requestedHead, read, legacy = false, now = Date.now() }) {
  if (pr.state !== 'open') return { action: 'skip', reason: 'pull request is not open' };
  if (read.kind === 'conflict' || read.kind === 'invalid') return { action: 'stop_untrusted', reason: read.reason };
  let state = read.kind === 'ok' ? read.state : null;
  const optedIn = (pr.labels ?? []).includes(DELIVERY_LABEL);

  if (!state) {
    if (!optedIn) return { action: 'skip', reason: 'pull request has not opted in to delivery-v1' };
    if (legacy) return { action: 'refuse_legacy', reason: 'This PR already has a legacy review session; delivery-v1 will not migrate it. Remove the delivery-v1 label to keep using the legacy review, or open a new PR.' };
  }
  if (requestedHead && requestedHead !== pr.head_sha) return { action: 'skip', reason: 'queued request is for an older HEAD; a newer event owns the current one' };
  if (pr.draft) return { action: 'wait_draft', reason: 'draft pull request: no review until it is marked ready', state };
  if (!state) return { action: 'run', round: 1, reason: 'first review run', state: null };

  // A crashed run keeps the slot it took: it becomes a STOPPED result, never a reset.
  let effective = state;
  let recovered = false;
  if (state.status === 'IN_PROGRESS') {
    const startedAt = Date.parse(state.claimed_at ?? state.updated_at ?? '');
    if (!Number.isFinite(startedAt) || now - startedAt < IN_PROGRESS_TIMEOUT_MS) {
      return { action: 'wait_in_progress', reason: 'a review run is still in progress', state };
    }
    recovered = true;
    effective = { ...state, status: 'STOPPED', reason: `Review run ${state.review_runs_used} was interrupted before it reported a result; its slot stays used.`, coverage_complete: false };
  }
  if (effective.reviewed_head_sha === pr.head_sha) {
    return recovered
      ? { action: 'recover_interrupted', reason: effective.reason, state: effective }
      : { action: 'reuse', reason: 'result already exists for this HEAD', state: effective };
  }
  if (effective.review_runs_used >= RUN_LIMIT) {
    return { action: 'budget_stop', reason: `Both review runs (${RUN_LIMIT}/${RUN_LIMIT}) are used; no further model run is allowed for this PR.`, state: effective };
  }
  return { action: 'run', round: effective.review_runs_used + 1, reason: `review run ${effective.review_runs_used + 1} for a new HEAD`, state: effective };
}

// ---------------------------------------------------------------- state transitions

export function baseState({ repo, prNumber, head, now }) {
  return {
    schema_version: SCHEMA_VERSION, mode: DELIVERY_MODE, repo, pr_number: Number(prNumber), reviewed_head_sha: head,
    status: 'STOPPED', reason: '', review_runs_used: 0, review_runs_limit: RUN_LIMIT, coverage_complete: false, findings: [],
    updated_at: new Date(now).toISOString(),
  };
}

// The slot is taken here, BEFORE the model runs. Persist this first; if that fails, no model run happens.
export function claimState({ prev, repo, prNumber, head, now }) {
  const state = baseState({ repo, prNumber, head, now });
  state.review_runs_used = (prev?.review_runs_used ?? 0) + 1;
  state.findings = (prev?.findings ?? []).map((f) => ({ ...f }));
  state.status = 'IN_PROGRESS';
  state.reason = `Review run ${state.review_runs_used} of ${RUN_LIMIT} is running for this HEAD.`;
  state.claimed_at = new Date(now).toISOString();
  return state;
}

// A new request that needs a model run but has no run left: STOPPED for the requested HEAD, budget untouched.
export function budgetStoppedState({ prev, repo, prNumber, head, now, reason }) {
  return { ...baseState({ repo, prNumber, head, now }), review_runs_used: prev.review_runs_used, findings: prev.findings.map((f) => ({ ...f })), reason };
}

// The claimed run ended without a usable review (provider failure, bad output, timeout, HEAD gone...).
export function failedRunState({ claimed, reason, now }) {
  const { claimed_at, ...rest } = claimed; // eslint-disable-line no-unused-vars
  return { ...rest, status: 'STOPPED', reason: String(reason).slice(0, 600), coverage_complete: false, updated_at: new Date(now).toISOString() };
}

export function parseModelOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'model output is not an object' };
  if (!Array.isArray(raw.findings)) return { ok: false, error: 'model output has no findings array' };
  if (!raw.coverage || typeof raw.coverage !== 'object' || typeof raw.coverage.complete !== 'boolean' || !Array.isArray(raw.coverage.reviewedPaths)) {
    return { ok: false, error: 'model output has no usable coverage report' };
  }
  const findings = [];
  for (const f of raw.findings) {
    if (!f || !SEVERITIES.includes(f.severity) || typeof f.path !== 'string' || !f.path || typeof f.title !== 'string') {
      return { ok: false, error: 'model output contains a malformed finding' };
    }
    findings.push({ severity: f.severity, title: f.title, path: f.path, failure_path: typeof f.failure_path === 'string' ? f.failure_path : '' });
  }
  const prior = Array.isArray(raw.prior_findings) ? raw.prior_findings.filter((p) => p && typeof p.id === 'string') : [];
  return {
    ok: true,
    value: {
      findings, prior: new Map(prior.map((p) => [p.id, p])),
      coverage: { complete: raw.coverage.complete, reviewed: new Set(raw.coverage.reviewedPaths.map(String)), note: String(raw.coverage.note ?? '') },
    },
  };
}

const nextId = (findings) => `F${String(findings.reduce((max, f) => Math.max(max, Number(f.id.slice(1)) || 0), 0) + 1).padStart(3, '0')}`;
const sameIssue = (a, b) => a.path === b.path && String(a.title ?? '').trim().toLowerCase() === String(b.title ?? '').trim().toLowerCase();

// Turns a claimed state + a parsed model output into the run's result. A prior P0-P2 that the model does not
// explicitly mark FIXED never counts as fixed: omission is UNCERTAIN.
export function finalizeRun({ claimed, output, changedFiles, now }) {
  const round = claimed.review_runs_used;
  const carried = claimed.findings.map((f) => {
    if (!isBlocking(f)) return f;
    const verdict = output.prior.get(f.id);
    const verification = ['FIXED', 'STILL_OPEN', 'UNCERTAIN'].includes(verdict?.verification) ? verdict.verification : 'UNCERTAIN';
    return { ...f, verification };
  });
  const findings = [...carried];
  for (const f of output.findings.slice(0, MAX_FINDINGS)) {
    if (findings.some((existing) => sameIssue(existing, f))) continue;
    const concrete = f.failure_path.trim().length >= MIN_FAILURE_PATH;
    const severity = !concrete && f.severity !== 'P3' ? 'P3' : f.severity; // no concrete failure path: a suggestion only
    findings.push({ id: nextId(findings), severity, title: f.title.slice(0, 200), path: f.path, failure_path: f.failure_path.trim().slice(0, 600), verification: 'OPEN' });
  }
  const missing = changedFiles.filter((file) => !output.coverage.reviewed.has(file));
  const coverageComplete = output.coverage.complete && missing.length === 0;
  const blocking = findings.filter(isBlocking);
  const next = { ...claimed, findings, coverage_complete: coverageComplete, updated_at: new Date(now).toISOString() };
  delete next.claimed_at;

  const uncertain = blocking.filter((f) => f.verification === 'UNCERTAIN' || f.verification === 'STILL_OPEN').length;
  if (round < RUN_LIMIT) {
    if (blocking.length) { next.status = 'CHANGES_REQUESTED'; next.reason = `${blocking.length} blocking finding(s) (P0-P2). Fix them together, run local checks, then push once for the final review.`; }
    else if (coverageComplete) { next.status = 'READY'; next.reason = 'Review complete: no blocking findings (P3 items are suggestions).'; }
    else { next.status = 'STOPPED'; next.reason = `Review coverage incomplete (${missing.length ? `${missing.length} changed file(s) not reviewed` : 'reviewer reported partial coverage'}); no READY without full coverage.`; }
  } else if (blocking.length) {
    next.status = 'STOPPED';
    next.reason = `Final review: ${blocking.length} blocking finding(s) remain (${uncertain} still open or uncertain); no further automatic review.`;
  } else if (!coverageComplete) {
    next.status = 'STOPPED';
    next.reason = 'Final review: coverage incomplete; no READY without full coverage.';
  } else {
    next.status = 'READY';
    next.reason = 'Final review complete: every earlier blocking finding is fixed and no new blocking finding was found.';
  }
  return next;
}

// ---------------------------------------------------------------- projections and consumers

export function commitStatusFor(state) {
  const tag = `run ${state.review_runs_used}/${state.review_runs_limit}`;
  switch (state.status) {
    case 'READY': return { state: 'success', description: `Delivery review READY (${tag})` };
    case 'CHANGES_REQUESTED': return { state: 'failure', description: `Delivery review: changes requested (${tag})` };
    case 'IN_PROGRESS': return { state: 'pending', description: `Delivery review running (${tag})` };
    default: return { state: 'error', description: `Delivery review stopped: ${state.reason}`.slice(0, 140) };
  }
}

// What a local consumer (agent-delivery's compat check) concludes from one comment, given context obtained
// independently of the comment: repo, PR number, the local HEAD, and the remote's current HEAD.
// -> { trusted, decision }. Nothing absent, stale, forged or inconsistent is ever READY.
export function evaluateDeliveryComment({ repo, prNumber, localHead, currentHead, authorLogin, authorType, body, botLogin = BOT_LOGIN }) {
  const read = readDeliveryState(
    body ? [{ source: 'issue', id: '0', login: authorLogin, type: authorType, body }] : [],
    { botLogin, repo, prNumber },
  );
  if (read.kind === 'none') return { trusted: false, decision: 'WAIT' }; // nothing (or only forged text) to rely on
  if (read.kind !== 'ok') return { trusted: false, decision: 'STOPPED' };
  const { state } = read;
  if (state.reviewed_head_sha !== currentHead || state.reviewed_head_sha !== localHead) return { trusted: true, decision: 'WAIT' };
  if (state.status === 'IN_PROGRESS') return { trusted: true, decision: 'WAIT' };
  return { trusted: true, decision: state.status };
}
