// Only the first nonblank line is a command. Never trigger from a quotation,
// fenced example, Markdown list, or prose that happens to mention the bot.
// Up to three leading spaces are allowed; four spaces/a tab is Markdown code.
export function parseReviewTrigger(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
  if (typeof firstLine !== 'string') return null;

  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'auto' };
  }
  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+claude[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'claude' };
  }
  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+reset[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'reset' };
  }
  if (/^ {0,3}@jiaze-claude-review-bot[ \t]+override[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'override' };
  }
  // The workflow re-fetches the original issue comment for a reason and citations. (Resolving a review
  // thread is a separate path: see parseReviewThreadTrigger.)
  // `dismiss F001` may be followed by any free-text explanation: layout never decides whether a claim is read.
  if (/^ {0,3}@(gemini|jiaze-claude-review-bot)[ \t]+dismiss[ \t]+F[0-9]{3,}(?:[ \t]+\S.*)?[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'dismiss' };
  }
  // `accept F001 <risk and consequence>` rides the same route as `dismiss`: the owner says the finding is real
  // and accepts the risk. The apply step tells the two apart (see parseDismissalRequest `kind`).
  if (/^ {0,3}@(gemini|jiaze-claude-review-bot)[ \t]+accept[ \t]+F[0-9]{3,}(?:[ \t]+\S.*)?[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'dismiss' };
  }
  // Short forms: `@gemini review` (same as the bare bot command) and `@claude review`.
  if (/^ {0,3}@gemini[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'auto' };
  }
  if (/^ {0,3}@claude[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'claude' };
  }
  return null;
}

export function isReviewTrigger(body) {
  return parseReviewTrigger(body) !== null;
}

// Pushes (synchronize) deliberately do not start a review: a PR is reviewed when it opens and then again only
// on an explicit `@gemini review` / `@claude review`. A push does, however, mark an existing result as
// out of date ('stale': bookkeeping only, no model call) so a READY for an older commit is never read as current.
const AUTO_PR_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened']);

export function parseAutomaticPullRequestTrigger(event, payload) {
  if (event !== 'pull_request' || !payload || typeof payload !== 'object') return null;
  const isPush = payload.action === 'synchronize';
  if (!isPush && !AUTO_PR_ACTIONS.has(payload.action)) return null;

  const pr = payload.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  if (pr.state && pr.state !== 'open') return null;
  if (isPush) return pr.draft === true ? null : { requestedMode: 'stale', sourceKind: 'pull_request' };
  if (pr.draft === true && payload.action !== 'ready_for_review') return null;

  return { requestedMode: 'auto', sourceKind: 'pull_request' };
}

// A person resolving or reopening one of the bot's review threads is a decision about that finding. The
// webhook is only a nudge: the workflow reads the threads themselves, and checks that the resolver has write
// access, so this only filters out events that can never matter (the bot's own tidy-up, other actions).
export function parseReviewThreadTrigger(event, payload) {
  if (event !== 'pull_request_review_thread' || !payload || typeof payload !== 'object') return null;
  if (!['resolved', 'unresolved'].includes(payload.action)) return null;
  const sender = payload.sender;
  if (!sender?.login || sender.type === 'Bot' || /\[bot\]$/i.test(sender.login)) return null;
  if (!payload.pull_request?.number) return null;
  return { requestedMode: 'threads', sourceKind: 'pull_request' };
}

// Existing review-session markers require a positive decimal identifier. GitHub
// webhook deliveries use UUID-like IDs, so encode the delivery hex as decimal.
// The delivery, not the PR HEAD, defines trigger identity: returning to an old
// HEAD in a later review generation must remain a valid new event.
export function automaticSourceId(deliveryId) {
  const raw = String(deliveryId ?? '').trim();
  const hex = raw.replaceAll('-', '');
  if (!/^[0-9a-f]{16,64}$/i.test(hex)) throw new Error('Invalid GitHub webhook delivery id');
  const id = BigInt(`0x${hex}`).toString(10);
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid automatic review source id');
  return id;
}


