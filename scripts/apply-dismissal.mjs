import { saveSessionComment } from './session-comment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyFindingDismissal, parseSessionComment, renderSessionComment } from './review-session-core.mjs';
import { parseDismissalRequest } from '../worker/src/review-trigger.js';

// No product-code mutation or model call. All user-origin facts are re-fetched
// from GitHub rather than trusted from a workflow_dispatch request.
export async function applyManualDismissal({ env = process.env, fetchImpl = fetch } = {}) {
  const repo = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  const sourceId = required(env, 'SOURCE_COMMENT_ID');
  if (!/^[1-9]\d*$/.test(prNumber) || !/^[1-9]\d*$/.test(sourceId)) {
    throw new Error('Invalid PR or source comment ID');
  }
  if (env.SOURCE_KIND !== 'comment') throw new Error('Dismissal requires a human PR comment');
  const by = required(env, 'TRIGGER_USER');
  const expectedAuthor = required(env, 'EXPECTED_REVIEW_AUTHOR');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('Invalid exact PR SHA');

  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'dismiss' || !plan.session || !/^[1-9]\d*$/.test(String(plan.sessionCommentId))) {
    throw new Error('Dismissal requires an existing unfinished durable session');
  }

  const root = 'https://api.github.com/repos/' + repo;
  const prUrl = root + '/pulls/' + prNumber;
  const proveHead = async () => {
    const pr = await github(prUrl, env.GH_TOKEN, fetchImpl);
    if (pr.state !== 'open' || pr.base?.sha !== baseSha || pr.head?.sha !== headSha) {
      throw new Error('PR moved or closed before finding dismissal');
    }
  };
  await proveHead();
  const source = await github(root + '/issues/comments/' + sourceId, env.GH_TOKEN, fetchImpl);
  if (String(source.id) !== sourceId
      || String(source.issue_url || '').toLowerCase() !== (root + '/issues/' + prNumber).toLowerCase()
      || String(source.user?.login || '').toLowerCase() !== by.toLowerCase()) {
    throw new Error('Dismissal source comment does not belong to this PR or actor');
  }
  const decision = parseDismissalRequest(source.body);
  const permission = await github(root + '/collaborators/' + encodeURIComponent(by) + '/permission', env.GH_TOKEN, fetchImpl);
  if (!['write', 'maintain', 'admin'].includes(permission.permission)) {
    throw new Error('Finding dismissal requires repository write permission');
  }

  // Reject a stale read: only the bot-authored, still-identical session may be
  // updated. The workflow also serializes all bot writes per target PR.
  const current = await github(root + '/issues/comments/' + plan.sessionCommentId, env.GH_TOKEN, fetchImpl);
  const durable = String(current.user?.login || '') === expectedAuthor ? parseSessionComment(current.body) : null;
  if (!durable || JSON.stringify(durable) !== JSON.stringify(plan.session)) {
    throw new Error('Durable review session changed since planning; refusing stale dismissal');
  }
  const session = applyFindingDismissal({
    session: durable, findingId: decision.findingId, headSha, by,
    reason: decision.reason, evidence: decision.evidence, sourceCommentId: sourceId,
  });
  await proveHead();
  const body = renderSessionComment(session, { sourceCommentIds: [sourceId] });
  const savedId = await saveSessionComment({
    target: repo, prNumber, token: env.GH_TOKEN, fetchImpl, existingId: plan.sessionCommentId, previous: durable, session, body,
  });

  // The ordinary auto-audit step consumes this same contract after either a
  // verification or an evidence-based dismissal reaches AUDIT_PENDING.
  fs.writeFileSync(path.join(contextRoot, 'published-session.json'), JSON.stringify({
    mode: 'dismiss', session, sessionCommentId: savedId,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('Human-evidenced dismissal recorded: ' + decision.findingId + '; status ' + session.status + '.');
  return session;
}

async function github(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
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
  if (!response.ok) throw new Error('GitHub dismissal API failed (HTTP ' + response.status + ')');
  return response.json();
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing ' + key);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await applyManualDismissal(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
