// The review result contract (schema_version 2). Owner: pr-bot. Consumers (agent-delivery) read docs/review-contract.md
// and tests/fixtures/review-contract.json, both pinned by commit SHA.
//
// ONE bot-authored PR comment carries the whole state as a JSON block; the commit status is its projection.
// Everything here is pure: parsing, validation, rendering, the commit-status projection and the consumer decision.

export const MARKER = '<!-- agent-delivery:v1 -->'; // locator only; the schema version lives inside the JSON
export const SCHEMA_VERSION = 2;
export const STATUS_CONTEXT = 'claude-review-bot/review';
export const BOT_LOGIN = 'jiaze-claude-review-bot[bot]';

export const MAX_ROUNDS = 2; // complete review conclusions per PR
export const MAX_ATTEMPTS = 10; // model executions per PR, ever
export const STALL_LIMIT = 4; // consecutive attempts on one HEAD that credited no new file
export const MAX_FINDINGS = 40;
export const MAX_SCOPE_FILES = 400;
const MAX_COMMENT_CHARS = 60000;

export const STATUSES = Object.freeze(['IN_PROGRESS', 'CHANGES_REQUESTED', 'READY', 'STOPPED']);
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const VERIFICATIONS = Object.freeze(['OPEN', 'FIXED', 'STILL_OPEN', 'UNCERTAIN']);
export const DECISIONS = Object.freeze(['READY', 'CHANGES_REQUESTED', 'STOPPED', 'WAIT']);

const SHA_RE = /^[0-9a-f]{40}$/;
export const isBlocking = (f) => ['P0', 'P1', 'P2'].includes(f?.severity) && f?.verification !== 'FIXED';
export const normalizeLogin = (login) => String(login ?? '').replace(/\[bot\]$/i, '').toLowerCase();
export const sameRepo = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// ---------------------------------------------------------------- validation

export function validateFinding(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return ['finding is not an object'];
  const errors = [];
  if (typeof f.id !== 'string' || !/^F\d{3,}$/.test(f.id)) errors.push('finding.id must look like F001');
  if (!SEVERITIES.includes(f.severity)) errors.push(`finding ${f.id}: bad severity`);
  if (typeof f.title !== 'string') errors.push(`finding ${f.id}: title required`);
  if (typeof f.path !== 'string' || !f.path) errors.push(`finding ${f.id}: path required`);
  if (typeof f.failure_path !== 'string') errors.push(`finding ${f.id}: failure_path required`);
  else if (f.severity !== 'P3' && !f.failure_path.trim()) errors.push(`finding ${f.id}: P0-P2 needs a non-empty failure_path`);
  if (!VERIFICATIONS.includes(f.verification)) errors.push(`finding ${f.id}: bad verification`);
  if (f.checked_head_sha !== null && !(typeof f.checked_head_sha === 'string' && SHA_RE.test(f.checked_head_sha))) errors.push(`finding ${f.id}: checked_head_sha must be a SHA or null`);
  return errors;
}

