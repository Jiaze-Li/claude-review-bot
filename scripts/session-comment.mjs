// The ONE place the durable review-session comment is written.
//
// The comment is the PR's visible review status, so when the result changes (a different status, or a different
// HEAD reviewed) it is posted as a NEW comment at the bottom of the conversation, where it is seen, and the old
// one is removed; the planner and the commit-status mirror always read the newest session comment. When nothing
// visible changed it is edited in place, so a review that only refines findings does not notify anyone again.
// REVIEW_IN_PROGRESS is a passing state: it is edited in place, and the finished result is compared with what the
// PR looked like before the run started.

export function visibleResultChanged(previous, next) {
  if (!previous) return false; // nothing to replace: it is created anyway
  if (next.status === 'REVIEW_IN_PROGRESS') return false;
  const running = previous.status === 'REVIEW_IN_PROGRESS';
  const baselineStatus = running ? (previous.deepReview?.resumeStatus ?? null) : previous.status;
  const baselineHead = running ? (previous.deepReview?.resumeHead ?? null) : (previous.lastReviewedHead ?? null);
  return next.status !== baselineStatus || (next.lastReviewedHead ?? null) !== baselineHead;
}

// -> the id of the comment that now holds the session (as a string)
export async function saveSessionComment({ target, prNumber, token, fetchImpl = fetch, existingId = null, previous = null, session, body }) {
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
