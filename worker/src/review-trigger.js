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
  if (/^ {0,3}@(gemini|jiaze-claude-review-bot)[ \t]+dismiss[ \t]+F[0-9]{3,}[ \t]*$/i.test(firstLine)) {
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

// Pushes (synchronize) deliberately do not review: a PR is reviewed when it opens
// and then again only on an explicit `@gemini review` / `@claude review`.
const AUTO_PR_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened']);

export function parseAutomaticPullRequestTrigger(event, payload) {
  if (event !== 'pull_request' || !payload || typeof payload !== 'object') return null;
  if (!AUTO_PR_ACTIONS.has(payload.action)) return null;

  const pr = payload.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  if (pr.state && pr.state !== 'open') return null;
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


// A human-attested decision, NOT an automatically verified external fact.
// Parse a strict small format and prevent unrelated prose from being evidence.
export function parseDismissalRequest(body) {
  if (typeof body !== 'string' || body.length > 3000) throw new Error('Invalid dismissal comment length');
  const lines = body.split(/\r\n|\n|\r/);
  const index = lines.findIndex((line) => line.trim() !== '');
  if (index < 0 || parseReviewTrigger(body)?.requestedMode !== 'dismiss') {
    throw new Error('Expected a standalone @gemini dismiss F001 command');
  }
  const match = lines[index].match(/^ {0,3}@(gemini|jiaze-claude-review-bot)[ \t]+dismiss[ \t]+(F[0-9]{3,})[ \t]*$/i);
  if (!match) throw new Error('Invalid finding dismissal command');
  let reason = null;
  const evidence = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) continue;
    const reasonMatch = line.match(/^Reason:[ \t]*(.+)$/i);
    const evidenceMatch = line.match(/^Evidence:[ \t]*(\S+)[ \t]*$/i);
    if (reasonMatch && reason === null) {
      reason = reasonMatch[1].trim();
    } else if (evidenceMatch) {
      const raw = evidenceMatch[1];
      let url;
      try { url = new URL(raw); } catch { throw new Error('Evidence must be a valid HTTPS URL'); }
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || raw.length > 500) {
        throw new Error('Evidence must be a credential-free HTTPS URL (max 500 chars)');
      }
      if (evidence.includes(raw)) throw new Error('Duplicate dismissal evidence URL');
      evidence.push(raw);
    } else {
      throw new Error('Dismissal requires exactly one Reason: line and 1-3 Evidence: URL lines');
    }
  }
  if (!reason || reason.length < 30 || reason.length > 400 || evidence.length < 1 || evidence.length > 3) {
    throw new Error('Dismissal requires a 30-400 character Reason and 1-3 Evidence URLs');
  }
  return { findingId: match[2].toUpperCase(), reason, evidence };
}
