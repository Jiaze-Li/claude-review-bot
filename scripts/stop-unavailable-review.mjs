import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSessionComment, stopUnavailableReviewSession } from './review-session-core.mjs';
import { saveSessionComment } from './session-comment.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9]\d*$/;

function required(env, key, pattern) {
  const value = String(env[key] ?? '');
  if (!value || (pattern && !pattern.test(value))) throw new Error('Invalid ' + key);
  return value;
}

async function githubJson(url, token, fetchImpl, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub API failed (HTTP ' + response.status + ')');
  return response.json();
}

// Called only after a model step fails. Other errors have no marker, so an
// internal bug or authentication/preflight error cannot become HUMAN_REQUIRED
// and accidentally be treated as a successful review.
export async function stopUnavailableReview({ env = process.env, fetchImpl = fetch } = {}) {
  const root = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const markerPath = path.join(root, 'fallback-unavailable.json');
  if (!fs.existsSync(markerPath)) return { handled: false };
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'session-plan.json'), 'utf8'));
  const headSha = required(env, 'HEAD_SHA', SHA);
  const baseSha = required(env, 'BASE_SHA', SHA);
  const repo = required(env, 'TARGET_REPO', REPO);
  const pr = required(env, 'PR_NUMBER', NUMBER);
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID', NUMBER);
  const token = required(env, 'GH_TOKEN');
  if (!['incremental', 'verification'].includes(marker.mode)
      || marker.mode !== plan.decision?.mode || marker.headSha !== headSha) {
    throw new Error('Provider failure marker does not match the exact planned review');
  }
  const reason = String(marker.reason || 'Both model providers unavailable').slice(0, 240);
  const spentUsd = Number.isFinite(marker.spentUsd) && marker.spentUsd > 0 ? marker.spentUsd : 0;
  const costCharges = Array.isArray(marker.costCharges) ? marker.costCharges : null;
  const endpoint = 'https://api.github.com/repos/' + repo;
  const current = await githubJson(endpoint + '/pulls/' + pr, token, fetchImpl);
  if (current.head?.sha !== headSha || current.base?.sha !== baseSha) {
    throw new Error('PR moved before unavailable review could be recorded; refusing stale state');
  }
  const previous = plan.session;
  const duplicate = previous?.reviewFailure?.sourceCommentId === sourceCommentId
    && previous.reviewFailure?.head === headSha && previous.reviewFailure?.mode === marker.mode;
  const session = duplicate ? previous : stopUnavailableReviewSession({
    session: previous, baseSha, headSha, sourceCommentId, mode: marker.mode,
    reason, spentUsd, costCharges,
  });
  const body = renderSessionComment(session, { sourceCommentIds: [sourceCommentId] });
  const existingId = plan.sessionCommentId ? required({ id: String(plan.sessionCommentId) }, 'id', NUMBER) : null;
  const updated = { id: await saveSessionComment({
    target: repo, prNumber: pr, token, fetchImpl, existingId, previous, session, body,
  }) };
  if (!NUMBER.test(String(updated.id))) throw new Error('Invalid durable session comment ID');
  // Keep the exact-HEAD status authoritative even if publication races a push.
  const after = await githubJson(endpoint + '/pulls/' + pr, token, fetchImpl);
  if (after.head?.sha !== headSha || after.base?.sha !== baseSha) {
    throw new Error('PR moved while persisting provider failure; manual reconciliation required');
  }
  fs.writeFileSync(path.join(root, 'published-session.json'),
    JSON.stringify({ mode: marker.mode, session, sessionCommentId: String(updated.id) }, null, 2) + '\n',
    { mode: 0o600 });
  console.log('Provider-unavailable stop persisted as HUMAN_REQUIRED for HEAD ' + headSha);
  return { handled: true, session, sessionCommentId: String(updated.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await stopUnavailableReview(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
