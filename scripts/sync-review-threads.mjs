import { pathToFileURL } from 'node:url';
import { findingKey, markerKey } from './review-anchors.mjs';
import { latestSession } from './sync-commit-status.mjs';

// Keeps the PR's review threads in step with the durable session: when a finding is FIXED, DISMISSED or
// WAIVED (an override), the inline thread the bot opened for it is resolved, so "unresolved threads" on
// the PR means "problems still open". Only threads the bot itself started, carrying its finding marker,
// are touched, and only in that one direction (a human's own resolve or unresolve is never undone).
// Best effort: a failure here must never fail a review.
const CLOSED = new Set(['FIXED', 'DISMISSED', 'WAIVED']);

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved comments(first:1){nodes{body author{login}}}}
    }
  }}
}`;
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}';

export async function syncReviewThreads({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const token = required(env, 'GH_TOKEN');
  const author = required(env, 'EXPECTED_REVIEW_AUTHOR');
  const botLogin = author.replace(/\[bot\]$/, '');
  const [owner, repo] = target.split('/');

  const session = await latestSession({ target, prNumber, author, token, fetchImpl });
  const closed = new Set((session?.findings ?? []).filter((finding) => CLOSED.has(finding.status)).map((finding) => findingKey(finding.path, finding.title)));
  if (!closed.size) return { resolved: 0, failed: 0, closed: 0 };

  const threads = await fetchThreads({ owner, repo, number: Number(prNumber), token, fetchImpl });
  let resolved = 0;
  let failed = 0;
  for (const thread of threads) {
    if (thread.isResolved) continue;
    const first = thread.comments?.nodes?.[0];
    if (!first || first.author?.login !== botLogin) continue;
    const key = markerKey(first.body);
    if (!key || !closed.has(key)) continue;
    try {
      await graphql({ token, fetchImpl, query: RESOLVE_MUTATION, variables: { id: thread.id } });
      resolved += 1;
    } catch (error) {
      failed += 1;
      log.warn?.(`Could not resolve a review thread: ${String(error.message).slice(0, 200)}`);
    }
  }
  log.log?.(`Review threads: ${resolved} resolved for closed findings${failed ? `, ${failed} could not be resolved` : ''}.`);
  return { resolved, failed, closed: closed.size };
}

async function fetchThreads({ owner, repo, number, token, fetchImpl }) {
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

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncReviewThreads();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
