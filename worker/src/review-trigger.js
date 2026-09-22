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
  if (/^ {0,3}@claude[ \t]+review[ \t]*$/i.test(firstLine)) {
    return { requestedMode: 'claude' };
  }
  return null;
}

export function isReviewTrigger(body) {
  return parseReviewTrigger(body) !== null;
}

const AUTO_PR_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened', 'synchronize']);

export function parseAutomaticPullRequestTrigger(event, payload) {
  if (event !== 'pull_request' || !payload || typeof payload !== 'object') return null;
  if (!AUTO_PR_ACTIONS.has(payload.action)) return null;

  const pr = payload.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  if (pr.state && pr.state !== 'open') return null;
  if (pr.draft === true && payload.action !== 'ready_for_review') return null;

  return { requestedMode: 'auto', sourceKind: 'pull_request' };
}

// Existing review-session markers require a positive decimal identifier. For an
// automatic PR event, derive that identifier from the exact PR HEAD instead of
// inventing a comment. This makes all triggers for the same HEAD idempotent and
// gives every changed HEAD a distinct durable review trigger.
export function automaticSourceId(headSha) {
  const sha = String(headSha ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Invalid pull request HEAD SHA');
  const id = BigInt(`0x${sha}`).toString(10);
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid automatic review source id');
  return id;
}
