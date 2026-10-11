const MATERIAL_SEVERITIES = new Set(['P0', 'P1', 'P2']);
export const SESSION_VERSION = 1;
export const MAX_VERIFICATION_ROUNDS = 2;
// A P0-P2 finding must carry a concrete failure path (trigger state -> wrong
// result). Without one it is demoted to non-blocking P3 instead of blocking.
export const MIN_FAILURE_PATH_CHARS = 30;
const MAX_DISMISSED = 20;
// Deliberately strict: wrongly suppressing a distinct real bug (false READY) is
// worse than letting a reworded repeat through for one more validation.
const KNOWN_MATCH_THRESHOLD = 0.8;

export function planReviewSession({ session = null, baseSha, headSha, reset = false } = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');

  // A moving target-branch tip is not new PR evidence by itself. The exact PR
  // HEAD and repair delta drive review progress; baseSha is retained as audit
  // metadata from discovery, not as a reason to spend another discovery call.
  if (reset || !session || session.version !== SESSION_VERSION) {
    return { mode: 'discovery', previousHead: null, reason: reset ? 'explicit reset' : 'new review session' };
  }

  if (session.status === 'AUDIT_PENDING') {
    if (session.lastReviewedHead === headSha) {
      return { mode: 'audit', previousHead: null, reason: 'run one final independent audit before READY' };
    }
    return { mode: 'discovery', previousHead: null, reason: 'PR changed before final audit; start a fresh bounded session' };
  }

  if (session.status === 'READY') {
    if (session.lastReviewedHead === headSha) {
      return { mode: 'noop_ready', previousHead: session.lastReviewedHead, reason: 'current HEAD is already READY' };
    }
    return { mode: 'discovery', previousHead: null, reason: 'PR changed after READY; start a fresh bounded session' };
  }

  if (session.status === 'REWORK') {
    if (session.lastReviewedHead === headSha) {
      return { mode: 'noop_waiting', previousHead: session.lastReviewedHead, reason: 'push a repair before verification' };
    }
    if ((session.verificationRound ?? 0) >= MAX_VERIFICATION_ROUNDS) {
      return { mode: 'human_required', previousHead: session.lastReviewedHead, reason: 'verification budget exhausted' };
    }
    return { mode: 'verification', previousHead: session.lastReviewedHead, reason: 'verify the repair against open findings' };
  }

  if (session.status === 'HUMAN_REQUIRED') {
    return { mode: 'human_required', previousHead: session.lastReviewedHead ?? null, reason: 'session already requires human judgment' };
  }

  return { mode: 'discovery', previousHead: null, reason: 'unrecognized session state; restart bounded discovery' };
}

export function applyDiscoveryResult({
  result, baseSha, headSha, sourceCommentId, now = new Date().toISOString(),
} = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');
  const normalized = normalizeReviewResult(result);
  let nextFindingNumber = 1;
  const findings = normalized.findings.map((finding) => ({
    id: findingId(nextFindingNumber++),
    ...compactFinding(finding),
    status: MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED',
    origin: 'DISCOVERY',
    introducedHead: headSha,
    lastCheckedHead: headSha,
    resolutionReason: null,
  }));
  const open = findings.filter((finding) => finding.status === 'OPEN');
  return {
    version: SESSION_VERSION,
    sessionId: `${String(sourceCommentId ?? 'session')}-${headSha.slice(0, 12)}`,
    baseSha,
    discoveryHead: headSha,
    lastReviewedHead: headSha,
    status: open.length ? 'REWORK' : 'AUDIT_PENDING',
    auditCompleted: false,
    verificationRound: 0,
    maxVerificationRounds: MAX_VERIFICATION_ROUNDS,
    nextFindingNumber,
    findings,
    acceptedRiskClasses: [],
    dismissed: [],
    lastSummary: compactText(normalized.summary, 500),
    updatedAt: now,
  };
}

