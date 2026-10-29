import { createHash } from 'node:crypto';
const MATERIAL_SEVERITIES = new Set(['P0', 'P1', 'P2']);
export const SESSION_VERSION = 1;
export const MAX_VERIFICATION_ROUNDS = 2;
// A P0-P2 finding must carry a concrete failure path (trigger state -> wrong
// result). Without one it is demoted to non-blocking P3 instead of blocking.
export const MIN_FAILURE_PATH_CHARS = 30;
const MAX_DISMISSED = 20;
// Automatic Claude calls share one conservative per-PR ledger. An explicitly
// requested review may exceed this cap, but each Claude call stays bounded.
export const DEEP_REVIEW_RUN_BUDGET_USD = 2;
// An explicit `@claude review` gets a larger single-call ceiling so big PRs can
// be covered in one pass. It still bypasses nothing else: provider quota applies.
export const DEEP_REVIEW_MANUAL_RUN_BUDGET_USD = 5;
export const DEEP_REVIEW_PR_BUDGET_USD = 6;
// Gemini is sent the whole diff in one request and refuses (rather than truncates) above this.
// The staged delta/audit pipeline still sends one request; full reviews are sharded and not bound by it.
export const GEMINI_MAX_CONTEXT_BYTES = 1_500_000;
const MAX_UNREVIEWED_PATHS = 20;
const MAX_REVIEWED_KEYS = 400;

