import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findingKey, markerKey } from './review-anchors.mjs';
import { applyThreadDecisions, renderSessionComment } from './review-session-core.mjs';

// A person resolving the bot's review thread for a finding closes that finding; unresolving it reopens it.
// No model call. This reconciles the threads' current state with the session (rather than trusting a single
// event), so a missed or repeated event cannot leave them out of step. Only a repository writer's resolve
// counts, and only threads the bot started (first comment by the bot, carrying its finding marker).
const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved resolvedBy{login} comments(first:1){nodes{body author{login}}}}
    }
  }}
}`;

export async function applyThreadResolutions({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID');
  const token = required(env, 'GH_TOKEN');
  const botLogin = required(env, 'EXPECTED_REVIEW_AUTHOR').replace(/\[bot\]$/, '');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'threads' || !plan.session || !plan.sessionCommentId) {
    throw new Error('Thread decisions need an existing review session');
  }
  const session = plan.session;
  const [owner, repo] = target.split('/');

  const pr = await rest(`https://api.github.com/repos/${target}/pulls/${prNumber}`, token, fetchImpl);
  if (pr.base?.sha !== baseSha || pr.head?.sha !== headSha) throw new Error('PR moved before thread decisions; refusing stale update');

  const idsByKey = new Map();
  for (const finding of session.findings) {
    const key = findingKey(finding.path, finding.title);
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(finding);
  }

  const threads = await fetchThreads({ owner, repo, number: Number(prNumber), token, fetchImpl });
  const candidates = [];
  const reopened = [];
  for (const thread of threads) {
    const first = thread.comments?.nodes?.[0];
    if (!first || first.author?.login !== botLogin) continue;
    const findings = idsByKey.get(markerKey(first.body)) ?? [];
    if (!findings.length) continue;
    if (thread.isResolved) {
      const resolver = thread.resolvedBy?.login;
      if (!resolver || resolver === botLogin) continue; // the bot's own tidy-up is not a decision
      for (const finding of findings) candidates.push({ id: finding.id, by: resolver });
    } else {
      for (const finding of findings) if (finding.status === 'WAIVED' && finding.resolvedVia === 'thread') reopened.push(finding.id);
    }
  }

  const permissions = new Map();
  const closed = [];
  for (const candidate of candidates) {
    if (!permissions.has(candidate.by)) permissions.set(candidate.by, await isWriter({ target, login: candidate.by, token, fetchImpl }));
    if (permissions.get(candidate.by)) closed.push(candidate);
    else log.warn?.(`@${candidate.by} resolved a thread but does not have write access; ignoring it.`);
  }

  const next = applyThreadDecisions({ session, headSha, closed, reopened });
  if (next === session) {
    log.log?.('Review threads agree with the session; nothing to change.');
    return session;
  }
  const body = renderSessionComment(next, { sourceCommentIds: [sourceCommentId] });
  await rest(`https://api.github.com/repos/${target}/issues/comments/${plan.sessionCommentId}`, token, fetchImpl, { method: 'PATCH', body: JSON.stringify({ body }) });
  log.log?.(`Review-thread decisions applied: ${closed.length} closed, ${reopened.length} reopened; status ${next.status}.`);
  return next;
}

async function isWriter({ target, login, token, fetchImpl }) {
  try {
    const result = await rest(`https://api.github.com/repos/${target}/collaborators/${encodeURIComponent(login)}/permission`, token, fetchImpl);
    return ['admin', 'maintain', 'write'].includes(result.permission);
  } catch {
    return false;
  }
}

async function fetchThreads({ owner, repo, number, token, fetchImpl }) {
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'jiaze-review-bot' },
      body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, repo, number, after } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL failed (HTTP ${response.status})`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
    const connection = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error('GitHub returned no review threads for this pull request');
    threads.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return threads;
}

async function rest(url, token, fetchImpl, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
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
    await applyThreadResolutions();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
