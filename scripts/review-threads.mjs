// The bot's review threads, read and changed through GitHub's GraphQL API, and how they map to findings.
import { findingKey, markerKey } from './review-anchors.mjs';

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved resolvedBy{login} comments(first:1){nodes{databaseId body author{login}}}}
    }
  }}
}`;
const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}';
const UNRESOLVE = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}';
const MATERIAL = new Set(['P0', 'P1', 'P2']);

export async function fetchReviewThreads({ owner, repo, number, token, fetchImpl }) {
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await graphql({ token, fetchImpl, query: THREADS_QUERY, variables: { owner, repo, number, after } });
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error('GitHub returned no review threads for this pull request');
    threads.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return threads;
}

export const resolveThread = ({ token, fetchImpl, id }) => graphql({ token, fetchImpl, query: RESOLVE, variables: { id } });
export const unresolveThread = ({ token, fetchImpl, id }) => graphql({ token, fetchImpl, query: UNRESOLVE, variables: { id } });

export async function replyToThread({ target, prNumber, commentId, body, token, fetchImpl }) {
  const response = await fetchImpl(`https://api.github.com/repos/${target}/pulls/${prNumber}/comments/${commentId}/replies`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub reply failed (HTTP ${response.status})`);
}

export async function isWriter({ target, login, token, fetchImpl }) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${target}/collaborators/${encodeURIComponent(login)}/permission`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return false;
    return ['admin', 'maintain', 'write'].includes((await response.json()).permission);
  } catch {
    return false;
  }
}

// Only threads the bot started (its marker in the first comment) belong to a finding.
// -> Map(finding id -> [{ id, commentId, isResolved, resolvedBy }])
export function threadsByFinding({ session, threads, botLogin }) {
  const idsByKey = new Map();
  for (const finding of session?.findings ?? []) {
    const key = findingKey(finding.path, finding.title);
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(finding.id);
  }
  const byFinding = new Map();
  for (const thread of threads) {
    const first = thread.comments?.nodes?.[0];
    if (!first || first.author?.login !== botLogin) continue;
    for (const id of idsByKey.get(markerKey(first.body)) ?? []) {
      if (!byFinding.has(id)) byFinding.set(id, []);
      byFinding.get(id).push({ id: thread.id, commentId: first.databaseId, isResolved: thread.isResolved, resolvedBy: thread.resolvedBy?.login ?? null });
    }
  }
  return byFinding;
}

// The blocking findings (P0-P2, open or uncertain), and whether every one of them has been resolved by a
// person in all of its threads. A blocking finding with no thread at all (posted in a review body) can never
// be claimed this way, so it keeps the session from counting as "all resolved".
export function blockingClaims({ session, byFinding, botLogin }) {
  const blocking = (session?.findings ?? []).filter((finding) => MATERIAL.has(finding.severity) && ['OPEN', 'UNCERTAIN'].includes(finding.status));
  const claimed = [];
  const unclaimed = [];
  for (const finding of blocking) {
    const threads = byFinding.get(finding.id) ?? [];
    const done = threads.length > 0 && threads.every((thread) => thread.isResolved && thread.resolvedBy && thread.resolvedBy !== botLogin);
    (done ? claimed : unclaimed).push(finding);
  }
  return { blocking, claimed, unclaimed, allClaimed: blocking.length > 0 && unclaimed.length === 0 };
}

async function graphql({ token, fetchImpl, query, variables }) {
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL failed (HTTP ${response.status})`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
  return payload.data;
}
