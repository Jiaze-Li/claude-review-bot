const MATERIAL_SEVERITIES = new Set(['P0', 'P1', 'P2']);
export const SESSION_VERSION = 1;
export const MAX_VERIFICATION_ROUNDS = 2;
// A P0-P2 finding must carry a concrete failure path (trigger state -> wrong
// result). Without one it is demoted to non-blocking P3 instead of blocking.
export const MIN_FAILURE_PATH_CHARS = 30;
const MAX_DISMISSED = 20;
// Explicit Claude deep review budgets. The per-PR cap is cumulative across every
// deep run (including failed ones) and is persisted in the session.
export const DEEP_REVIEW_RUN_BUDGET_USD = 2;
export const DEEP_REVIEW_PR_BUDGET_USD = 6;
// Reserve half of the shared cap for explicitly requested Claude reviews.
// Fallback calls count against BOTH this pool and the shared per-PR cap.
export const CLAUDE_FALLBACK_PR_BUDGET_USD = 3;
// An IN_PROGRESS session older than this belongs to a run that died without
// reporting; it must resolve instead of waiting forever.
// Safe to equal the Claude step timeout: the sweeper and planner act only inside the per-PR review lock.
export const DEEP_REVIEW_STALE_MS = 20 * 60 * 1000;
// Deliberately strict: wrongly suppressing a distinct real bug (false READY) is
// worse than letting a reworded repeat through for one more validation.
const KNOWN_MATCH_THRESHOLD = 0.8;

