import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSessionComment } from './review-session-core.mjs';

export async function recoverReviewSession({ env = process.env, fetchImpl = fetch } = {}) {
  const target = required(env, 'TARGET_REPO');
  const parts = target.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid TARGET_REPO');
  const [owner, repo] = parts;
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const headSha = required(env, 'HEAD_SHA');
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('Invalid HEAD_SHA');
  const currentSourceId = required(env, 'SOURCE_COMMENT_ID');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'recover' || !plan.pendingSession) {
    throw new Error('Recovery requires a trusted pending session plan');
  }
  if (plan.pendingSession.lastReviewedHead !== headSha) {
    throw new Error('Pending session is not bound to the current HEAD');
  }

  const pr = await githubJson(
    'https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber,
    env.GH_TOKEN, fetchImpl,
  );
  if (pr.head?.sha !== headSha) {
    throw new Error('PR HEAD moved before pending session recovery; refusing stale recovery');
  }

  const sourceIds = [plan.pendingSourceCommentId, currentSourceId].filter(Boolean);
  const body = renderSessionComment(plan.pendingSession, { sourceCommentIds: sourceIds });
  const endpoint = plan.sessionCommentId
    ? 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/comments/' + plan.sessionCommentId
    : 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + prNumber + '/comments';
  const result = await githubJson(endpoint, env.GH_TOKEN, fetchImpl, {
    method: plan.sessionCommentId ? 'PATCH' : 'POST',
    body: JSON.stringify({ body }),
  });
  console.log('Recovered durable review session ' + result.id + ' from pending review ' + (plan.pendingReviewId || 'unknown') + '.');
  return { session: plan.pendingSession, sessionCommentId: String(result.id) };
}

async function githubJson(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('GitHub recovery API failed (HTTP ' + response.status + '): ' + text.slice(0, 500));
  }
  return response.json();
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing required environment variable: ' + key);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await recoverReviewSession();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
