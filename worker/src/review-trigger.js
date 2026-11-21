// The only review triggers. Every accepted trigger means the same thing: "make sure the current HEAD has a review
// result". There are no modes and no per-trigger strategies; the runner decides whether a model run is needed.

// Only the first nonblank line is a command, so a quotation, fenced example or prose never triggers a review.
// Up to three leading spaces are allowed; four spaces or a tab is Markdown code.
export function parseReviewTrigger(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
  if (typeof firstLine !== 'string') return null;
  return /^ {0,3}@jiaze-claude-review-bot[ \t]+review[ \t]*$/i.test(firstLine) ? { sourceKind: 'comment' } : null;
}

// A non-draft PR is reviewed when it opens, becomes ready, reopens, or gets a new commit. Draft PRs never start one.
const AUTO_PR_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened', 'synchronize']);

export function parseAutomaticPullRequestTrigger(event, payload) {
  if (event !== 'pull_request' || !payload || typeof payload !== 'object') return null;
  if (!AUTO_PR_ACTIONS.has(payload.action)) return null;
  const pr = payload.pull_request;
  if (!pr || typeof pr !== 'object') return null;
  if (pr.state && pr.state !== 'open') return null;
  if (pr.draft === true) return null;
  return { sourceKind: 'pull_request' };
}

// GitHub webhook deliveries use UUID-like IDs; the workflow takes a positive decimal identifier for traceability.
export function automaticSourceId(deliveryId) {
  const raw = String(deliveryId ?? '').trim();
  const hex = raw.replaceAll('-', '');
  if (!/^[0-9a-f]{16,64}$/i.test(hex)) throw new Error('Invalid GitHub webhook delivery id');
  const id = BigInt(`0x${hex}`).toString(10);
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid automatic review source id');
  return id;
}
