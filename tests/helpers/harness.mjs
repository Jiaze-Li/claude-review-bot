// In-memory GitHub + scripted model for exercising the real executor end to end. No network, no clock, no model.
import { BOT_LOGIN, readState } from '../../scripts/review-contract.mjs';
import { loadContext, runReview } from '../../scripts/review.mjs';

export const REPO = 'owner/repo';
export const PR = 7;
export const sha = (c) => c.repeat(40);
export const MERGE_BASE = sha('0');

export function makeContext(files, { ignore = '', binary = [], bigDiff = [] } = {}) {
  const diffOf = (f) => (binary.includes(f)
    ? `diff --git a/${f} b/${f}\nBinary files a/${f} and b/${f} differ\n`
    : `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n+${bigDiff.includes(f) ? 'x'.repeat(60000) : 'changed'}\n`);
  const store = { 'merge-base.txt': `${MERGE_BASE}\n`, 'ignore-patterns.txt': ignore, 'changed-files.txt': `${files.join('\n')}\n`, 'pr.diff': files.map(diffOf).join('') };
  return () => loadContext({ contextRoot: 'unused', readFile: (name) => store[name] ?? '' });
}

export function fakeGithub({ head = sha('a'), draft = false, state = 'open', comments = [] } = {}) {
  const gh = {
    head, draft, state, comments: [...comments], nextId: 100, writes: [], statuses: [], failNextPatch: null, calls: 0,
    async getPr() { return { state: gh.state, draft: gh.draft, head_sha: gh.head, base_sha: sha('1'), title: 'Add upload retry', body: 'Retries uploads.' }; },
    async readRecords() { return gh.comments.map((c) => ({ ...c })); },
    async getComment(id) { const c = gh.comments.find((x) => x.id === String(id)); if (!c) throw new Error('404'); return { ...c }; },
    async createComment(body) { const id = String(gh.nextId++); gh.comments.push({ id, source: 'issue', login: BOT_LOGIN, type: 'Bot', body }); gh.writes.push(body); return id; },
    async patchComment(id, body) {
      const c = gh.comments.find((x) => x.id === String(id));
      c.body = body; gh.writes.push(body);
      if (gh.failNextPatch) { const e = gh.failNextPatch; gh.failNextPatch = null; throw e; } // the write landed, the response was lost
    },
    async postStatus(sha_, status) { gh.statuses.push({ sha: sha_, ...status }); },
    state_() { return readState(gh.comments, { botLogin: BOT_LOGIN, repo: REPO, prNumber: PR }); },
    writtenStates() { return gh.writes.map((b) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(b)[1])); },
  };
  return gh;
}

export const assignedFrom = (prompt) => {
  const block = /FILES ASSIGNED TO THIS BATCH[^\n]*\n([\s\S]*?)\n\nTheir diffs/.exec(prompt)[1];
  return block.split('\n').map((l) => l.replace(/^- /, '').replace(/ {2}\(diff truncated.*$/, ''));
};

// script: (call: { n, assigned, prompt }) => outcome   (outcome from `model.*`)
export const model = {
  ok: ({ assigned, findings = [], prior = [], reviewed = assigned, unreviewed = [], complete = true, readPaths = [] }) => ({
    ok: true, readPaths: new Set(readPaths),
    structured: { summary: 's', findings, prior_findings: prior, coverage: { complete, reviewedPaths: reviewed, unreviewedPaths: unreviewed, note: '' } },
  }),
  fail: (error = 'provider failed') => ({ ok: false, error, errorKind: 'execution' }),
};

export function scriptedProvider(script) {
  const calls = [];
  return {
    calls, limits: { maxTurns: 14, maxBudgetUsd: 0.5, timeoutMs: 1000 }, contextRoot: 'unused',
    preflight() {},
    async run({ prompt }) {
      const assigned = assignedFrom(prompt);
      const call = { n: calls.length + 1, assigned, prompt };
      calls.push(call);
      return script(call);
    },
  };
}

export async function review({ gh, provider, ctx, now = () => Date.now(), env = {} }) {
  return runReview({
    env: { TARGET_REPO: REPO, PR_NUMBER: String(PR), HEAD_SHA: gh.head, ...env }, github: gh, provider, loadCtx: ctx, now, log: () => {},
  });
}