export function applyVerificationResult({
  session, result, headSha, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  const normalized = normalizeVerificationResult(result);
  const expectedIds = new Set(session.findings.filter((finding) => finding.status === 'OPEN').map((finding) => finding.id));
  for (const entry of normalized.verifications) {
    if (!expectedIds.has(entry.findingId)) {
      throw new Error('verification referenced unknown or non-open finding id "' + entry.findingId + '"');
    }
  }
  const byId = new Map(normalized.verifications.map((entry) => [entry.findingId, entry]));
  const findings = session.findings.map((finding) => {
    if (finding.status !== 'OPEN') return { ...finding };
    const verdict = byId.get(finding.id);
    if (!verdict) {
      return {
        ...finding,
        lastCheckedHead: headSha,
        resolutionReason: 'Verifier omitted this open finding; kept open fail-closed.',
      };
    }
    if (verdict.status === 'FIXED') {
      return {
        ...finding,
        status: 'FIXED',
        lastCheckedHead: headSha,
        resolutionReason: compactText(verdict.reason, 300),
      };
    }
    return {
      ...finding,
      lastCheckedHead: headSha,
      resolutionReason: compactText(verdict.reason, 600),
    };
  });

  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : findings.length + 1;
  for (const finding of dropKnownRepeats(normalized.findings, session)) {
    findings.push({
      id: findingId(nextFindingNumber++),
      ...compactFinding(finding),
      status: MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED',
      origin: 'REPAIR_REGRESSION',
      introducedHead: headSha,
      lastCheckedHead: headSha,
      resolutionReason: null,
    });
  }

  const verificationRound = (session.verificationRound ?? 0) + 1;
  const open = findings.filter((finding) => finding.status === 'OPEN');
  const status = open.length === 0
    ? session.auditCompleted === true ? 'READY' : 'AUDIT_PENDING'
    : verificationRound >= MAX_VERIFICATION_ROUNDS
      ? 'HUMAN_REQUIRED'
      : 'REWORK';

  return {
    ...session,
    lastReviewedHead: headSha,
    status,
    verificationRound,
    maxVerificationRounds: MAX_VERIFICATION_ROUNDS,
    nextFindingNumber,
    findings,
    lastSummary: compactText(normalized.summary, 800),
    updatedAt: now,
  };
}

export function applyAuditResult({
  session, result, headSha, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (session.status !== 'AUDIT_PENDING') throw new Error('final audit requires AUDIT_PENDING session');
  if (session.auditCompleted === true) throw new Error('final audit already completed for this session');
  const normalized = normalizeReviewResult(result);
  const findings = session.findings.map((finding) => ({ ...finding }));
  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : findings.length + 1;
  for (const finding of dropKnownRepeats(normalized.findings, session)) {
    findings.push({
      id: findingId(nextFindingNumber++),
      ...compactFinding(finding),
      status: MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED',
      origin: 'FINAL_AUDIT',
      introducedHead: headSha,
      lastCheckedHead: headSha,
      resolutionReason: null,
    });
  }
  const open = findings.filter((finding) => finding.status === 'OPEN');
  const verificationRound = session.verificationRound ?? 0;
  const status = open.length === 0
    ? 'READY'
    : verificationRound >= MAX_VERIFICATION_ROUNDS
      ? 'HUMAN_REQUIRED'
      : 'REWORK';
  return {
    ...session,
    lastReviewedHead: headSha,
    status,
    auditCompleted: true,
    nextFindingNumber,
    findings,
    lastSummary: compactText(normalized.summary, 800),
    updatedAt: now,
  };
}

// ---- Known-issue ledger -------------------------------------------------
// Concerns the session already examined (rejected/uncertain by the validator,
// or deferred P3) must not come back under a new wording and spend another
// validation round. Matching is deterministic: same file plus similar title.

export function recordDismissed(session, validations, headSha) {
  validateSession(session);
  const added = [];
  for (const entry of Array.isArray(validations) ? validations : []) {
    const verdict = String(entry?.verdict ?? '').toUpperCase();
    if (verdict !== 'REJECTED' && verdict !== 'UNCERTAIN') continue;
    const title = compactText(entry.title, 140);
    const path = compactText(entry.path, 240);
    if (!title || !path || path.startsWith('/') || path.split('/').includes('..')) continue;
    added.push({
      path,
      line: Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null,
      title,
      riskClass: compactText(entry.riskClass ?? 'uncategorized', 60),
      verdict,
      reason: compactText(entry.reason, 160),
      head: headSha,
    });
  }
  if (!added.length) return session;
  const dismissed = [...(session.dismissed ?? []), ...added].slice(-MAX_DISMISSED);
  return { ...session, dismissed };
}

// Items shown to later reviewers as "already examined".
export function knownIssues(session) {
  const dismissed = (session?.dismissed ?? []).map((item) => ({
    path: item.path, title: item.title, verdict: item.verdict, reason: item.reason,
  }));
  const settled = (session?.findings ?? [])
    .filter((finding) => finding.status === 'FIXED' || finding.status === 'DEFERRED' || finding.status === 'WAIVED')
    .map((finding) => ({
      path: finding.path, title: finding.title, verdict: finding.status, reason: finding.resolutionReason ?? '',
    }));
  return [...dismissed, ...settled];
}

export function knownIssuesPromptBlock(session) {
  const items = knownIssues(session).slice(-30);
  if (!items.length) return '';
  const lines = items.map((item) => `- [${item.verdict}] ${item.path} — ${item.title}${item.reason ? ` (${compactText(item.reason, 120)})` : ''}`);
  return `
ALREADY EXAMINED in this session (do NOT report these again, even reworded):
${lines.join('\n')}
FIXED items may be re-reported only if the current code still demonstrably fails.
`;
}

function titleTokens(value) {
  return new Set(String(value ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

export function similarity(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function matchesKnownDismissal(finding, session) {
  const candidates = [
    ...(session?.dismissed ?? []),
    ...(session?.findings ?? []).filter((item) => item.status === 'DEFERRED'),
  ];
  return candidates.some((item) =>
    item.path === finding.path && similarity(item.title, finding.title) >= KNOWN_MATCH_THRESHOLD);
}

function dropKnownRepeats(findings, session) {
  return findings.filter((finding) => !matchesKnownDismissal(finding, session));
}

// ---- Manual override ----------------------------------------------------
// A human who has read the open findings can end the session. Waived findings
// stay in the record; a later commit still starts a fresh bounded session.
export function applyOverride({ session, headSha, by, now = new Date().toISOString() } = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(String(by ?? ''))) throw new Error('invalid override user');
  if (session.status === 'READY') throw new Error('session is already READY');
  const waived = [];
  const findings = session.findings.map((finding) => {
    if (finding.status !== 'OPEN') return { ...finding };
    waived.push(finding.id);
    return {
      ...finding,
      status: 'WAIVED',
      lastCheckedHead: headSha,
      resolutionReason: compactText(`Waived by @${by} (manual override)`, 300),
    };
  });
  return {
    ...session,
    status: 'READY',
    auditCompleted: true,
    lastReviewedHead: headSha,
    findings,
    override: { by, at: now, head: headSha, waived },
    lastSummary: compactText(`Manually overridden by @${by}; ${waived.length} open finding(s) waived.`, 800),
    updatedAt: now,
  };
}

export function openMaterialFindings(session) {
  validateSession(session);
  return session.findings.filter((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity));
}

export function renderSessionComment(session, { sourceCommentIds = [] } = {}) {
  validateSession(session);
  const open = openMaterialFindings(session);
  const verification = `${session.verificationRound ?? 0}/${session.maxVerificationRounds ?? MAX_VERIFICATION_ROUNDS}`;
  const audit = session.auditCompleted === true ? 'complete' : session.status === 'AUDIT_PENDING' ? 'pending' : 'not run';
  const next = session.status === 'READY'
    ? 'No action required unless the PR changes; a new commit will start a fresh bounded review automatically.'
    : session.status === 'AUDIT_PENDING'
      ? 'The one-time final Gemini audit will run automatically. If the workflow stops, comment `@jiaze-claude-review-bot review` to resume it.'
      : session.status === 'REWORK'
        ? 'Push a repair; the new PR commit will trigger targeted verification automatically. The review command remains available as a manual retry.'
        : 'Automatic review budget is exhausted. Use human judgment or a targeted Codex/Claude review; do not restart full discovery automatically.';
  const findingLines = open.length
    ? open.slice(0, 8).flatMap((finding) => [
      `- ${finding.id} **${finding.severity}** — ${cleanInline(finding.title)}`,
      `  - ${cleanInline(finding.path)}${finding.line ? `:${finding.line}` : ''} — ${cleanInline(finding.body).slice(0, 800)}`,
    ])
    : ['- none'];
  const state = encodeSessionState(session);
  const processedMarkers = [...new Set(sourceCommentIds.map(String).filter((id) => /^[1-9]\d*$/.test(id)))]
    .slice(-8)
    .map((id) => `<!-- jiaze-review-source-comment:${id} -->`);
  return [
    '<!-- jiaze-review-session:v1 -->',
    ...processedMarkers,
    '### Independent Review Session',
    `Status: **${session.status}**${session.override ? ` (manually overridden by @${cleanInline(session.override.by)})` : ''}`,
    `Default reviewer: **Gemini Flash / low thinking**`,
    `Discovery: **complete** · Final audit: **${audit}** · Verification: **${verification}**`,
    `Open material findings: **${open.length}**`,
    '',
    ...findingLines,
    '',
    `Next: ${next}`,
    '',
    '<sub>P3 findings are non-blocking. After discovery, verification is limited to existing findings and repair regressions. The final broad audit runs at most once per session.</sub>',
    `<!-- jiaze-review-state:${state} -->`,
  ].join('\n');
}

export function parseSessionComment(body) {
  if (typeof body !== 'string' || !body.includes('<!-- jiaze-review-session:v1 -->')) return null;
  const match = body.match(/<!-- jiaze-review-state:([A-Za-z0-9_-]+) -->/);
  if (!match) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    validateSession(value);
    return value;
  } catch {
    return null;
  }
}

export function normalizeReviewResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review result must be an object');
  const summary = checkedText(value.summary, 4000, 'summary');
  if (!Array.isArray(value.findings) || value.findings.length > 6) throw new Error('findings must be an array with at most 6 entries');
  return { summary, findings: value.findings.map(normalizeFinding) };
}

export function normalizeVerificationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification result must be an object');
  const summary = checkedText(value.summary, 4000, 'summary');
  if (!Array.isArray(value.verifications) || value.verifications.length > 16) throw new Error('verifications must be an array with at most 16 entries');
  if (!Array.isArray(value.findings) || value.findings.length > 3) throw new Error('repair findings must be an array with at most 3 entries');
  const seen = new Set();
  const verifications = value.verifications.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('verification entry must be an object');
    const findingIdValue = String(entry.findingId ?? '').trim();
    if (!/^F\d{3,}$/.test(findingIdValue) || seen.has(findingIdValue)) throw new Error('verification findingId must be unique and stable');
    seen.add(findingIdValue);
    const status = String(entry.status ?? '').trim().toUpperCase();
    if (!['FIXED', 'STILL_OPEN', 'UNCERTAIN'].includes(status)) throw new Error('invalid verification status');
    return {
      findingId: findingIdValue,
      status,
      reason: checkedText(entry.reason, 2000, 'verification reason'),
    };
  });
  return { summary, verifications, findings: value.findings.map(normalizeFinding) };
}

function normalizeFinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('finding must be an object');
  let severity = String(value.severity ?? '').trim().toUpperCase();
  if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) throw new Error('invalid finding severity');
  // Evidence rule: a material claim without a concrete failure path cannot
  // block. Findings that omit the field entirely (legacy sessions) are kept.
  const failurePath = typeof value.failurePath === 'string' ? value.failurePath.replace(/[\r\n]+/g, ' ').trim() : null;
  let downgradedFrom = null;
  if (MATERIAL_SEVERITIES.has(severity) && failurePath !== null && failurePath.length < MIN_FAILURE_PATH_CHARS) {
    downgradedFrom = severity;
    severity = 'P3';
  }
  const path = checkedText(value.path, 1000, 'finding path');
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('finding path must be repository-relative');
  const line = value.line == null ? null : value.line;
  if (line !== null && (!Number.isInteger(line) || line < 1)) throw new Error('finding line must be null or a positive integer');
  return {
    severity,
    title: checkedText(value.title, 300, 'finding title'),
    body: checkedText(value.body, 4000, 'finding body'),
    path,
    line,
    riskClass: checkedText(value.riskClass ?? 'uncategorized', 120, 'riskClass'),
    ...(failurePath ? { failurePath: failurePath.slice(0, 600) } : {}),
    ...(downgradedFrom ? { downgradedFrom } : {}),
  };
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) || session.version !== SESSION_VERSION) {
    throw new Error('invalid review session');
  }
  checkedSha(session.baseSha, 'session.baseSha');
  checkedSha(session.lastReviewedHead, 'session.lastReviewedHead');
  if (!['AUDIT_PENDING', 'READY', 'REWORK', 'HUMAN_REQUIRED'].includes(session.status)) throw new Error('invalid review session status');
  if (session.auditCompleted != null && typeof session.auditCompleted !== 'boolean') throw new Error('invalid final audit state');
  if (!Array.isArray(session.findings) || session.findings.length > 64) throw new Error('invalid review session findings');
}

