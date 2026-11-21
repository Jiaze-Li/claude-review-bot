// Delivery v1 routing for the webhook Worker. Self-contained (the Worker bundle cannot import from scripts/);
// tests keep these constants identical to scripts/delivery-protocol.mjs.
export const DELIVERY_LABEL = 'delivery-v1';
export const DELIVERY_MARKER = '<!-- agent-delivery:v1 -->';

// Events the legacy parser never accepts but delivery-v1 does: the opt-in label being added to an open PR.
export function parseDeliveryLabelTrigger(event, payload) {
  if (event !== 'pull_request' || payload?.action !== 'labeled') return null;
  if (payload.label?.name !== DELIVERY_LABEL) return null;
  if (!payload.pull_request || (payload.pull_request.state && payload.pull_request.state !== 'open')) return null;
  return { requestedMode: 'auto', sourceKind: 'pull_request' };
}

export const hasDeliveryLabel = (pr) => (pr?.labels ?? []).some((label) => label?.name === DELIVERY_LABEL);

// Legacy-only controls. Once a PR is on delivery-v1 they can neither leave the mode nor reset its budget.
const LEGACY_ONLY_MODES = new Set(['reset', 'override', 'dismiss', 'threads']);

// -> { route: 'legacy' } | { route: 'ignore', reason } | { route: 'delivery', requestedMode }
// `hasState`: an async probe for a delivery state comment by the bot (only called when there is no label).
export async function routeDelivery({ trigger, pr, hasState }) {
  const delivery = hasDeliveryLabel(pr) || await hasState();
  if (!delivery) return { route: 'legacy' };
  if (LEGACY_ONLY_MODES.has(trigger.requestedMode)) {
    return { route: 'ignore', reason: 'delivery-v1 is fixed for this pull request; legacy review controls do not apply' };
  }
  // Every accepted trigger (open, ready, push, label, review command, provider command) means the same thing here:
  // "make sure the current HEAD has a result". The runner decides whether that needs a model run.
  return { route: 'delivery', requestedMode: 'auto' };
}

export async function hasDeliveryStateComment({ listComments, expectedReviewAuthor }) {
  for (let page = 1; page <= 100; page += 1) {
    const comments = await listComments(page);
    if (!Array.isArray(comments)) throw new Error('GitHub issue comments response was not an array');
    if (comments.some((comment) =>
      comment?.user?.login === expectedReviewAuthor
      && comment?.user?.type === 'Bot'
      && typeof comment.body === 'string'
      && comment.body.trimStart().startsWith(DELIVERY_MARKER))) return true;
    if (comments.length < 100) return false;
  }
  throw new Error('Pull request comment pagination exceeded safety limit');
}
