const MATERIAL_SEVERITIES = new Set(['P0', 'P1', 'P2']);
export const SESSION_VERSION = 1;
export const MAX_VERIFICATION_ROUNDS = 2;

export function planReviewSession({ session = null, baseSha, headSha, reset = false } = {}) {
  checkedSha(baseSha, 'baseSha');
  checkedSha(headSha, 'headSha');

  if (reset || !session || session.version !== SESSION_VERSION || session.baseSha !== baseSha) {
    return { mode: 'discovery', previousHead: null, reason: reset ? 'explicit reset' : 'new review session' };
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
    ...finding,
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
    status: open.length ? 'REWORK' : 'READY',
    verificationRound: 0,
    maxVerificationRounds: MAX_VERIFICATION_ROUNDS,
    nextFindingNumber,
    findings,
    acceptedRiskClasses: [],
    lastSummary: normalized.summary,
    updatedAt: now,
  };
}

export function applyVerificationResult({
  session, result, headSha, now = new Date().toISOString(),
} = {}) {
  validateSession(session);
  checkedSha(headSha, 'headSha');
  const normalized = normalizeVerificationResult(result);
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
        resolutionReason: verdict.reason,
      };
    }
    return {
      ...finding,
      lastCheckedHead: headSha,
      resolutionReason: verdict.reason,
    };
  });

  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : findings.length + 1;
  for (const finding of normalized.findings) {
    findings.push({
      id: findingId(nextFindingNumber++),
      ...finding,
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
    ? 'READY'
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
    lastSummary: normalized.summary,
    updatedAt: now,
  };
}

export function openMaterialFindings(session) {
  validateSession(session);
  return session.findings.filter((finding) => finding.status === 'OPEN' && MATERIAL_SEVERITIES.has(finding.severity));
}

export function renderSessionComment(session) {
  validateSession(session);
  const open = openMaterialFindings(session);
  const verification = `${session.verificationRound ?? 0}/${session.maxVerificationRounds ?? MAX_VERIFICATION_ROUNDS}`;
  const next = session.status === 'READY'
    ? 'No action required unless the PR changes.'
    : session.status === 'REWORK'
      ? 'Push a repair, then comment `@jiaze-claude-review-bot review` again.'
      : 'Automatic review budget is exhausted. Use human judgment or a targeted Codex/Claude review; do not restart full discovery automatically.';
  const findingLines = open.length
    ? open.slice(0, 8).map((finding) => `- ${finding.id} **${finding.severity}** — ${cleanInline(finding.title)}`)
    : ['- none'];
  const state = encodeState(session);
  return [
    '<!-- jiaze-review-session:v1 -->',
    '### Independent Review Session',
    `Status: **${session.status}**`,
    `Default reviewer: **Gemini Flash / low thinking**`,
    `Discovery: **complete** · Verification: **${verification}**`,
    `Open material findings: **${open.length}**`,
    '',
    ...findingLines,
    '',
    `Next: ${next}`,
    '',
    '<sub>P3 findings are non-blocking. After discovery, verification is limited to existing findings and regressions directly caused by the repair.</sub>',
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
  const summary = checkedText(value.summary, 6000, 'summary');
  if (!Array.isArray(value.findings) || value.findings.length > 8) throw new Error('findings must be an array with at most 8 entries');
  return { summary, findings: value.findings.map(normalizeFinding) };
}

export function normalizeVerificationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification result must be an object');
  const summary = checkedText(value.summary, 6000, 'summary');
  if (!Array.isArray(value.verifications) || value.verifications.length > 16) throw new Error('verifications must be an array with at most 16 entries');
  if (!Array.isArray(value.findings) || value.findings.length > 5) throw new Error('repair findings must be an array with at most 5 entries');
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
  const severity = String(value.severity ?? '').trim().toUpperCase();
  if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) throw new Error('invalid finding severity');
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
  };
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) || session.version !== SESSION_VERSION) {
    throw new Error('invalid review session');
  }
  checkedSha(session.baseSha, 'session.baseSha');
  checkedSha(session.lastReviewedHead, 'session.lastReviewedHead');
  if (!['READY', 'REWORK', 'HUMAN_REQUIRED'].includes(session.status)) throw new Error('invalid review session status');
  if (!Array.isArray(session.findings) || session.findings.length > 64) throw new Error('invalid review session findings');
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

function encodeState(session) {
  const json = JSON.stringify(session);
  if (Buffer.byteLength(json, 'utf8') > 48_000) throw new Error('review session state exceeds 48KB');
  return Buffer.from(json, 'utf8').toString('base64url');
}
