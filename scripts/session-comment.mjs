// The ONE place a review session is written.
//
// The durable state is the bot's own readable records on the PR (a Receipt per handled command, then a closing
// Handoff, or a Run Start while a review runs); they are written FIRST. The "Independent Review Session" comment is
// only the PR's visible status summary built from that state: planners and the commit-status mirror rebuild the
// session from the records, never from this comment.
//
// The summary is posted as a NEW comment at the bottom of the conversation when the result changes (a different
// status, or a different HEAD reviewed) and the old one is removed. When nothing visible changed it is edited in
// place, so a review that only refines findings does not notify anyone again. REVIEW_IN_PROGRESS is a passing
// state: it is edited in place, and the finished result is compared with what the PR looked like before the run.

import { writeSessionRecords } from './session-store.mjs';

export function isMarkedStale(session) {
  return Boolean(session?.staleFor) && session.staleFor === session.lastReviewedHead;
}

export function visibleResultChanged(previous, next) {
  if (!previous) return false; // nothing to replace: it is created anyway
  if (next.status === 'REVIEW_IN_PROGRESS') return false;
  const running = previous.status === 'REVIEW_IN_PROGRESS';
  const baselineStatus = running ? (previous.deepReview?.resumeStatus ?? null) : previous.status;
  const baselineHead = running ? (previous.deepReview?.resumeHead ?? null) : (previous.lastReviewedHead ?? null);
  if (next.status !== baselineStatus || (next.lastReviewedHead ?? null) !== baselineHead) return true;
  // A push marking the result out of date (or a later review clearing the mark) changes what the PR shows.
  return !running && isMarkedStale(previous) !== isMarkedStale(next);
}

// The durable record of the session is the bot's own append-only records on the PR (see session-store.mjs); they
// are written FIRST, and only then is the editable summary comment refreshed. That summary is a projection for
// people: nothing reads it back to learn the session, so replacing it can never lose a fact.
//
// `ledger`: { botLogin, stage?, sourceCommentIds?, spendThisRun?, recordIds?, expectedSeq?, ... } — required, unless
// the caller says `projectionOnly` (only the summary changes and no review fact does).
// -> the id of the comment that now holds the summary (as a string)
export async function saveSessionComment({ target, prNumber, token, fetchImpl = fetch, existingId = null, previous = null, session, body, ledger = null, projectionOnly = false }) {
  if (!ledger && !projectionOnly) throw new Error('Saving a review session needs ledger options: the PR records are the durable state');
  if (ledger) {
    const written = await writeSessionRecords({ target, prNumber, token, fetchImpl, session, ...ledger });
    existingId = existingId ?? written.projectionId ?? null;
  }
  const root = `https://api.github.com/repos/${target}`;
  const post = () => request(`${root}/issues/${prNumber}/comments`, token, fetchImpl, { method: 'POST', body: JSON.stringify({ body }) });
  if (!existingId) return String((await post()).id);
  if (!visibleResultChanged(previous, session)) {
    return String((await request(`${root}/issues/comments/${existingId}`, token, fetchImpl, { method: 'PATCH', body: JSON.stringify({ body }) })).id);
  }
  const created = await post();
  try {
    await request(`${root}/issues/comments/${existingId}`, token, fetchImpl, { method: 'DELETE' }, true);
  } catch (error) {
    // The new comment is already the newest one, so the session is safe; an old copy left behind is only clutter.
    console.warn?.(`::warning::Could not remove the previous session comment: ${String(error.message).slice(0, 160)}`);
  }
  return String(created.id);
}

async function request(url, token, fetchImpl, init = {}, noBody = false) {
  if (!token) throw new Error('Missing GitHub token');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return noBody ? null : response.json();
}