function compactFinding(finding) {
  return {
    ...finding,
    title: compactText(finding.title, 140),
    body: compactText(finding.body, 450),
    path: compactText(finding.path, 240),
    riskClass: compactText(finding.riskClass, 60),
    ...(finding.failurePath ? { failurePath: compactText(finding.failurePath, 200) } : {}),
  };
}

function compactText(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function findingId(number) {
  return `F${String(number).padStart(3, '0')}`;
}

function checkedSha(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function checkedText(value, max, name) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || text.includes('\0')) throw new Error(`invalid ${name}`);
  return text;
}

function cleanInline(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, '').slice(0, 300);
}

export function encodeSessionState(session) {
  validateSession(session);
  const json = JSON.stringify(session);
  if (Buffer.byteLength(json, 'utf8') > 24_000) throw new Error('review session state exceeds 24KB');
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function pendingSessionMarker(session, sourceCommentId) {
  const id = String(sourceCommentId ?? '');
  if (!/^[1-9]\d*$/.test(id)) throw new Error('invalid pending source comment id');
  return `<!-- jiaze-review-pending-session:v1:${id}:${encodeSessionState(session)} -->`;
}

export function parsePendingSessionReview(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/<!-- jiaze-review-pending-session:v1:([1-9]\d*):([A-Za-z0-9_-]+) -->/);
  if (!match) return null;
  try {
    const session = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
    validateSession(session);
    return { sourceCommentId: match[1], session };
  } catch {
    return null;
  }
}