export function planReviewSession({ session = null, baseSha, headSha, reset = false, retryUnavailable = false, now = Date.now() } = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');

  // A moving target-branch tip is not new PR evidence by itself. The exact PR
  // HEAD and repair delta drive review progress; baseSha is retained as audit
  // metadata from discovery, not as a reason to spend another discovery call.
  if (reset || !session || session.version !== SESSION_VERSION) {
    return { mode: 'discovery', previousHead: null, reason: reset ? 'explicit reset' : 'new review session' };
  }

  // A push during a deep review must not wipe the session: plan as if the deep review had
  // never started, from the status it interrupted (open findings and rounds are preserved).
  if (session.status === 'REVIEW_IN_PROGRESS' && session.lastReviewedHead !== headSha) {
    return planReviewSession({
      session: { ...session, status: session.deepReview?.resumeStatus ?? 'AUDIT_PENDING' },
      baseSha, headSha, now,
    });
  }

  if (session.status === 'REVIEW_IN_PROGRESS') {
    if (isDeepReviewStale(session, now)) {
      return { mode: 'deep_review_stale', previousHead: session.lastReviewedHead, reason: 'deep review did not report back in time' };
    }
    return { mode: 'noop_waiting', previousHead: session.lastReviewedHead, reason: 'deep review is still in progress for this HEAD' };
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
    // Only an explicit manual retry can resume a provider-unavailable stop. Never
    // reopen ordinary human findings, verification exhaustion, or a moved HEAD.
    if (retryUnavailable && session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
        && session.lastReviewedHead === headSha) {
      return { mode: session.reviewFailure.mode,
        previousHead: session.reviewFailure.mode === 'verification' ? session.reviewFailure.previousHead : null,
        reason: 'retry provider-unavailable review on the same exact HEAD' };
    }
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
    fallbackSpendUsd: 0,
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

// ---- Explicit Claude deep review inside the session ----------------------
// The deep review is bound to one exact HEAD. While it runs the session is
// REVIEW_IN_PROGRESS (never READY); success merges its findings into the same
// ledger Gemini uses; any failure ends in HUMAN_REQUIRED.
export function isDeepReviewStale(session, now = Date.now()) {
  if (session?.status !== 'REVIEW_IN_PROGRESS') return false;
  const started = Date.parse(session.deepReview?.startedAt ?? '');
  return !Number.isFinite(started) || now - started > DEEP_REVIEW_STALE_MS;
}

export function deepReviewBudgetLeft(session) {
  const spent = Number.isFinite(session?.deepSpendUsd) && session.deepSpendUsd > 0 ? session.deepSpendUsd : 0;
  return Math.max(0, DEEP_REVIEW_PR_BUDGET_USD - spent);
}

// Older sessions only persisted a combined ledger; conservatively charge their
// entire pre-migration spend to the fallback pool. We cannot infer provenance.
export function claudeFallbackBudgetLeft(session) {
  const fallbackSpent = Number.isFinite(session?.fallbackSpendUsd)
    ? session.fallbackSpendUsd : (session?.deepSpendUsd ?? 0);
  return Math.max(0, Math.min(deepReviewBudgetLeft(session),
    CLAUDE_FALLBACK_PR_BUDGET_USD - fallbackSpent));
}

export function chargeClaudeFallback(session, costUsd) {
  validateSession(session);
  const amount = nonNegative(costUsd);
  const fallbackSpent = Number.isFinite(session.fallbackSpendUsd)
    ? session.fallbackSpendUsd : (session.deepSpendUsd ?? 0);
  return {
    ...session,
    deepSpendUsd: roundUsd((session.deepSpendUsd ?? 0) + amount),
    fallbackSpendUsd: roundUsd(fallbackSpent + amount),
  };
}

// No model response was published. Preserve the existing finding ledger and
// report HUMAN_REQUIRED for the attempted HEAD without pretending it passed.
export function stopUnavailableReviewSession({
  session = null, baseSha, headSha, sourceCommentId, mode, reason,
  spentUsd = 0, now = new Date().toISOString(),
} = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');
  if (!['discovery', 'verification', 'audit'].includes(mode)) throw new Error('invalid failed review mode');
  const base = session ?? applyDiscoveryResult({
    result: { summary: 'Automated review could not run.', findings: [] },
    baseSha, headSha, sourceCommentId, now,
  });
  validateSession(base);
  const explanation = compactText(reason || 'Gemini and Claude fallback unavailable', 240);
  const stopped = {
    ...base,
    status: 'HUMAN_REQUIRED',
    lastReviewedHead: headSha,
    auditCompleted: mode === 'discovery' ? false : base.auditCompleted,
    reviewFailure: {
      code: 'REVIEWER_UNAVAILABLE', mode, head: headSha,
      sourceCommentId: String(sourceCommentId ?? ''),
      ...(mode === 'verification' ? { previousHead: base.lastReviewedHead } : {}),
      reason: explanation,
    },
    lastSummary: `Automatic ${mode} review incomplete: ${explanation}`,
    updatedAt: now,
  };
  return chargeClaudeFallback(stopped, spentUsd);
}

export function beginDeepReview({
  session = null, baseSha, headSha, runId = null, reserveUsd = 0, now = new Date().toISOString(),
} = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');
  if (session) validateSession(session);
  // Deep review is an additional gate on a Gemini session for this exact HEAD. Seeding a
  // session from Claude alone would skip Gemini discovery/verification for the HEAD.
  if (!session || session.lastReviewedHead !== headSha) {
    throw new Error('deep review requires an existing review session for this exact HEAD');
  }
  if (session.status === 'REVIEW_IN_PROGRESS' && !isDeepReviewStale(session, Date.parse(now))) {
    throw new Error('a deep review is already in progress for this HEAD');
  }
  // A stale in-progress marker is replaced; the status it interrupted is remembered.
  const resumeStatus = session.status === 'REVIEW_IN_PROGRESS' ? (session.deepReview?.resumeStatus ?? 'AUDIT_PENDING') : session.status;
  const base = session;
  return {
    ...base,
    lastReviewedHead: headSha,
    status: 'REVIEW_IN_PROGRESS',
    // The run's allotted budget is charged up front and reconciled at finalize/fail, so a run
    // that is interrupted (new commit, kill, stale replacement) can never escape the PR cap.
    deepSpendUsd: roundUsd((session.deepSpendUsd ?? 0) + nonNegative(reserveUsd)),
    deepReview: { head: headSha, startedAt: now, runId: runId == null ? null : String(runId), resumeStatus, state: 'IN_PROGRESS', reservedUsd: nonNegative(reserveUsd) },
    updatedAt: now,
  };
}

const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function completeDeepReview({
  session, result, headSha, spentUsd = 0, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (session.status !== 'REVIEW_IN_PROGRESS' || session.deepReview?.head !== headSha || session.lastReviewedHead !== headSha) {
    throw new Error('deep review result does not match the in-progress session HEAD');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.findings)) {
    throw new Error('deep review result must be an object with a findings array');
  }
  // Material findings first so the 6-entry session limit never drops a blocker.
  const ordered = [...result.findings].sort((a, b) => (SEVERITY_ORDER[a?.severity] ?? 9) - (SEVERITY_ORDER[b?.severity] ?? 9));
  const normalized = normalizeReviewResult({
    summary: String(result.summary ?? '').slice(0, 4000),
    findings: ordered.slice(0, 6),
  });
  const omitted = ordered.slice(6).filter((f) => MATERIAL_SEVERITIES.has(f?.severity)).length;
  if (omitted > 0) throw new Error(`deep review reported more than 6 material findings (${omitted} omitted); refusing to drop blockers`);
  const findings = session.findings.map((finding) => ({ ...finding }));
  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : findings.length + 1;
  // Claude's material findings are never suppressed by Gemini's rejection ledger; only an
  // identical still-OPEN finding is skipped to avoid duplicates.
  const openKeys = new Set(findings.filter((f) => f.status === 'OPEN').map((f) => `${f.path}\0${String(f.title).trim().toLowerCase()}`));
  for (const finding of normalized.findings.filter((f) => !openKeys.has(`${f.path}\0${String(f.title).trim().toLowerCase()}`))) {
    findings.push({
      id: findingId(nextFindingNumber++),
      ...compactFinding({ ...finding, riskClass: finding.riskClass === 'uncategorized' ? 'deep-review' : finding.riskClass }),
      status: MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED',
      origin: 'CLAUDE_DEEP',
      introducedHead: headSha,
      lastCheckedHead: headSha,
      resolutionReason: null,
    });
  }
  const open = findings.filter((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity));
  const resume = session.deepReview?.resumeStatus;
  const verificationRound = session.verificationRound ?? 0;
  const status = open.length > 0
    ? verificationRound >= MAX_VERIFICATION_ROUNDS ? 'HUMAN_REQUIRED' : 'REWORK'
    : resume === 'HUMAN_REQUIRED' ? 'HUMAN_REQUIRED'
      : session.auditCompleted === true ? 'READY' : 'AUDIT_PENDING';
  return {
    ...session,
    status,
    findings,
    nextFindingNumber,
    deepSpendUsd: reconcileSpend(session, spentUsd),
    deepReview: { ...session.deepReview, state: 'COMPLETE', completedAt: now },
    lastSummary: compactText(normalized.summary, 800),
    updatedAt: now,
  };
}

export function failDeepReview({
  session, headSha, reason, spentUsd = 0, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (session.status !== 'REVIEW_IN_PROGRESS' || session.lastReviewedHead !== headSha) {
    throw new Error('failed deep review does not match the in-progress session HEAD');
  }
  return {
    ...session,
    status: 'HUMAN_REQUIRED',
    deepSpendUsd: reconcileSpend(session, spentUsd),
    deepReview: { ...session.deepReview, state: 'FAILED', failedAt: now, reason: compactText(reason || 'deep review did not complete', 300) },
    lastSummary: compactText(`Deep review did not complete: ${reason || 'unknown reason'}`, 800),
    updatedAt: now,
  };
}

// GitHub commit status for the exact HEAD the session reviewed. Only READY is success.
export function sessionCommitStatus(session, headSha) {
  if (!session || session.lastReviewedHead !== headSha) {
    return { state: 'pending', description: 'Independent review has not completed for this commit' };
  }
  switch (session.status) {
    case 'READY': return { state: 'success', description: 'Independent review complete: READY' };
    case 'REVIEW_IN_PROGRESS': return { state: 'pending', description: 'Claude deep review in progress' };
    case 'AUDIT_PENDING': return { state: 'pending', description: 'Final audit pending' };
    case 'REWORK': return { state: 'failure', description: 'Open material findings: rework needed' };
    default: return { state: 'error', description: 'Automatic review stopped: human judgment required' };
  }
}

function reconcileSpend(session, actualUsd) {
  const reserved = nonNegative(session.deepReview?.reservedUsd);
  return roundUsd(Math.max(0, (session.deepSpendUsd ?? 0) - reserved + nonNegative(actualUsd)));
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundUsd(value) {
  return Math.round(value * 10000) / 10000;
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
    .filter((finding) => ['FIXED', 'DEFERRED', 'WAIVED', 'DISMISSED'].includes(finding.status))
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
    ...(session?.findings ?? []).filter((item) => item.status === 'DEFERRED' || item.status === 'DISMISSED'),
  ];
  return candidates.some((item) => {
    if (item.path !== finding.path) return false;
    // Human-dismissed claims require exact title + matching failure paths:
    // related but distinct real bugs must still reach the final auditor.
    if (item.status === 'DISMISSED') {
      return item.title.trim().toLowerCase() === String(finding.title).trim().toLowerCase()
        && (!item.failurePath || !finding.failurePath || item.failurePath === finding.failurePath);
    }
    return similarity(item.title, finding.title) >= KNOWN_MATCH_THRESHOLD;
  });
}

function dropKnownRepeats(findings, session) {
  return findings.filter((finding) => !matchesKnownDismissal(finding, session));
}

// ---- Evidence-based finding dismissal ----------------------------------
// Scoped, human-attested adjudication; unlike the broad override, this never
// pretends an unfinished final audit already completed.
export function applyFindingDismissal({
  session, findingId, headSha, by, reason, evidence, sourceCommentId,
  now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (!['REWORK', 'HUMAN_REQUIRED'].includes(session.status)) {
    throw new Error('dismissal requires REWORK or HUMAN_REQUIRED');
  }
  if (session.lastReviewedHead !== headSha) throw new Error('dismissal requires the exact last-reviewed HEAD');
  if (!/^F[0-9]{3,}$/.test(String(findingId ?? ''))) throw new Error('invalid dismissal finding id');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(String(by ?? ''))) {
    throw new Error('invalid dismissal actor');
  }
  if (!/^[1-9]\d*$/.test(String(sourceCommentId ?? ''))) throw new Error('invalid dismissal source comment id');
  const explanation = checkedText(reason, 400, 'dismissal reason');
  if (explanation.length < 30) throw new Error('dismissal reason must be at least 30 characters');
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 3) {
    throw new Error('dismissal needs 1-3 cited evidence URLs');
  }
  for (const link of evidence) {
    if (typeof link !== 'string' || link.length > 500) throw new Error('invalid dismissal evidence link');
    let url;
    try { url = new URL(link); } catch { throw new Error('invalid dismissal evidence URL'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      throw new Error('invalid dismissal evidence URL');
    }
  }
  const item = session.findings.find((finding) => finding.id === findingId);
  if (!item || item.status !== 'OPEN' || !MATERIAL_SEVERITIES.has(item.severity)) {
    throw new Error('dismissal finding is not an OPEN material finding');
  }
  const findings = session.findings.map((finding) => finding.id === findingId
    ? {
      ...finding, status: 'DISMISSED', lastCheckedHead: headSha,
      resolutionReason: compactText('Dismissed by @' + by + ': ' + explanation, 300),
      dismissal: { by, at: now, head: headSha, sourceCommentId: String(sourceCommentId),
        reason: explanation, evidence: [...evidence] },
    }
    : { ...finding });
  const remaining = findings.filter((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity)).length;
  const status = remaining ? session.status : session.auditCompleted === true ? 'READY' : 'AUDIT_PENDING';
  return {
    ...session, findings, status,
    lastSummary: compactText('Human-dismissed ' + findingId + ' by @' + by + '; remaining material findings: ' + remaining + '.', 800),
    updatedAt: now,
  };
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
  const next = session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
    ? 'Review did not complete. Restore Gemini quota and comment `@gemini review` to retry this exact HEAD; otherwise seek human review. Claude fallback remains budget-limited.'
    : session.status === 'READY'
    ? 'No action required unless the PR changes; a new commit will start a fresh bounded review automatically.'
    : session.status === 'REVIEW_IN_PROGRESS'
      ? 'Claude deep review is running for this exact commit; the PR is not READY until it finishes. If it stops, comment `@claude review` to restart.'
    : session.status === 'AUDIT_PENDING'
      ? 'The one-time final Gemini audit will run automatically. If the workflow stops, comment `@gemini review` to resume it.'
      : session.status === 'REWORK'
        ? 'Push a repair for real bugs; for a disproven finding post `@gemini dismiss F001` with Reason and Evidence lines. Dismissal does not change product code.'
        : 'Automatic review budget is exhausted. Use human judgment or a targeted Codex/Claude review; do not restart full discovery automatically.';
  const dismissed = session.findings.filter((finding) => finding.status === 'DISMISSED').slice(-4);
  const dismissalLines = dismissed.flatMap((finding) => [
    '- ' + finding.id + ' dismissed by @' + cleanInline(finding.dismissal?.by ?? 'unknown')
      + ' — ' + cleanInline(finding.dismissal?.reason ?? ''),
    '  - Evidence: ' + (finding.dismissal?.evidence ?? []).map(cleanInline).join(' · '),
  ]);
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
    `Default reviewer: **Gemini Flash (latest) / medium thinking**`,
    `Discovery: **${session.reviewFailure?.mode === 'discovery' ? 'not completed' : 'complete'}** · Final audit: **${audit}** · Verification: **${verification}**`,
    `Open material findings: **${open.length}**`,
    ...(session.reviewFailure ? [`Review stopped: **${cleanInline(session.reviewFailure.mode)}** · ${cleanInline(session.reviewFailure.reason)}`] : []),
    ...(session.deepSpendUsd > 0 ? [`Claude spend (deep review + fallback, SDK estimate): **${session.deepSpendUsd.toFixed(2)}** of ${DEEP_REVIEW_PR_BUDGET_USD.toFixed(2)} per-PR cap · remaining ${deepReviewBudgetLeft(session).toFixed(2)}`] : []),
    `Automatic fallback budget remaining: **${claudeFallbackBudgetLeft(session).toFixed(2)}** of ${CLAUDE_FALLBACK_PR_BUDGET_USD.toFixed(2)} per PR`,
    '',
    ...findingLines,
    ...(dismissalLines.length ? ['', 'Human-dismissed findings (cited, not machine-verified):', ...dismissalLines] : []),
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
  if (!['AUDIT_PENDING', 'READY', 'REWORK', 'HUMAN_REQUIRED', 'REVIEW_IN_PROGRESS'].includes(session.status)) throw new Error('invalid review session status');
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
