import { beginDeepReview, completeDeepReview } from '../../scripts/review-session-core.mjs';

// What the sharded engine does to a session when it reviews every file of a HEAD: begin, then complete with the
// result and (unless a test says otherwise) complete coverage. The fixture for "a full review of this HEAD".
export function applyFullReview({ session, result, headSha, baseSha = 'b'.repeat(40), coverage = { complete: true, unreviewedPaths: [] }, now } = {}) {
  const begun = beginDeepReview({ session, baseSha, headSha, ...(now ? { now } : {}) });
  return completeDeepReview({ session: begun, result: { coverage, ...result }, headSha, ...(now ? { now } : {}) });
}