// -> { ok, errors }. `expected` binds the document to the repository and pull request it is read for.
export function validateState(state, expected = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, errors: ['state is not an object'] };
  const errors = [];
  if (state.schema_version !== SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (typeof state.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(state.repo)) errors.push('repo must be owner/repo');
  else if (expected.repo && !sameRepo(state.repo, expected.repo)) errors.push('state belongs to a different repository');
  if (!Number.isInteger(state.pr_number) || state.pr_number < 1) errors.push('pr_number must be a positive integer');
  else if (expected.prNumber != null && state.pr_number !== Number(expected.prNumber)) errors.push('state belongs to a different pull request');
  if (typeof state.head_sha !== 'string' || !SHA_RE.test(state.head_sha)) errors.push('head_sha must be a full commit SHA');
  if (!STATUSES.includes(state.status)) errors.push('bad status');
  if (typeof state.reason !== 'string' || !state.reason.trim()) errors.push('reason required');
  if (!Number.isInteger(state.completed_rounds) || state.completed_rounds < 0 || state.completed_rounds > MAX_ROUNDS) errors.push('completed_rounds out of range');
  if (state.completed_head_sha !== null && !(typeof state.completed_head_sha === 'string' && SHA_RE.test(state.completed_head_sha))) errors.push('completed_head_sha must be a SHA or null');
  if (state.completed_rounds === 0 && state.completed_head_sha !== null) errors.push('completed_head_sha without a completed round');
  if (state.completed_rounds > 0 && state.completed_head_sha === null) errors.push('completed round without completed_head_sha');
  if (!Number.isInteger(state.attempts_used) || state.attempts_used < 0 || state.attempts_used > MAX_ATTEMPTS) errors.push('attempts_used out of range');
  if (!Number.isInteger(state.stalled_attempts) || state.stalled_attempts < 0) errors.push('stalled_attempts must be a non-negative integer');
  const scope = state.scope;
  if (!scope || typeof scope !== 'object' || !SHA_RE.test(scope.merge_base_sha ?? '') || !/^[0-9a-f]{64}$/.test(scope.files_sha256 ?? '')
    || !Number.isInteger(scope.total_files) || scope.total_files < 0 || !Number.isInteger(scope.skipped_files) || scope.skipped_files < 0) errors.push('scope is malformed');
  if (!Array.isArray(state.reviewed_files) || state.reviewed_files.some((p) => typeof p !== 'string' || !p)) errors.push('reviewed_files must be a path array');
  else if (scope && state.reviewed_files.length > scope.total_files) errors.push('reviewed_files exceeds the scope');
  if (!Array.isArray(state.findings)) errors.push('findings must be an array');
  else {
    if (state.findings.length > MAX_FINDINGS) errors.push('too many findings');
    const seen = new Set();
    for (const f of state.findings) {
      errors.push(...validateFinding(f));
      if (f?.id && seen.has(f.id)) errors.push(`duplicate finding id ${f.id}`);
      seen.add(f?.id);
    }
  }
  if (errors.length === 0) {
    const blocking = state.findings.some(isBlocking);
    const concluded = state.completed_head_sha === state.head_sha;
    if (state.status === 'READY' && (!concluded || blocking)) errors.push('READY needs a completed round on this HEAD and no unresolved P0-P2');
    if (state.status === 'CHANGES_REQUESTED' && (!concluded || !blocking || state.completed_rounds !== 1)) errors.push('CHANGES_REQUESTED needs a completed first round on this HEAD with a blocking finding');
    if (state.status === 'IN_PROGRESS' && (state.attempts_used < 1 || typeof state.claimed_at !== 'string')) errors.push('IN_PROGRESS must have a recorded attempt');
    if (concluded && state.reviewed_files.length) errors.push('a completed round carries no partial progress');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- comment <-> state

const safeText = (value, max) => String(value ?? '').replace(/<!--/g, '<​!--').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').slice(0, max);

export function renderComment(state) {
  const head = (extra) => [
    MARKER, '```json', JSON.stringify(state, null, 2), '```', '',
    `**Review: ${state.status}** (rounds ${state.completed_rounds}/${MAX_ROUNDS}, attempts ${state.attempts_used}/${MAX_ATTEMPTS}, HEAD \`${state.head_sha.slice(0, 12)}\`)`,
    '', safeText(state.reason, 800), ...extra,
  ];
  const pending = state.scope.total_files - state.reviewed_files.length;
  const progress = state.status !== 'IN_PROGRESS' && !state.reviewed_files.length ? [] : state.completed_head_sha === state.head_sha ? [] : [`Coverage in progress: ${state.reviewed_files.length}/${state.scope.total_files} file(s) reviewed${pending > 0 ? `, ${pending} remaining` : ''}.`];
  const table = state.findings.length
    ? ['', '| ID | Severity | State | Path | Failure path |', '| --- | --- | --- | --- | --- |',
      ...state.findings.map((f) => `| ${f.id} | ${f.severity} | ${f.verification} | \`${safeText(f.path, 120).replace(/`/g, "'")}\` | ${safeText(f.failure_path || f.title, 200)} |`),
      '', 'P3 items are suggestions and never block. This comment is generated from the JSON above.']
    : [];
  let text = `${head([...(progress.length ? ['', ...progress] : []), ...table]).join('\n')}\n`;
  if (text.length > MAX_COMMENT_CHARS) text = `${head(progress.length ? ['', ...progress] : []).join('\n')}\n`; // JSON stays complete; the table is only a view
  if (text.length > MAX_COMMENT_CHARS) throw new Error('review state does not fit in one comment');
  return text;
}

