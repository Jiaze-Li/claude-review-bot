// A small in-memory pull request for tests: its conversation comments, reviews and review threads, served through
// the same REST + GraphQL calls the bot makes. Whatever the code under test POSTs becomes a real record that the next
// read sees, so write -> read round trips are exercised end to end.
import { buildLedger, renderHandoffParts, renderImportParts } from '../../scripts/review-ledger.mjs';
import { renderSessionComment } from '../../scripts/review-session-core.mjs';

export const BOT = 'jiaze-claude-review-bot[bot]';
const login = (value) => String(value).replace(/\[bot\]$/i, '');

// The retired hidden-state comment, kept only so tests can build the old format the importer must still read.
export function legacyStateComment(session) {
  const state = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  return `${renderSessionComment(session)}\n<!-- jiaze-review-state:${state} -->`;
}

export function createFakePr({ author = BOT, number = 7 } = {}) {
  let nextId = 5000;
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + (clock += 1) * 1000).toISOString();
  const issue = []; const reviews = []; const threads = [];
  const calls = [];
  let lastSeq = 0; let lastHandoffId = null;

  const make = (body, { user = author, type = 'Bot', id = null, editedAt = null, minimizedReason = null } = {}) => ({
    id: String(id ?? (nextId += 1)), body, user, type, createdAt: stamp(), lastEditedAt: editedAt, minimizedReason,
  });
  const api = {
    issue, reviews, threads, calls, number,
    addIssue(body, options) { const c = make(body, options); issue.push(c); return c; },
    addReview(body, options) { const c = make(body, options); reviews.push(c); return c; },
    addThread(comments, { resolved = false } = {}) {
      const thread = { id: `T${threads.length + 1}`, isResolved: resolved, comments: comments.map((c) => (c.id ? c : make(c.body, c))) };
      threads.push(thread); return thread;
    },
    // Write a session the way the bot does: a closed stage (Handoff chain), appended to what is already there.
    seed(session, { stage = 'first', user = author, type = 'Bot', ...rest } = {}) {
      const bodies = renderHandoffParts({ session, stage, seq: lastSeq + 1, prev: lastHandoffId, ...rest });
      let id = null;
      for (const body of bodies) id = api.addIssue(body, { user, type }).id;
      if (user === author) { lastSeq += 1; lastHandoffId = id; }
      return id;
    },
    seedLegacy(session, options) { return api.addIssue(legacyStateComment(session), options); },
    seedImport(session) {
      const bodies = renderImportParts({ legacySession: session, legacyCommentId: '1' });
      let id = null;
      for (const body of bodies) id = api.addIssue(body).id;
      lastSeq = 1; lastHandoffId = id; return id;
    },
    // The session as a fresh run would rebuild it from this PR's records alone (throws if the ledger would stop).
    ledger() {
      const rec = (c, source) => ({ id: c.id, source, createdAt: c.createdAt, body: c.body, login: c.user, type: c.type, lastEditedAt: c.lastEditedAt, minimizedReason: c.minimizedReason });
      return buildLedger({
        records: [...issue.map((c) => rec(c, 'issue')), ...reviews.map((c) => rec(c, 'review')), ...threads.flatMap((t) => t.comments.map((c) => rec(c, 'thread')))],
        botLogin: author, reads: { complete: true },
      });
    },
    session() {
      const ledger = api.ledger();
      if (ledger.state === 'stopped') throw new Error(ledger.message);
      return ledger.session ?? null;
    },
    seedProjection(session) { return api.addIssue(renderSessionComment(session)); },
    // -> a Response for URLs this fake knows, otherwise undefined (so tests can layer their own routes on top)
    handle(url, init = {}) {
      const method = init.method || 'GET';
      const u = String(url);
      calls.push({ method, url: u.replace('https://api.github.com', '') });
      if (u.endsWith('/graphql')) return JSON.parse(init.body).query.includes('lastEditedAt') ? graph(JSON.parse(init.body)) : undefined;
      let m = new RegExp(`/repos/[^/]+/[^/]+/issues/${number}/comments(\\?|$)`).exec(u);
      if (m && method === 'GET') return Response.json(issue.map(rest));
      if (m && method === 'POST') {
        const c = make(JSON.parse(init.body).body); issue.push(c);
        // mirror what the planner of the next run would see after this write
        const seq = /Seq: (\d+)/.exec(c.body); const done = /Handoff: COMPLETE/.test(c.body);
        if (done && seq) { lastSeq = Number(seq[1]); lastHandoffId = c.id; }
        return Response.json(rest(c), { status: 201 });
      }
      m = new RegExp(`/pulls/${number}/comments/(\\d+)/replies$`).exec(u);
      if (m && method === 'POST') {
        const thread = threads.find((t) => t.comments.some((c) => c.id === m[1]));
        if (!thread) return undefined; // a thread this fake does not hold: the test's own routes may
        const c = make(JSON.parse(init.body).body); thread.comments.push(c);
        return Response.json(rest(c), { status: 201 });
      }
      m = /\/issues\/comments\/(\d+)$/.exec(u);
      if (m) {
        const c = issue.find((x) => x.id === m[1]);
        if (!c) return undefined; // not one of this PR's comments: the test's own routes may know it
        if (method === 'GET') return Response.json(rest(c));
        if (method === 'PATCH') { c.body = JSON.parse(init.body).body; c.lastEditedAt = stamp(); return Response.json(rest(c)); }
        if (method === 'DELETE') { issue.splice(issue.indexOf(c), 1); return new Response(null, { status: 204 }); }
      }
      if (new RegExp(`/pulls/${number}/reviews(\\?|$)`).test(u) && method === 'GET') return Response.json(reviews.map(rest));
      return undefined;
    },
  };
  const rest = (c) => ({ id: Number(c.id), user: { login: c.user, type: c.type }, body: c.body, created_at: c.createdAt });
  const node = (c) => ({ databaseId: Number(c.id), createdAt: c.createdAt, lastEditedAt: c.lastEditedAt, minimizedReason: c.minimizedReason, body: c.body, author: { login: login(c.user), __typename: c.type } });
  const graph = ({ query, variables }) => {
    const page = (items, key) => ({ [key]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items } });
    if (query.includes('reviewThreads(')) {
      return Response.json({ data: { repository: { pullRequest: page(threads.map((t) => ({ id: t.id, isResolved: t.isResolved, comments: { pageInfo: { hasNextPage: false }, nodes: t.comments.map(node) } })), 'reviewThreads') } } });
    }
    if (query.includes('reviews(')) return Response.json({ data: { repository: { pullRequest: page(reviews.map(node), 'reviews') } } });
    if (query.includes('node(id')) return Response.json({ data: { node: page([], 'comments') } });
    if (query.includes('comments(first')) return Response.json({ data: { repository: { pullRequest: page(issue.map(node), 'comments') } } });
    return Response.json({ errors: [{ message: `fake PR cannot answer: ${variables ? '' : ''}${query.slice(0, 40)}` }] });
  };
  api.fetchImpl = async (url, init) => api.handle(url, init) ?? new Response('not found: ' + url, { status: 404 });
  // The fake first, then the test's own routes.
  api.layer = (own) => async (url, init) => (await api.handle(url, init)) ?? own(url, init);
  return api;
}