const REPO_RELATIVE_EVIDENCE_RE = /^([^:#]+)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L(\d+))?)?$/;
const URL_SCHEME_RE = /^(?:https?|ftp|file|javascript|data|vbscript|mailto):/i;

/**
 * Validates a single dismissal evidence item: either a credential-free HTTPS URL
 * or a safe repo-relative path with optional `:line` / `:start-end` / `#Lline` / `#Lstart-Lend`.
 */
export function validateDismissalEvidence(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 500) {
    throw new Error('Evidence must be a credential-free HTTPS URL or a safe repo-relative path (max 500 chars)');
  }
  if (/[\s\x00-\x1f\x7f]/.test(raw) || raw.includes('\\')) {
    throw new Error('Evidence must not contain whitespace, backslashes, or control characters');
  }
  if (raw.includes('://') || URL_SCHEME_RE.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('Evidence must be a valid HTTPS URL or repo-relative path'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      throw new Error('Evidence must be a credential-free HTTPS URL (max 500 chars)');
    }
    return { kind: 'url', value: raw };
  }
  const match = raw.match(REPO_RELATIVE_EVIDENCE_RE);
  if (!match) {
    throw new Error('Evidence repo-relative path has invalid line anchor syntax');
  }
  const relPath = match[1];
  const segments = relPath.split('/');
  if (relPath.startsWith('/') || relPath === '.' || segments.some((seg) => !seg || seg === '..')) {
    throw new Error('Evidence repo-relative path must stay inside the repository without traversal or leading slash');
  }
  const startRaw = match[2] || match[4];
  const endRaw = match[3] || match[5];
  if (startRaw !== undefined) {
    const start = Number(startRaw);
    const end = endRaw !== undefined ? Number(endRaw) : start;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
      throw new Error('Evidence line range must use positive integers with end >= start');
    }
  }
  return { kind: 'path', value: raw, relPath };
}

// A person's claim about a finding, in their own words. It is an unverified claim, never a fact: the bot checks it
// against the code. Anything after `dismiss F001` is the claim (no Reason:/Evidence: layout, no minimum length).
// Evidence is whatever the text points at: credential-free HTTPS URLs and repository-relative paths (optionally
// with :line). A pointer that is unsafe or malformed is not trusted and is simply not used.
const ANCHOR = '(?::\\d+(?:-\\d+)?|#L\\d+(?:-L\\d+)?)';
const EVIDENCE_CANDIDATE_RE = new RegExp(
  'https?:\\/\\/[^\\s<>()\\[\\]"\'`]+'                                         // a link
  + '|(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+' + ANCHOR                           // dir/name with a line anchor
  + '|(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_-]+\\.[A-Za-z][A-Za-z0-9]{0,7}'           // dir/name.ext
  + '|\\b[A-Za-z0-9_-]+\\.[A-Za-z]{1,6}' + ANCHOR + '\\b', 'g');
export function extractEvidenceFromText(text) {
  const seen = [];
  for (const raw of String(text ?? '').match(EVIDENCE_CANDIDATE_RE) ?? []) {
    const candidate = raw.replace(/[.,;:]+$/, '');
    if (seen.includes(candidate) || seen.length >= 3) continue;
    try { validateDismissalEvidence(candidate); } catch { continue; }
    seen.push(candidate);
  }
  return seen;
}

// 'accepted' for `accept F001 ...`, 'dismissed' for `dismiss F001 ...`, null when the first line is neither.
export function dismissalCommandKind(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
  if (typeof firstLine !== 'string' || parseReviewTrigger(body)?.requestedMode !== 'dismiss') return null;
  return /^ {0,3}@(?:gemini|jiaze-claude-review-bot)[ \t]+accept[ \t]/i.test(firstLine) ? 'accepted' : 'dismissed';
}

export function parseDismissalRequest(body) {
  if (typeof body !== 'string' || body.length > 3000) throw new Error('Invalid dismissal comment length');
  const lines = body.split(/\r\n|\n|\r/);
  const index = lines.findIndex((line) => line.trim() !== '');
  const kind = dismissalCommandKind(body);
  if (index < 0 || !kind) {
    throw new Error('Expected a standalone @gemini dismiss F001 or @gemini accept F001 command');
  }
  const verb = kind === 'accepted' ? 'accept' : 'dismiss';
  const match = lines[index].match(new RegExp(`^ {0,3}@(gemini|jiaze-claude-review-bot)[ \\t]+${verb}[ \\t]+(F[0-9]{3,})(?:[ \\t]+(\\S.*?))?[ \\t]*$`, 'i'));
  if (!match) throw new Error('Invalid finding ' + (kind === 'accepted' ? 'acceptance' : 'dismissal') + ' command');
  const claim = [match[3] ?? '', ...lines.slice(index + 1)].join('\n').trim();
  const reason = claim.replace(/^(?:Reason|Evidence):[ \t]*/gim, '').slice(0, 1200).trim();
  if (kind === 'accepted' && !reason) {
    throw new Error('An acceptance needs your own words: what the risk is and what happens if it occurs.');
  }
  const request = { findingId: match[2].toUpperCase(), reason, evidence: extractEvidenceFromText(claim) };
  // `kind` is a plain field for an acceptance. For a dismissal it stays readable (`kind === 'dismissed'`) but is
  // not enumerable, so the shape every existing dismissal consumer and test sees is exactly what it was before.
  if (kind === 'accepted') request.kind = kind;
  else Object.defineProperty(request, 'kind', { value: kind, enumerable: false });
  return request;
}
