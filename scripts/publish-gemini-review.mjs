import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyDiscoveryResult,
  applyVerificationResult,
  normalizeReviewResult,
  normalizeVerificationResult,
  openMaterialFindings,
  pendingSessionMarker,
  renderSessionComment,
} from './review-session-core.mjs';

const REVIEW_BODY_MAX_BYTES = 60000;

export async function publishGeminiReview({ env = process.env, fetchImpl = fetch } = {}) {
  const target = required(env, 'TARGET_REPO');
  const parts = target.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid TARGET_REPO');
  const [owner, repo] = parts;
  const prNumber = Number(required(env, 'PR_NUMBER'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('Invalid PR_NUMBER');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(required(env, 'REVIEW_PATH'), 'utf8'));
  const mode = plan.decision?.mode;
  if (!['discovery', 'verification'].includes(mode)) throw new Error('Gemini publisher requires a model-backed session mode');

  const pr = await githubJson('https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber, env.GH_TOKEN, fetchImpl);
  if (pr.base?.sha !== baseSha) throw new Error('PR base moved before publish; refusing stale review');
  if (pr.head?.sha !== headSha) throw new Error('PR head moved before publish; refusing stale review');

  let normalized;
  let session;
  if (mode === 'discovery') {
    normalized = normalizeReviewResult(raw);
    session = applyDiscoveryResult({ result: normalized, baseSha, headSha, sourceCommentId });
  } else {
    normalized = normalizeVerificationResult(raw);
    if (!plan.session) throw new Error('Verification plan is missing durable prior session');
    session = applyVerificationResult({ session: plan.session, result: normalized, headSha });
  }

  const sessionBody = renderSessionComment(session, { sourceCommentIds: [sourceCommentId] });
  const pendingMarker = pendingSessionMarker(session, sourceCommentId);
  const addedLines = await loadAddedLines({ owner, repo, prNumber, token: env.GH_TOKEN, fetchImpl });
  const newFindings = mode === 'discovery'
    ? session.findings
    : session.findings.slice(plan.session.findings.length);
  const inline = [];
  const unanchored = [];
  for (const finding of newFindings) {
    const text = '**[' + finding.id + ' · ' + finding.severity + '] ' + finding.title + '**\n\n'
      + finding.body + '\n\nRisk class: ' + finding.riskClass;
    if (Number.isInteger(finding.line) && addedLines.has(finding.path + ':' + finding.line)) {
      inline.push({ path: finding.path, line: finding.line, side: 'RIGHT', body: text });
    } else {
      unanchored.push(finding);
    }
  }

  const open = openMaterialFindings(session);
  let body = '## Gemini ' + (mode === 'discovery' ? 'Discovery' : 'Verification') + ' Review\n\n' + normalized.summary.trim();
  if (mode === 'verification') {
    body += '\n\n### Finding verification';
    for (const verdict of normalized.verifications) {
      body += '\n- **' + verdict.findingId + ' — ' + verdict.status + '**: ' + verdict.reason;
    }
  }
  if (newFindings.length === 0) body += '\n\nNo new repair finding was reported.';
  if (unanchored.length) {
    body += '\n\n### Findings without an inline anchor';
    for (const finding of unanchored) {
      const location = finding.path + (finding.line ? ':' + finding.line : '');
      body += '\n- **[' + finding.id + ' · ' + finding.severity + '] ' + finding.title + '** — <code>'
        + escapeHtml(location) + '</code>: ' + finding.body;
    }
  }
  body += '\n\n### Session result\n**' + session.status + '** · open material findings: **' + open.length
    + '** · verification: **' + session.verificationRound + '/' + session.maxVerificationRounds + '**';
  if (session.status === 'HUMAN_REQUIRED') {
    body += '\n\nAutomatic review has stopped. Use human judgment or a targeted Codex/Claude review; do not start another full discovery automatically.';
  }
  body += formatRuntime(raw._meta);
  // This is intentionally NOT the processed-source marker. If durable session
  // persistence fails after the review POST, a retry remains eligible and can
  // recover this exact already-paid result without another Gemini call.
  body += '\n\n' + pendingMarker;
  if (Buffer.byteLength(body, 'utf8') > REVIEW_BODY_MAX_BYTES) throw new Error('Constructed review body exceeds safe size limit');

  const review = await githubJson('https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber + '/reviews',
    env.GH_TOKEN, fetchImpl, {
      method: 'POST',
      body: JSON.stringify({ commit_id: headSha, event: 'COMMENT', body, comments: inline }),
    });

  // A review can be attached to an older commit even if the PR moves immediately
  // after the first preflight. Never advance durable session state until the
  // exact target HEAD is re-proven after review publication.
  const afterReview = await githubJson('https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber,
    env.GH_TOKEN, fetchImpl);
  if (afterReview.base?.sha !== baseSha || afterReview.head?.sha !== headSha) {
    throw new Error('PR moved while publishing the review; stale review may exist, but durable session state was not advanced');
  }

  const sessionCommentId = await upsertSessionComment({
    owner, repo, prNumber, existingId: plan.sessionCommentId, body: sessionBody, token: env.GH_TOKEN, fetchImpl,
  });
  console.log('Published Gemini ' + mode + ' review ' + (review.html_url || review.id)
    + '; session comment ' + sessionCommentId + '; status ' + session.status + '.');
  return { session, sessionCommentId, reviewId: review.id };
}

async function upsertSessionComment({ owner, repo, prNumber, existingId, body, token, fetchImpl }) {
  const endpoint = existingId
    ? 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/comments/' + existingId
    : 'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + prNumber + '/comments';
  const result = await githubJson(endpoint, token, fetchImpl, {
    method: existingId ? 'PATCH' : 'POST',
    body: JSON.stringify({ body }),
  });
  return String(result.id);
}

async function loadAddedLines({ owner, repo, prNumber, token, fetchImpl }) {
  const set = new Set();
  for (let page = 1; page <= 100; page += 1) {
    const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber + '/files?per_page=100&page=' + page;
    const files = await githubJson(url, token, fetchImpl);
    if (!Array.isArray(files)) throw new Error('GitHub pull files response was not an array');
    for (const file of files) {
      if (typeof file.filename !== 'string' || typeof file.patch !== 'string') continue;
      for (const line of parseAddedLineNumbers(file.patch)) set.add(file.filename + ':' + line);
    }
    if (files.length < 100) return set;
  }
  throw new Error('Pull request file pagination exceeded safety limit');
}

function parseAddedLineNumbers(patch) {
  const lines = new Set();
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith('\\ No newline')) continue;
    if (text.startsWith('+')) {
      lines.add(newLine);
      newLine += 1;
    } else if (!text.startsWith('-')) {
      newLine += 1;
    }
  }
  return lines;
}

async function githubJson(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('GitHub API failed (HTTP ' + response.status + '): ' + text.slice(0, 500));
  }
  return response.json();
}

function formatRuntime(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const usage = meta.usage || {};
  const parts = [
    'model ' + escapeHtml(meta.resolved_model || meta.requested_model || 'Gemini'),
    'thinking ' + escapeHtml(meta.effort || 'low'),
  ];
  if (usage.input_tokens != null) parts.push('input ' + Number(usage.input_tokens).toLocaleString('en-US'));
  if (usage.output_tokens != null) parts.push('output ' + Number(usage.output_tokens).toLocaleString('en-US'));
  if (usage.thoughts_tokens != null) parts.push('thoughts ' + Number(usage.thoughts_tokens).toLocaleString('en-US'));
  return '\n\n---\n<sub>Review runtime: ' + parts.join(' · ') + '</sub>';
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing required environment variable: ' + key);
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publishGeminiReview();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