// Short stable key for a path, so a session can remember which files a partial review
// already covered without storing every path in its 24 KB state.
export function pathKey(path) {
  return createHash('sha1').update(String(path)).digest('hex').slice(0, 8);
}
export const CLAUDE_AUTO_MIN_BUDGET_USD = 0.5;
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
    // Fail closed on inconsistent durable state instead of treating a stale
    // green status as authoritative for the reviewed HEAD.
    if (session.auditCompleted !== true || openMaterialFindings(session).length > 0
        || unresolvedMaterialFindings(session).length > 0) {
      return { mode: 'human_required', previousHead: session.lastReviewedHead,
        reason: 'inconsistent READY state: incomplete audit or unresolved material candidate' };
    }
    if (session.lastReviewedHead === headSha) {
      return { mode: 'noop_ready', previousHead: session.lastReviewedHead, reason: 'current HEAD is already READY' };
    }
    return session.auditCompleted === true && !session.override
      ? { mode: 'incremental_candidate', previousHead: session.lastReviewedHead, reason: 'classify new delta before deciding review scope' }
      : { mode: 'discovery', previousHead: null, reason: 'no reusable full-audit baseline' };
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

  // The model reported it could not cover every changed file. Never READY; a new
  // HEAD starts a fresh bounded discovery, the same HEAD waits for a manual re-run.
  if (session.status === 'PARTIAL') {
    // A manual `@gemini review` / `@claude review` continues with the files not yet covered.
    if (session.lastReviewedHead === headSha && retryUnavailable) {
      return { mode: 'claude', previousHead: null, reason: 'continue the partial review with the files not yet covered' };
    }
    return session.lastReviewedHead === headSha
      ? { mode: 'noop_waiting', previousHead: session.lastReviewedHead, reason: 'review coverage was partial; comment `@claude review` to cover the remaining files' }
      : { mode: 'discovery', previousHead: null, reason: 'new HEAD after partial-coverage review; run a fresh bounded review' };
  }

  if (session.status === 'HUMAN_REQUIRED') {
    // Changed code can trigger fresh discovery for uncertain-only sessions.
    // The exact unmodified HEAD still requires scoped, evidence-based adjudication.
    if (session.lastReviewedHead !== headSha
        && unresolvedMaterialFindings(session).length > 0
        && !session.findings.some(f => f.status === 'OPEN' && MATERIAL_SEVERITIES.has(f.severity))) {
      return { mode: 'discovery', previousHead: null, reason: 'new HEAD after unresolved material candidate; run a fresh full review' };
    }
    // Only an explicit manual retry can resume a provider-unavailable stop. Never
    // reopen ordinary human findings, verification exhaustion, or a moved HEAD.
    if (retryUnavailable && session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE') {
      const failedMode = session.reviewFailure.mode;
      const previousHead = session.reviewFailure.previousHead ?? null;
      // A moved HEAD makes the old audit/discovery/incremental context stale.
      // Verification may continue from the original pre-failure repair baseline.
      if (session.lastReviewedHead !== headSha) {
        if (failedMode === 'verification' && previousHead) {
          return { mode: 'verification', previousHead, reason: 'manually retry provider-unavailable verification on the latest HEAD' };
        }
        return { mode: 'discovery', previousHead: null, reason: 'manually review the latest HEAD after provider unavailability' };
      }
      return { mode: failedMode,
        previousHead: ['verification', 'incremental'].includes(failedMode) ? previousHead : null,
        reason: 'manually retry provider-unavailable review on the same HEAD' };
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

// A previously audited READY tree is the baseline. Retain all prior findings
// and the audit attestation; only new delta findings can block the new HEAD.
export function applyIncrementalResult({
  session, result, headSha, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  const retry = session.status === 'HUMAN_REQUIRED'
    && session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
    && session.reviewFailure.mode === 'incremental'
    && session.reviewFailure.head === headSha
    && session.reviewFailure.previousHead;
  if ((session.status !== 'READY' && !retry) || session.auditCompleted !== true || session.override) {
    throw new Error('incremental review requires an audited READY baseline or exact-HEAD provider retry');
  }
  if (session.lastReviewedHead === headSha && !retry) throw new Error('incremental review needs a changed HEAD');
  const normalized = normalizeReviewResult(result);
  const findings = session.findings.map((finding) => ({ ...finding }));
  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : findings.length + 1;
  for (const finding of normalized.findings) {
    findings.push({
      id: findingId(nextFindingNumber++),
      ...compactFinding(finding),
      status: MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED',
      origin: 'INCREMENTAL',
      introducedHead: headSha,
      lastCheckedHead: headSha,
      resolutionReason: null,
    });
  }
  const open = findings.some((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity));
  const { reviewFailure: _oldFailure, ...base } = session;
  return {
    ...base,
    lastReviewedHead: headSha,
    fullAuditHead: session.fullAuditHead ?? (retry ? session.reviewFailure.previousHead : session.lastReviewedHead),
    incrementalReviewCount: (session.incrementalReviewCount ?? 0) + 1,
    status: open ? 'REWORK' : 'READY',
    auditCompleted: true,
    verificationRound: 0,
    nextFindingNumber,
    findings,
    lastSummary: compactText(normalized.summary, 800),
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
    ? unresolvedMaterialFindings(session).length > 0 ? 'HUMAN_REQUIRED'
      : session.auditCompleted === true ? 'READY' : 'AUDIT_PENDING'
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
  const providerRetry = session.status === 'HUMAN_REQUIRED'
    && session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
    && session.reviewFailure?.mode === 'audit'
    && session.reviewFailure?.head === headSha;
  if (session.status !== 'AUDIT_PENDING' && !providerRetry) throw new Error('final audit requires AUDIT_PENDING session');
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
    fullAuditHead: headSha,
    incrementalReviewCount: 0,
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

// Fallback has NO separate $3 pool. Only automated calls obey the shared $6
// cap; a human-triggered review gets a fresh bounded $2 budget per Claude call.
export function claudeFallbackBudgetLeft(session) {
  return deepReviewBudgetLeft(session);
}

// Only an authenticated PR comment explicitly requesting a review may exceed
// the automatic cap. A dismiss/override command is human-initiated, but it is
// NOT authorization to spend beyond the limit during its follow-on audit.
export function isManualBudgetExemptReview({ sourceKind, requestedMode } = {}) {
  return sourceKind === 'comment' && ['auto', 'reset', 'claude'].includes(requestedMode);
}

export function claudeFallbackCallBudget(session, { manual = false, pendingUsd = 0 } = {}) {
  return manual ? DEEP_REVIEW_MANUAL_RUN_BUDGET_USD
    : Math.max(0, roundUsd(claudeFallbackBudgetLeft(session) - nonNegative(pendingUsd)));
}

export function chargeClaudeFallback(session, costUsd, costSource = 'sdk') {
  validateSession(session);
  if (!['sdk', 'reserve'].includes(costSource)) throw new Error('unknown Claude cost source');
  const amount = nonNegative(costUsd);
  const fallbackSpent = Number.isFinite(session.fallbackSpendUsd)
    ? session.fallbackSpendUsd : (session.deepSpendUsd ?? 0);
  return {
    ...session,
    deepSpendUsd: roundUsd((session.deepSpendUsd ?? 0) + amount),
    fallbackSpendUsd: roundUsd(fallbackSpent + amount),
    claudeSdkSpendUsd: roundUsd((session.claudeSdkSpendUsd ?? 0) + (costSource === 'sdk' ? amount : 0)),
    claudeUnknownReserveUsd: roundUsd((session.claudeUnknownReserveUsd ?? 0) + (costSource === 'reserve' ? amount : 0)),
  };
}

// No model response was published. Preserve the existing finding ledger and
// report HUMAN_REQUIRED for the attempted HEAD without pretending it passed.
export function stopUnavailableReviewSession({
  session = null, baseSha, headSha, sourceCommentId, mode, reason,
  spentUsd = 0, costSource = 'reserve', costCharges = null, now = new Date().toISOString(),
} = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');
  if (!['discovery', 'verification', 'incremental', 'audit'].includes(mode)) throw new Error('invalid failed review mode');
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
      ...(['verification', 'incremental'].includes(mode) ? { previousHead: base.reviewFailure?.previousHead ?? base.lastReviewedHead } : {}),
      reason: explanation,
    },
    lastSummary: `Automatic ${mode} review incomplete: ${explanation}`,
    updatedAt: now,
  };
  const charges = Array.isArray(costCharges) && costCharges.length
    ? costCharges : [{ amount: spentUsd, source: costSource }];
  return charges.reduce((state, charge) => chargeClaudeFallback(state, charge.amount, charge.source), stopped);
}

// `@claude review` is a reviewer in its own right. When this exact HEAD has no session it
// starts a standalone one, so Claude and Gemini run as parallel reviewers instead of
// Claude gating on a Gemini session. Spend carries over from any earlier session.
function seedStandaloneSession({ previous, baseSha, headSha, now }) {
  const seed = applyDiscoveryResult({ result: { summary: 'Claude review started', findings: [] }, baseSha, headSha, sourceCommentId: 'claude', now });
  const spend = {};
  for (const key of ['deepSpendUsd', 'fallbackSpendUsd', 'claudeSdkSpendUsd', 'claudeUnknownReserveUsd']) {
    if (Number.isFinite(previous?.[key]) && previous[key] > 0) spend[key] = previous[key];
  }
  return { ...seed, ...spend };
}

export function beginDeepReview({
  session = null, baseSha, headSha, runId = null, reserveUsd = 0, standalone = false, now = new Date().toISOString(),
} = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');
  if (session) validateSession(session);
  let standaloneRun = false;
  if (!session || session.lastReviewedHead !== headSha) {
    if (!standalone) throw new Error('deep review requires an existing review session for this exact HEAD');
    session = seedStandaloneSession({ previous: session, baseSha, headSha, now });
    standaloneRun = true;
  }
  if (session.status === 'REVIEW_IN_PROGRESS' && !isDeepReviewStale(session, Date.parse(now))) {
    throw new Error('a deep review is already in progress for this HEAD');
  }
  // A stale in-progress marker is replaced; the status it interrupted is remembered.
  // A deep review that failed closed is the only reason for that HUMAN_REQUIRED (no findings,
  // no provider failure), so a retry resumes the status the failed run interrupted instead
  // of making the stop permanent.
  const retryingFailedRun = session.status === 'HUMAN_REQUIRED' && session.deepReview?.state === 'FAILED'
    && session.deepReview.head === headSha && !session.reviewFailure
    && openMaterialFindings(session).length === 0 && unresolvedMaterialFindings(session).length === 0;
  const resumeStatus = session.status === 'REVIEW_IN_PROGRESS' || retryingFailedRun
    ? (session.deepReview?.resumeStatus ?? 'AUDIT_PENDING') : session.status;
  const base = session;
  return {
    ...base,
    lastReviewedHead: headSha,
    status: 'REVIEW_IN_PROGRESS',
    // The run's allotted budget is charged up front and reconciled at finalize/fail, so a run
    // that is interrupted (new commit, kill, stale replacement) can never escape the PR cap.
    deepSpendUsd: roundUsd((session.deepSpendUsd ?? 0) + nonNegative(reserveUsd)),
    deepReview: { head: headSha, startedAt: now, runId: runId == null ? null : String(runId), resumeStatus, state: 'IN_PROGRESS', reservedUsd: nonNegative(reserveUsd), ...(standaloneRun || session.deepReview?.standalone === true ? { standalone: true } : {}) },
    updatedAt: now,
  };
}

const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function completeDeepReview({
  session, result, headSha, spentUsd = 0, costSource = 'sdk', now = new Date().toISOString(),
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
  const providerRecovery = resume === 'HUMAN_REQUIRED'
    && session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
    && session.reviewFailure?.head === headSha;
  const coverage = normalizeCoverage(result.coverage);
  // A standalone Claude session has no Gemini audit; a complete Claude pass is its full review.
  const standalone = session.deepReview?.standalone === true;
  const status = open.length > 0
    ? verificationRound >= MAX_VERIFICATION_ROUNDS ? 'HUMAN_REQUIRED' : 'REWORK'
    : unresolvedMaterialFindings(session).length > 0 ? 'HUMAN_REQUIRED'
      : coverage && !coverage.complete ? 'PARTIAL'
      : resume === 'HUMAN_REQUIRED' && !providerRecovery ? 'HUMAN_REQUIRED'
      : session.auditCompleted === true || standalone ? 'READY' : 'AUDIT_PENDING';
  const completed = {
    ...session,
    ...reconcileDeepSpend(session, spentUsd, costSource),
    status,
    findings,
    nextFindingNumber,
    deepReview: { ...session.deepReview, state: 'COMPLETE', completedAt: now },
    lastSummary: compactText(normalized.summary, 800),
    updatedAt: now,
  };
  if (providerRecovery) delete completed.reviewFailure;
  if (standalone && status === 'READY') completed.auditCompleted = true;
  // A complete pass clears an earlier partial record; a partial one is kept so the
  // comment can name exactly what no reviewer has seen yet.
  if (coverage && !coverage.complete) completed.coverage = { ...coverage, head: headSha };
  else delete completed.coverage;
  return completed;
}

// Absent coverage means a legacy result that predates the field and is treated as
// complete; run-review.mjs always supplies it for new deep reviews.
function normalizeCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const unreviewed = Array.isArray(value.unreviewedPaths)
    ? [...new Set(value.unreviewedPaths.filter((p) => typeof p === 'string' && p).map((p) => compactText(p, 200)))]
    : [];
  const complete = value.complete === true && unreviewed.length === 0;
  return {
    complete,
    unreviewedCount: unreviewed.length,
    unreviewedPaths: unreviewed.slice(0, MAX_UNREVIEWED_PATHS),
    reviewedKeys: Array.isArray(value.reviewedPaths)
      ? [...new Set(value.reviewedPaths.filter((p) => typeof p === 'string' && p).map(pathKey))].slice(0, MAX_REVIEWED_KEYS)
      : [],
    ...(value.note ? { note: compactText(value.note, 300) } : {}),
  };
}

export function failDeepReview({
  session, headSha, reason, spentUsd = 0, costSource = 'reserve', now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (session.status !== 'REVIEW_IN_PROGRESS' || session.lastReviewedHead !== headSha) {
    throw new Error('failed deep review does not match the in-progress session HEAD');
  }
  return {
    ...session,
    ...reconcileDeepSpend(session, spentUsd, costSource),
    status: 'HUMAN_REQUIRED',
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
    case 'READY': return session.auditCompleted !== true || openMaterialFindings(session).length > 0
      || unresolvedMaterialFindings(session).length > 0
      ? { state: 'error', description: 'Review evidence incomplete or material candidates unresolved' }
      : { state: 'success', description: 'Independent review complete: READY' };
    case 'REVIEW_IN_PROGRESS': return { state: 'pending', description: 'Claude deep review in progress' };
    case 'AUDIT_PENDING': return { state: 'pending', description: 'Final audit pending' };
    case 'REWORK': return { state: 'failure', description: 'Open material findings: rework needed' };
    case 'PARTIAL': return { state: 'error', description: 'Review coverage partial: some changed files were not reviewed' };
    default: return { state: 'error', description: 'Automatic review stopped: human judgment required' };
  }
}

function reconcileSpend(session, actualUsd) {
  const reserved = nonNegative(session.deepReview?.reservedUsd);
  return roundUsd(Math.max(0, (session.deepSpendUsd ?? 0) - reserved + nonNegative(actualUsd)));
}

function reconcileDeepSpend(session, actualUsd, costSource) {
  if (!['sdk', 'reserve'].includes(costSource)) throw new Error('unknown Claude cost source');
  const amount = nonNegative(actualUsd);
  return {
    deepSpendUsd: reconcileSpend(session, amount),
    claudeSdkSpendUsd: roundUsd((session.claudeSdkSpendUsd ?? 0) + (costSource === 'sdk' ? amount : 0)),
    claudeUnknownReserveUsd: roundUsd((session.claudeUnknownReserveUsd ?? 0) + (costSource === 'reserve' ? amount : 0)),
  };
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundUsd(value) {
  return Math.round(value * 10000) / 10000;
}

// ---- Known-issue ledger -------------------------------------------------
// Only evidence-backed REJECTED candidates enter this deduplication ledger.
// Material UNCERTAIN candidates must never be suppressed or called resolved.

export function recordDismissed(session, validations, headSha) {
  validateSession(session);
  const added = [];
  for (const entry of Array.isArray(validations) ? validations : []) {
    const verdict = String(entry?.verdict ?? '').toUpperCase();
    if (verdict !== 'REJECTED') continue;
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
  const dismissed = (session?.dismissed ?? []).filter(item => item.verdict === 'REJECTED').map((item) => ({
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
    ...(session?.dismissed ?? []).filter(item => item.verdict === 'REJECTED'),
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
  if (!item || !['OPEN', 'UNCERTAIN'].includes(item.status) || !MATERIAL_SEVERITIES.has(item.severity)) {
    throw new Error('dismissal finding must be an OPEN or UNCERTAIN material candidate');
  }
  const findings = session.findings.map((finding) => finding.id === findingId
    ? {
      ...finding, status: 'DISMISSED', lastCheckedHead: headSha,
      resolutionReason: compactText('Dismissed by @' + by + ': ' + explanation, 300),
      dismissal: { by, at: now, head: headSha, sourceCommentId: String(sourceCommentId),
        reason: explanation, evidence: [...evidence] },
    }
    : { ...finding });
  const remaining = findings.filter(finding =>
    ['OPEN', 'UNCERTAIN'].includes(finding.status) && MATERIAL_SEVERITIES.has(finding.severity)).length;
  const status = remaining
    ? findings.some(f => f.status === 'OPEN') ? 'REWORK' : 'HUMAN_REQUIRED'
    : session.auditCompleted === true ? 'READY' : 'AUDIT_PENDING';
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
    if (!['OPEN', 'UNCERTAIN'].includes(finding.status)) return { ...finding };
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

// A person resolving the bot's review thread for a finding is a decision about that finding, so it closes
// it without another review; unresolving the thread reopens it. Closing the last blocking finding on a
// session that was waiting on findings makes the current HEAD READY by that person's decision (recorded as
// an override, so it is never reused as an audited baseline), unless files are still unreviewed (PARTIAL).
// `closed` is [{ id, by }] for threads a writer resolved; `reopened` is finding ids whose thread was unresolved.
export function applyThreadDecisions({ session, headSha, closed = [], reopened = [], now = new Date().toISOString() } = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (session.status === 'REVIEW_IN_PROGRESS') throw new Error('a review is running; thread decisions wait for it');
  const findings = session.findings.map((finding) => ({ ...finding }));
  const closedBy = new Map();
  for (const { id, by } of closed) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(by ?? ''))) continue;
    const finding = findings.find((item) => item.id === id);
    if (!finding || !['OPEN', 'UNCERTAIN', 'DEFERRED'].includes(finding.status)) continue;
    finding.status = 'WAIVED';
    finding.resolvedVia = 'thread';
    finding.resolvedBy = by;
    finding.lastCheckedHead = headSha;
    finding.resolutionReason = compactText(`Resolved by @${by} (review thread)`, 300);
    closedBy.set(id, by);
  }
  const reopenedIds = [];
  for (const id of reopened) {
    const finding = findings.find((item) => item.id === id);
    if (!finding || finding.status !== 'WAIVED' || finding.resolvedVia !== 'thread') continue;
    finding.status = MATERIAL_SEVERITIES.has(finding.severity) ? 'OPEN' : 'DEFERRED';
    delete finding.resolvedVia;
    delete finding.resolvedBy;
    finding.resolutionReason = null;
    finding.lastCheckedHead = headSha;
    reopenedIds.push(id);
  }
  if (!closedBy.size && !reopenedIds.length) return session;

  let next = { ...session, findings, updatedAt: now };
  const blocking = findings.some((finding) => MATERIAL_SEVERITIES.has(finding.severity) && ['OPEN', 'UNCERTAIN'].includes(finding.status));
  const unreviewed = session.coverage?.complete === false && session.coverage.head === session.lastReviewedHead;
  if (closedBy.size && !blocking && !session.reviewFailure && ['REWORK', 'HUMAN_REQUIRED'].includes(session.status)) {
    const by = [...new Set(closedBy.values())];
    next = unreviewed
      ? { ...next, status: 'PARTIAL', lastSummary: compactText(`Findings resolved by @${by.join(', @')}; some files are still unreviewed.`, 800) }
      : {
        ...next,
        status: 'READY',
        auditCompleted: true,
        lastReviewedHead: headSha,
        override: { by: by[0], at: now, head: headSha, waived: [...closedBy.keys()], via: 'review thread' },
        lastSummary: compactText(`Open findings resolved by @${by.join(', @')} via review threads; HEAD not re-reviewed.`, 800),
      };
  } else if (reopenedIds.length && blocking && next.status === 'READY') {
    const { override, ...rest } = next;
    next = { ...rest, status: 'REWORK', ...(override?.via === 'review thread' ? {} : { override }), lastSummary: compactText('A resolved review thread was reopened; a finding is open again.', 800) };
  }
  return next;
}

export function openMaterialFindings(session) {
  validateSession(session);
  return session.findings.filter((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity));
}

export function unresolvedMaterialFindings(session) {
  return (session?.findings ?? []).filter(finding => finding.status === 'UNCERTAIN'
    && MATERIAL_SEVERITIES.has(finding.severity));
}

// The validator already performs a bounded, targeted evidence check. An
// inconclusive material candidate is a durable blocker, not a confirmed defect.
export function recordUncertainFindings(session, validations, headSha, mode, previousSession = null) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  if (!['discovery', 'incremental', 'audit'].includes(mode)) throw new Error('invalid uncertain review mode');
  const checked = Array.isArray(validations) ? validations : [];
  const uncertain = checked.filter(entry =>
    entry?.verdict === 'UNCERTAIN' && MATERIAL_SEVERITIES.has(entry.severity));
  // A fresh Discovery (after new code OR an explicit reset) must not erase
  // a prior inconclusive P2 just because the model failed to repeat it.
  // Only a new targeted CONFIRMED or REJECTED verdict for the *same*
  // candidate establishes enough evidence to replace it.
  const prior = mode === 'discovery'
    ? unresolvedMaterialFindings(previousSession)
    : [];
  const key = entry => String(entry?.path ?? '').trim().toLowerCase()
    + '\0' + String(entry?.title ?? '').trim().toLowerCase();
  const resolved = new Set(checked.filter(entry =>
    ['CONFIRMED','REJECTED'].includes(entry?.verdict)).map(key));
  const repeated = new Set(uncertain.map(key));
  const carried = prior.filter(entry => !resolved.has(key(entry)) && !repeated.has(key(entry)));
  const count = uncertain.length + carried.length;
  if (!count) return session;
  if (session.findings.length + count > 64) {
    throw new Error('too many unresolved material candidates to persist safely');
  }
  const findings = [...session.findings];
  let nextFindingNumber = session.nextFindingNumber ?? findings.length + 1;
  for (const entry of uncertain) {
    findings.push({
      id: findingId(nextFindingNumber++),
      severity: entry.severity,
      title: compactText(entry.title || 'Unresolved material candidate', 140),
      body: compactText(entry.reason || 'Targeted validation did not establish a verdict.', 450),
      path: compactText(entry.path || 'unknown', 240),
      line: Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null,
      riskClass: compactText(entry.riskClass || 'unresolved-validation', 60),
      origin: 'VALIDATOR_UNCERTAIN',
      candidateId: compactText(entry.candidateId || '?', 16),
      status: 'UNCERTAIN',
      introducedHead: headSha,
      lastCheckedHead: headSha,
      resolutionReason: null,
    });
  }
  for (const entry of carried) {
    findings.push({
      ...entry,
      id: findingId(nextFindingNumber++),
      origin: 'CARRIED_UNCERTAIN',
      status: 'UNCERTAIN',
      // This prior concern has not been verified on the new HEAD.
      lastCheckedHead: entry.lastCheckedHead ?? previousSession.lastReviewedHead,
      resolutionReason: null,
    });
  }
  const confirmedOpen = findings.some(f => f.status === 'OPEN' && MATERIAL_SEVERITIES.has(f.severity));
  const status = confirmedOpen && (session.verificationRound ?? 0) < MAX_VERIFICATION_ROUNDS
    ? 'REWORK' : 'HUMAN_REQUIRED';
  return {
    ...session,
    findings,
    nextFindingNumber,
    status,
    auditCompleted: mode === 'audit' ? false : session.auditCompleted,
    lastSummary: compactText(session.lastSummary + ' | ' + count
      + ' unresolved material candidate(s), including ' + carried.length
      + ' carried from earlier HEAD, require evidence-based review.', 800),
  };
}

export function renderSessionComment(session, { sourceCommentIds = [] } = {}) {
  validateSession(session);
  const open = openMaterialFindings(session);
  const unresolved = unresolvedMaterialFindings(session);
  const verification = `${session.verificationRound ?? 0}/${session.maxVerificationRounds ?? MAX_VERIFICATION_ROUNDS}`;
  const audit = session.auditCompleted === true ? 'complete' : session.status === 'AUDIT_PENDING' ? 'pending' : 'not run';
  const next = session.reviewFailure?.code === 'REVIEWER_UNAVAILABLE'
    ? 'Provider review did not complete. Comment `@gemini review` to retry the latest HEAD, or `@claude review` for an existing exact-HEAD session. A manual request bypasses the automatic $6 cap but not provider quota or the $5 per-call ceiling.'
    : unresolved.length > 0
    ? 'Inconclusive material candidate(s): inspect the cited code. If disproven, use `@gemini dismiss F001` with Reason and Evidence links; otherwise fix and push for a fresh review. Manual override explicitly accepts risk.'
    : session.status === 'PARTIAL'
    ? 'Some changed files were NOT reviewed (listed above), so this HEAD is not READY. Comment `@claude review` to cover them, or split the PR.'
    : session.status === 'READY'
    ? 'Review is clear on this HEAD; confirm separate CI checks and GitHub merge requirements before merging.'
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
  const threadLines = session.findings
    .filter((finding) => finding.status === 'WAIVED' && finding.resolvedVia === 'thread')
    .slice(-6)
    .map((finding) => '- ' + finding.id + ' resolved by @' + cleanInline(finding.resolvedBy ?? 'unknown'));
  const findingLines = [
    ...open.slice(0, 8).flatMap(finding => [
      `- ${finding.id} **${finding.severity}** — ${cleanInline(finding.title)}`,
      `  - ${cleanInline(finding.path)}${finding.line ? `:${finding.line}` : ''} — ${cleanInline(finding.body).slice(0, 800)}`,
    ]),
    ...unresolved.slice(0, 8).flatMap(finding => [
      `- ${finding.id} **${finding.severity} · UNCERTAIN (not confirmed)** — ${cleanInline(finding.title)}`,
      `  - ${cleanInline(finding.path)}${finding.line ? `:${finding.line}` : ''} — ${cleanInline(finding.body).slice(0, 800)}`,
    ]),
  ];
  if (!findingLines.length) findingLines.push('- none');
  const state = encodeSessionState(session);
  const processedMarkers = [...new Set(sourceCommentIds.map(String).filter((id) => /^[1-9]\d*$/.test(id)))]
    .slice(-8)
    .map((id) => `<!-- jiaze-review-source-comment:${id} -->`);
  return [
    '<!-- jiaze-review-session:v1 -->',
    ...processedMarkers,
    '### Independent Review Session',
    `Status: **${session.status}**${session.override ? (session.override.via === 'review thread' ? ` (findings resolved by @${cleanInline(session.override.by)} via review threads; this HEAD was not re-reviewed)` : ` (manually overridden by @${cleanInline(session.override.by)})`) : ''}`,
    `Default reviewer: **Gemini Flash (latest) / medium thinking**`,
    `Discovery: **${session.reviewFailure?.mode === 'discovery' ? 'not completed' : 'complete'}** · Final audit: **${audit}** · Verification: **${verification}**`,
    ...(session.incrementalReviewCount ? [`Incremental reviews since full audit: **${session.incrementalReviewCount}** (full-audit HEAD: ${cleanInline((session.fullAuditHead ?? session.discoveryHead ?? '').slice(0, 12))})`] : []),
    `Open confirmed material findings: **${open.length}**`,
    `Unresolved material candidates: **${unresolved.length}**`,
    ...(session.reviewFailure ? [`Review stopped: **${cleanInline(session.reviewFailure.mode)}** · ${cleanInline(session.reviewFailure.reason)}`] : []),
    ...(session.deepSpendUsd > 0 ? [`Claude charged ledger (SDK cost + conservative reserves): **${session.deepSpendUsd.toFixed(2)}** · automatic per-PR cap ${DEEP_REVIEW_PR_BUDGET_USD.toFixed(2)} · automatic remaining ${deepReviewBudgetLeft(session).toFixed(2)}`] : []),
    ...(session.deepSpendUsd > 0 ? [`Cost breakdown: SDK-reported **${(session.claudeSdkSpendUsd ?? 0).toFixed(4)}** · unknown-usage reserve **${(session.claudeUnknownReserveUsd ?? 0).toFixed(4)}** · historical/unclassified **${Math.max(0, roundUsd(session.deepSpendUsd - (session.claudeSdkSpendUsd ?? 0) - (session.claudeUnknownReserveUsd ?? 0) - (session.deepReview?.state === 'IN_PROGRESS' ? session.deepReview.reservedUsd ?? 0 : 0))).toFixed(4)}**`] : []),
    `Automatic Claude budget remaining: **${claudeFallbackBudgetLeft(session).toFixed(2)}** of ${DEEP_REVIEW_PR_BUDGET_USD.toFixed(2)} per PR · manual review: up to ${DEEP_REVIEW_MANUAL_RUN_BUDGET_USD.toFixed(2)} per Claude call regardless of cumulative spend`,
    ...(session.coverage && !session.coverage.complete ? [
      `Review coverage: **PARTIAL** — ${session.coverage.unreviewedCount} changed file(s) not reviewed${session.coverage.note ? ` (${cleanInline(session.coverage.note)})` : ''}`,
      ...session.coverage.unreviewedPaths.map((p) => `  - \`${cleanInline(p).replace(/`/g, '')}\``),
      ...(session.coverage.unreviewedCount > session.coverage.unreviewedPaths.length ? [`  - …and ${session.coverage.unreviewedCount - session.coverage.unreviewedPaths.length} more`] : []),
    ] : []),
    '',
    ...findingLines,
    ...(dismissalLines.length ? ['', 'Human-dismissed findings (cited, not machine-verified):', ...dismissalLines] : []),
    ...(threadLines.length ? ['', 'Closed by people (review thread resolved):', ...threadLines] : []),
    '',
    `Next: ${next}`,
    '',
    '<sub>P3 findings are non-blocking. Verification covers open findings and new delta regressions. Audited unchanged code is reused after safe incremental reviews; high-risk deltas receive full review.</sub>',
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
  if (!['AUDIT_PENDING', 'READY', 'REWORK', 'HUMAN_REQUIRED', 'REVIEW_IN_PROGRESS', 'PARTIAL'].includes(session.status)) throw new Error('invalid review session status');
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
