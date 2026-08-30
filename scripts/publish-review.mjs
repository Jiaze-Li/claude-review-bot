import fs from 'node:fs';

const REVIEW_BODY_MAX_BYTES = 60_000;
const required = ['GH_TOKEN', 'TARGET_REPO', 'PR_NUMBER', 'BASE_SHA', 'HEAD_SHA', 'SOURCE_COMMENT_ID', 'REVIEW_PATH'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const [owner, repo, extra] = process.env.TARGET_REPO.split('/');
if (!owner || !repo || extra) throw new Error(`Invalid TARGET_REPO: ${process.env.TARGET_REPO}`);

const prNumber = Number(process.env.PR_NUMBER);
if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('PR_NUMBER must be a positive integer');

const sourceCommentId = String(process.env.SOURCE_COMMENT_ID);
if (!/^\d+$/.test(sourceCommentId)) throw new Error('SOURCE_COMMENT_ID must be a positive GitHub comment ID');
const sourceMarker = sourceCommentMarker(sourceCommentId);

let review;
try {
  review = JSON.parse(fs.readFileSync(process.env.REVIEW_PATH, 'utf8'));
} catch (error) {
  throw new Error(`Claude structured output is not valid JSON: ${error.message}`);
}

validateReview(review);
const runtimeSection = formatRuntimeSection(review._meta);

const pr = await githubJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);
if (pr.base?.sha !== process.env.BASE_SHA) {
  throw new Error(`PR base moved from ${process.env.BASE_SHA} to ${pr.base?.sha ?? 'unknown'} before publish; refusing stale review`);
}
if (pr.head?.sha !== process.env.HEAD_SHA) {
  throw new Error(`PR head moved from ${process.env.HEAD_SHA} to ${pr.head?.sha ?? 'unknown'} before publish; refusing stale review`);
}

const addedLines = await loadAddedLinesFromGitHub();
const inlineComments = [];
const unanchored = [];

for (const finding of review.findings) {
  const key = `${finding.path}:${finding.line}`;
  const canAnchor = Number.isInteger(finding.line) && addedLines.has(key);
  const text = `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;

  if (canAnchor) {
    inlineComments.push({
      path: finding.path,
      line: finding.line,
      side: 'RIGHT',
      body: text,
    });
  } else {
    unanchored.push(finding);
  }
}

let body = `## Claude Code Review\n\n${review.summary.trim()}`;
if (review.findings.length === 0) {
  body += '\n\n✅ No actionable issues found.';
} else {
  body += `\n\nFound ${review.findings.length} actionable issue${review.findings.length === 1 ? '' : 's'}.`;
}

if (unanchored.length) {
  body += '\n\n### Findings without an inline anchor\n';
  let omitted = 0;

  for (const finding of unanchored) {
    const locationText = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    const entry = `\n- **[${finding.severity}] ${finding.title}** — <code>${escapeHtml(locationText)}</code>: ${finding.body}`;
    const reserve = `\n\n_25 additional unanchored findings omitted because the GitHub review body reached its safe size limit._${runtimeSection}\n\n${sourceMarker}`;

    if (Buffer.byteLength(body + entry + reserve, 'utf8') <= REVIEW_BODY_MAX_BYTES) {
      body += entry;
    } else {
      omitted += 1;
    }
  }

  if (omitted) {
    body += `\n\n_${omitted} additional unanchored finding${omitted === 1 ? '' : 's'} omitted because the GitHub review body reached its safe size limit._`;
  }
}

body += runtimeSection;
body += `\n\n${sourceMarker}`;

if (Buffer.byteLength(body, 'utf8') > REVIEW_BODY_MAX_BYTES) {
  throw new Error('Internal error: constructed GitHub review body exceeds safe size limit');
}

const payload = {
  commit_id: process.env.HEAD_SHA,
  event: 'COMMENT',
  body,
  comments: inlineComments,
};

const result = await githubJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
  method: 'POST',
  body: JSON.stringify(payload),
});

console.log(`Published Claude review ${result.html_url ?? result.id} with ${inlineComments.length} inline comment(s).`);

function validateReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Claude structured output must be an object');
  }
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 6000) {
    throw new Error('Claude structured output has an invalid summary');
  }
  if (!Array.isArray(value.findings) || value.findings.length > 25) {
    throw new Error('Claude structured output has an invalid findings array');
  }
  if (!value.findings.every(isFinding)) {
    throw new Error('Claude structured output contains an invalid finding');
  }
}

function isFinding(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['P0', 'P1', 'P2', 'P3'].includes(value.severity) &&
    typeof value.title === 'string' && Boolean(value.title.trim()) && value.title.length <= 300 &&
    typeof value.body === 'string' && Boolean(value.body.trim()) && value.body.length <= 4000 &&
    typeof value.path === 'string' && Boolean(value.path.trim()) && value.path.length <= 1000 &&
    !value.path.startsWith('/') && !value.path.split('/').some((part) => part === '..') &&
    (value.line === null || (Number.isInteger(value.line) && value.line >= 1));
}

function formatRuntimeSection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const resolvedModel = safeLabel(value.resolved_model);
  const requestedModel = safeLabel(value.requested_model);
  const effort = safeLabel(value.effort);
  const numTurns = nonnegativeInteger(value.num_turns);
  const maxTurns = nonnegativeInteger(value.max_turns);
  const usage = value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)
    ? value.usage
    : null;
  const cost = nonnegativeNumber(value.total_cost_usd);

  const details = [];
  if (resolvedModel) {
    details.push(requestedModel && requestedModel !== resolvedModel
      ? `model ${resolvedModel} (alias ${requestedModel})`
      : `model ${resolvedModel}`);
  } else if (requestedModel) {
    details.push(`model alias ${requestedModel}`);
  }
  if (effort) details.push(`effort ${effort}`);
  if (numTurns !== null) details.push(`turns ${numTurns}${maxTurns !== null ? `/${maxTurns}` : ''}`);

  if (usage) {
    const input = nonnegativeNumber(usage.input_tokens);
    const cacheRead = nonnegativeNumber(usage.cache_read_input_tokens);
    const cacheWrite = nonnegativeNumber(usage.cache_creation_input_tokens);
    const output = nonnegativeNumber(usage.output_tokens);
    const tokenParts = [];
    if (input !== null) tokenParts.push(`input ${formatInteger(input)}`);
    if (cacheRead !== null) tokenParts.push(`cache-read ${formatInteger(cacheRead)}`);
    if (cacheWrite !== null) tokenParts.push(`cache-write ${formatInteger(cacheWrite)}`);
    if (output !== null) tokenParts.push(`output ${formatInteger(output)}`);
    if (tokenParts.length) details.push(`tokens ${tokenParts.join(', ')}`);
  }

  if (cost !== null) details.push(`SDK cost estimate $${cost.toFixed(4)}`);
  if (!details.length) return '';

  return `\n\n---\n<sub>Review runtime: ${escapeHtml(details.join(' · '))}</sub>`;
}

function safeLabel(value) {
  if (typeof value !== 'string' || !value || value.length > 120) return null;
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : null;
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatInteger(value) {
  return Math.trunc(value).toLocaleString('en-US');
}

async function loadAddedLinesFromGitHub() {
  const set = new Set();
  let page = 1;

  while (page <= 100) {
    const files = await githubJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) throw new Error('GitHub pull files response was not an array');

    for (const file of files) {
      if (typeof file.filename !== 'string' || typeof file.patch !== 'string') continue;
      for (const line of parseAddedLineNumbers(file.patch)) {
        set.add(`${file.filename}:${line}`);
      }
    }

    if (files.length < 100) return set;
    page += 1;
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

    if (!inHunk || text.startsWith('\\ No newline at end of file')) continue;

    if (text.startsWith('+')) {
      lines.add(newLine);
      newLine += 1;
    } else if (text.startsWith('-')) {
      // Removed line: RIGHT-side line number does not advance.
    } else {
      newLine += 1;
    }
  }

  return lines;
}

async function githubJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-review-bot',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) ${url}: ${text}`);
  }

  return response.json();
}

function sourceCommentMarker(commentId) {
  return `<!-- claude-review-source-comment:${String(commentId)} -->`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
