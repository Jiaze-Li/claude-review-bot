import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyOverride, renderSessionComment } from './review-session-core.mjs';

// Manual override: a repository writer ends an unfinished review session.
// No model call. The write-permission check already happened in the Worker.
export async function applyManualOverride({ env = process.env, fetchImpl = fetch } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID');
  const by = required(env, 'TRIGGER_USER');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'override' || !plan.session || !plan.sessionCommentId) {
    throw new Error('Override requires an existing unfinished review session');
  }

  const pr = await github(`https://api.github.com/repos/${target}/pulls/${prNumber}`, env.GH_TOKEN, fetchImpl);
  if (pr.base?.sha !== baseSha || pr.head?.sha !== headSha) throw new Error('PR moved before override; refusing stale override');

  const session = applyOverride({ session: plan.session, headSha, by });
  const body = renderSessionComment(session, { sourceCommentIds: [sourceCommentId] });
  await github(`https://api.github.com/repos/${target}/issues/comments/${plan.sessionCommentId}`, env.GH_TOKEN, fetchImpl, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  console.log(`Manual override applied by @${by}; waived ${session.override.waived.length} finding(s); status READY.`);
  return session;
}

async function github(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await applyManualOverride();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
