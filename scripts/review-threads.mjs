// The bot's review threads, read and changed through GitHub's GraphQL API, and how they map to findings.
import { appendFileSync } from 'node:fs';
import { findingKey, markerKey } from './review-anchors.mjs';
import { isBlockingFinding } from './review-session-core.mjs';

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id path line isOutdated isResolved resolvedBy{login} comments(first:1){nodes{databaseId body author{login}}}}
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

// The blocking findings (P0-P2, or non-downgraded P3, open or uncertain), and whether every one of them has been resolved by a
// person in all of its threads. A blocking finding with no thread at all (posted in a review body) can never
// be claimed this way, so it keeps the session from counting as "all resolved".
export function blockingClaims({ session, byFinding, botLogin }) {
  const blocking = (session?.findings ?? []).filter((finding) => isBlockingFinding(finding) && ['OPEN', 'UNCERTAIN'].includes(finding.status));
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
  if (!response.ok) throw threadApiError(`GitHub GraphQL failed (HTTP ${response.status})`, response.status === 401 || response.status === 403);
  const payload = await response.json();
  if (payload.errors?.length) {
    const denied = payload.errors.some((e) => e.type === 'FORBIDDEN' || /resource not accessible|must have (admin|write)|forbidden/i.test(String(e.message)));
    throw threadApiError(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`, denied);
  }
  return payload.data;
}

// A refusal because the token may not do this at all (as opposed to one thread failing): it will repeat for every
// thread, so callers stop trying and report it as a permission problem. resolveReviewThread / unresolveReviewThread
// are reported to need the App's Contents permission as "write" besides Pull requests "write"; GitHub does not document it.
function threadApiError(message, permission) {
  const error = new Error(message);
  error.permissionDenied = permission;
  return error;
}

// Thread housekeeping trouble goes to the Actions log, an annotation and the Job Summary (never a PR comment) and
// never touches the review session.
export function reportThreadProblem({ env, log, heading, counts, errors = [], permissionDenied = false, warning }) {
  const lines = [`### ${heading}`, '', `- ${counts}`, ...errors.map((message) => `- GitHub said: ${message}`)];
  if (permissionDenied) {
    lines.push('', 'GitHub refused the thread change for this token. Resolving/reopening a review thread is reported to need the App\'s **Contents: Read and write** besides **Pull requests: Read and write** (this workflow\'s token has Contents: read).'
      + ' The review result itself is unaffected; threads can be resolved by hand. See the README for the one-time App setup.');
  }
  log.warn?.(`::warning title=${heading}::${warning} The review result is unaffected.`);
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`); } catch { /* summary is optional */ }
  }
}

const MAX_SESSION_FINDINGS = 64;
const MAX_OPEN_VERIFICATIONS = 16;

function compactOrphanText(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

// Reconstruct { severity, title, body, riskClass } from a bot-authored review thread's first comment.
// Returns null if the comment does not match the bot's own thread formats.
export function parseBotThreadBody(rawBody) {
  if (typeof rawBody !== 'string') return null;
  let text = rawBody.replace(/\s*<!--\s*jiaze-finding:[0-9a-f]{10}\s*-->\s*$/i, '').trimEnd();
  text = text.replace(/\n\n_Pinned to the nearest changed line:[^\n]*_\s*$/, '').trimEnd();
  let riskClass = 'uncategorized';
  const riskMatch = text.match(/\n\nRisk class:\s*([^\r\n]+)\s*$/);
  if (riskMatch) {
    riskClass = riskMatch[1].trim() || 'uncategorized';
    text = text.slice(0, riskMatch.index).trimEnd();
  }
  const header = text.match(/^\*\*\[(?:[A-Za-z0-9_-]+\s*·\s*)?(P[0-3])\]\s+([^\r\n]+?)\*\*\r?\n\r?\n([\s\S]*)$/);
  if (!header) return null;
  const severity = header[1];
  const title = header[2].trim();
  const body = header[3].trim() || title;
  if (!title) return null;
  return { severity, title, body, riskClass };
}

// Identify bot-authored review threads whose marker key is missing from the current session and that were
// not resolved by the bot itself. Non-bot threads are never read beyond checking the first author (I1).
export function findOrphanBotThreads({ session, threads, botLogin }) {
  const sessionKeys = new Set((session?.findings ?? []).map((f) => findingKey(f.path, f.title)));
  const orphans = [];
  let unrecognizable = 0;

  for (const thread of threads ?? []) {
    const first = thread?.comments?.nodes?.[0];
    if (!first || first.author?.login !== botLogin) continue;
    const key = markerKey(first.body);
    if (!key || sessionKeys.has(key)) continue;
    if (thread.isResolved && thread.resolvedBy?.login === botLogin) continue;

    const threadPath = typeof thread.path === 'string' ? thread.path.trim() : '';
    const validPath = Boolean(threadPath) && !threadPath.startsWith('/') && !threadPath.split('/').includes('..') && !threadPath.includes('\0');
    const parsed = validPath ? parseBotThreadBody(first.body) : null;
    if (!parsed || findingKey(threadPath, parsed.title) !== key) {
      unrecognizable += 1;
      continue;
    }

    orphans.push({
      threadId: thread.id,
      commentId: first.databaseId ?? null,
      key,
      path: threadPath,
      line: Number.isInteger(thread.line) && thread.line >= 1 ? thread.line : null,
      isOutdated: Boolean(thread.isOutdated),
      isResolved: Boolean(thread.isResolved),
      resolvedBy: thread.resolvedBy?.login ?? null,
      severity: parsed.severity,
      title: parsed.title,
      body: parsed.body,
      riskClass: parsed.riskClass,
    });
  }

  return { total: orphans.length + unrecognizable, orphans, unrecognizable };
}

// Adopt up to `maxAdopt` in-diff orphan findings into `session.findings` (P0-P2 before P3, preserving order),
// respecting the 64-finding session cap and the 16-entry verification cap without mutating `session.status` (I3).
export function adoptOrphanFindings({ session, orphans, diffPaths, headSha, maxAdopt = 8 }) {
  if (!session || typeof session !== 'object') {
    return { session: session ?? null, adoptedCount: 0, deferredCount: 0, outsideDiffCount: 0 };
  }
  const existingFindings = Array.isArray(session.findings) ? session.findings : [];
  const existingKeys = new Set(existingFindings.map((f) => findingKey(f.path, f.title)));
  const inDiff = [];
  let outsideDiffCount = 0;

  for (const orphan of orphans ?? []) {
    if (diffPaths && !diffPaths.has(orphan.path)) {
      outsideDiffCount += 1;
      continue;
    }
    if (existingKeys.has(orphan.key)) continue;
    existingKeys.add(orphan.key);
    inDiff.push(orphan);
  }

  const prioritized = [...inDiff].sort((a, b) => (MATERIAL.has(a.severity) ? 0 : 1) - (MATERIAL.has(b.severity) ? 0 : 1));
  const room = Math.max(0, MAX_SESSION_FINDINGS - existingFindings.length);
  const openCount = existingFindings.filter((f) => f.status === 'OPEN').length;
  const openRoom = Math.max(0, MAX_OPEN_VERIFICATIONS - openCount);
  const limit = Math.min(maxAdopt, room, openRoom);
  const toAdopt = prioritized.slice(0, limit);
  const deferredCount = prioritized.length - toAdopt.length;

  let nextFindingNumber = Number.isInteger(session.nextFindingNumber) ? session.nextFindingNumber : existingFindings.length + 1;
  const adopted = toAdopt.map((orphan) => ({
    id: `F${String(nextFindingNumber++).padStart(3, '0')}`,
    severity: orphan.severity,
    title: compactOrphanText(orphan.title, 140),
    body: compactOrphanText(orphan.body, 450),
    path: compactOrphanText(orphan.path, 240),
    line: orphan.line,
    riskClass: compactOrphanText(orphan.riskClass || 'uncategorized', 60),
    status: 'OPEN',
    origin: 'THREAD_ORPHAN',
    introducedHead: headSha,
    lastCheckedHead: session.lastReviewedHead,
    resolutionReason: null,
  }));

  return {
    session: {
      ...session,
      findings: [...existingFindings, ...adopted],
      nextFindingNumber,
    },
    adoptedCount: adopted.length,
    deferredCount,
    outsideDiffCount,
  };
}
