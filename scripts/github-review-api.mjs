import { addPatch, chooseAnchor, findingMarker, snapNote } from './review-anchors.mjs';

// Plumbing shared by the two review publishers (the sharded engine's publish-review.mjs and the staged
// publish-gemini-review.mjs). Review bodies and session handling stay in each publisher.

export const REVIEW_BODY_MAX_BYTES = 60000;
const API_TIMEOUT_MS = 15000;

export function requiredEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing required environment variable: ' + key);
  return String(value);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// `init.timeoutMs` overrides the default per-request timeout (e.g. for the review POST, whose size varies).
export async function githubJson(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const { timeoutMs = API_TIMEOUT_MS, ...fetchInit } = init;
  const response = await fetchImpl(url, {
    ...fetchInit,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
      ...(fetchInit.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('GitHub API failed (HTTP ' + response.status + '): ' + text.slice(0, 500));
  }
  return response.json();
}

export function pullUrl({ owner, repo, prNumber }) {
  return 'https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber;
}

// Refuses a review for a PR whose base or head is no longer the one that was reviewed.
export async function assertPrUnmoved({ owner, repo, prNumber, baseSha, headSha, token, fetchImpl, when = 'before publish' }) {
  const pr = await githubJson(pullUrl({ owner, repo, prNumber }), token, fetchImpl);
  if (pr.base?.sha !== baseSha) throw new Error('PR base moved ' + when + '; refusing stale review');
  if (pr.head?.sha !== headSha) throw new Error('PR head moved ' + when + '; refusing stale review');
}

export async function loadAnchors({ owner, repo, prNumber, token, fetchImpl }) {
  const anchors = new Map();
  for (let page = 1; page <= 100; page += 1) {
    const files = await githubJson(pullUrl({ owner, repo, prNumber }) + '/files?per_page=100&page=' + page, token, fetchImpl);
    if (!Array.isArray(files)) throw new Error('GitHub pull files response was not an array');
    for (const file of files) addPatch(anchors, file.filename, file.patch);
    if (files.length < 100) return anchors;
  }
  throw new Error('Pull request file pagination exceeded safety limit');
}

// Splits findings into inline review comments and findings with no line in the diff. `render(finding)` gives the
// visible text of a comment; the anchor note and hidden finding marker are appended here.
export function anchorFindings(anchors, findings, render) {
  const inline = [];
  const unanchored = [];
  for (const finding of findings) {
    const anchor = chooseAnchor(anchors, finding);
    if (anchor) {
      inline.push({ path: finding.path, line: anchor.line, side: 'RIGHT',
        body: render(finding) + snapNote(anchor) + '\n\n' + findingMarker(finding.path, finding.title) });
    } else {
      unanchored.push(finding);
    }
  }
  return { inline, unanchored };
}