export function parseComment(body) {
  if (typeof body !== 'string') return null;
  const text = body.replace(/^﻿/, '').trimStart();
  if (!text.startsWith(MARKER)) return null;
  const match = /^\s*```json\r?\n([\s\S]*?)\r?\n```/.exec(text.slice(MARKER.length));
  if (!match) return { error: 'marker is not followed by a JSON code block' };
  try { return { value: JSON.parse(match[1]) }; } catch { return { error: 'state JSON does not parse' }; }
}

// Reads the authoritative state from a PR's conversation comments ({ id, source, login, type, body }). Only comments
// authored by the bot identity count: a body's own claims prove nothing.
// -> { kind: 'none' | 'ok' | 'invalid' | 'conflict' | 'legacy', state?, commentId?, reason?, ignoredForged }
// 'legacy' = a bot comment carrying a pre-v2 document (only the one-time migration looks at it).
export function readState(records, { botLogin = BOT_LOGIN, repo, prNumber } = {}) {
  const bot = normalizeLogin(botLogin);
  let ignoredForged = 0;
  const valid = []; const broken = []; const legacy = [];
  for (const record of records ?? []) {
    if (record?.source && record.source !== 'issue') continue;
    const parsed = parseComment(record?.body);
    if (!parsed) continue;
    if (normalizeLogin(record.login) !== bot || String(record.type ?? '').toLowerCase() !== 'bot') { ignoredForged += 1; continue; }
    if (parsed.error) { broken.push({ id: String(record.id), reason: parsed.error }); continue; }
    if (parsed.value?.schema_version === 1) { legacy.push({ id: String(record.id), state: parsed.value }); continue; }
    const check = validateState(parsed.value, { repo, prNumber });
    if (!check.ok) { broken.push({ id: String(record.id), reason: check.errors[0] }); continue; }
    valid.push({ id: String(record.id), state: parsed.value });
  }
  const total = valid.length + broken.length + legacy.length;
  if (total === 0) return { kind: 'none', ignoredForged };
  if (total > 1) return { kind: 'conflict', reason: `${total} review state comments from the bot; refusing to guess which one is current`, ignoredForged };
  if (legacy.length) return { kind: 'legacy', reason: 'review state is in the retired schema_version 1 format; run the one-time migration', commentId: legacy[0].id, legacy: legacy[0].state, ignoredForged };
  if (broken.length) return { kind: 'invalid', reason: `review state comment is not trustworthy: ${broken[0].reason}`, commentId: broken[0].id, ignoredForged };
  return { kind: 'ok', state: valid[0].state, commentId: valid[0].id, ignoredForged };
}

// ---------------------------------------------------------------- projections and consumers

export function commitStatusFor(state) {
  const tag = `rounds ${state.completed_rounds}/${MAX_ROUNDS}`;
  switch (state.status) {
    case 'READY': return { state: 'success', description: `Review READY (${tag})` };
    case 'CHANGES_REQUESTED': return { state: 'failure', description: `Review: changes requested (${tag})` };
    case 'IN_PROGRESS': return { state: 'pending', description: `Review running (${state.reviewed_files.length}/${state.scope.total_files} files, ${tag})` };
    default: return { state: 'error', description: `Review stopped: ${state.reason}`.slice(0, 140) };
  }
}

// What a consumer concludes from one comment, given context obtained independently of it: repo, PR number, its local
// HEAD and the remote's current HEAD. Nothing absent, stale, forged or inconsistent is ever READY.
export function evaluateComment({ repo, prNumber, localHead, currentHead, authorLogin, authorType, body, botLogin = BOT_LOGIN }) {
  const read = readState(body ? [{ source: 'issue', id: '0', login: authorLogin, type: authorType, body }] : [], { botLogin, repo, prNumber });
  if (read.kind !== 'ok') return { trusted: false, decision: 'WAIT' };
  const { state } = read;
  if (state.head_sha !== currentHead || state.head_sha !== localHead) return { trusted: true, decision: 'WAIT' };
  if (state.status === 'IN_PROGRESS') return { trusted: true, decision: 'WAIT' };
  return { trusted: true, decision: state.status };
}
