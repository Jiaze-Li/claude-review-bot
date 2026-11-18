// Reads EVERYTHING the ledger needs from one PR: issue comments, review bodies, and every comment of every review
// thread, page by page. Whenever a limit is hit while GitHub still says there is more, it reports `complete: false`
// instead of pretending the read finished.
import { LEDGER_LIMITS } from './review-ledger.mjs';

const NODE_FIELDS = 'databaseId createdAt lastEditedAt minimizedReason body author{login __typename}';
const PAGE = 'pageInfo{hasNextPage endCursor}';

const COMMENTS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  comments(first:${LEDGER_LIMITS.pageSize},after:$after){${PAGE} nodes{${NODE_FIELDS}}}}}}`;
const REVIEWS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  reviews(first:${LEDGER_LIMITS.pageSize},after:$after){${PAGE} nodes{${NODE_FIELDS}}}}}}`;
const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  reviewThreads(first:${LEDGER_LIMITS.pageSize},after:$after){${PAGE} nodes{id isResolved comments(first:${LEDGER_LIMITS.pageSize}){${PAGE} nodes{${NODE_FIELDS}}}}}}}}`;
const THREAD_MORE_QUERY = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{
  comments(first:${LEDGER_LIMITS.pageSize},after:$after){${PAGE} nodes{${NODE_FIELDS}}}}}}`;

async function graphql({ token, fetchImpl, query, variables }) {
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'jiaze-review-bot' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL failed (HTTP ${response.status})`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GitHub GraphQL error: ${String(body.errors[0]?.message ?? 'unknown').slice(0, 200)}`);
  return body.data;
}

const toRecord = (node, source, extra = {}) => ({
  id: String(node.databaseId), source, createdAt: node.createdAt, body: node.body ?? '',
  login: node.author?.login ?? null, type: node.author?.__typename ?? null,
  lastEditedAt: node.lastEditedAt ?? null, minimizedReason: node.minimizedReason ?? null, ...extra,
});

// -> { records, reads: { complete, problems } }. Network / permission / GraphQL errors REJECT (never "empty").
export async function fetchLedgerSources({ owner, repo, number, token, fetchImpl = fetch, limits = LEDGER_LIMITS }) {
  if (!token) throw new Error('Missing GitHub token for the review ledger');
  const problems = [];
  const records = [];
  const vars = { owner, repo, number };

  const paged = async (query, pick, max, label, source) => {
    let after = null; let count = 0;
    for (;;) {
      const data = await graphql({ token, fetchImpl, query, variables: { ...vars, after } });
      const connection = pick(data);
      if (!connection) throw new Error(`GitHub returned no ${label} for this pull request`);
      const nodes = connection.nodes ?? [];
      count += nodes.length;
      for (const node of nodes) if (node) records.push(toRecord(node, source));
      if (!connection.pageInfo?.hasNextPage) return;
      if (count >= max) { problems.push(`more than ${max} ${label}`); return; }
      after = connection.pageInfo.endCursor;
    }
  };
  await paged(COMMENTS_QUERY, (d) => d?.repository?.pullRequest?.comments, limits.maxIssueComments, 'conversation comments', 'issue');
  await paged(REVIEWS_QUERY, (d) => d?.repository?.pullRequest?.reviews, limits.maxReviews, 'reviews', 'review');

  let after = null; let threadCount = 0;
  for (;;) {
    const data = await graphql({ token, fetchImpl, query: THREADS_QUERY, variables: { ...vars, after } });
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error('GitHub returned no review threads for this pull request');
    for (const thread of connection.nodes ?? []) {
      threadCount += 1;
      const collected = [...(thread.comments?.nodes ?? [])];
      let info = thread.comments?.pageInfo;
      while (info?.hasNextPage && collected.length < limits.maxThreadComments) {
        const more = await graphql({ token, fetchImpl, query: THREAD_MORE_QUERY, variables: { id: thread.id, after: info.endCursor } });
        const next = more?.node?.comments;
        if (!next) throw new Error('GitHub returned no further comments for a review thread');
        collected.push(...(next.nodes ?? []));
        info = next.pageInfo;
      }
      if (collected.length > limits.maxThreadComments || info?.hasNextPage) problems.push(`review thread ${thread.id} has more than ${limits.maxThreadComments} comments`);
      for (const node of collected.slice(0, limits.maxThreadComments)) if (node) records.push(toRecord(node, 'thread', { threadId: thread.id, threadResolved: Boolean(thread.isResolved) }));
    }
    if (!connection.pageInfo?.hasNextPage) break;
    if (threadCount >= limits.maxThreads) { problems.push(`more than ${limits.maxThreads} review threads`); break; }
    after = connection.pageInfo.endCursor;
  }
  return { records, reads: { complete: problems.length === 0, problems } };
}
