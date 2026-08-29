import fs from 'node:fs';

const REVIEW_BODY_MAX_BYTES = 60_000;
const required = ['GH_TOKEN', 'TARGET_REPO', 'PR_NUMBER', 'HEAD_SHA', 'REVIEW_PATH'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const [owner, repo, extra] = process.env.TARGET_REPO.split('/');
if (!owner || !repo || extra) throw new Error(`Invalid TARGET_REPO: ${process.env.TARGET_REPO}`);

const prNumber = Number(process.env.PR_NUMBER);
if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('PR_NUMBER must be a positive integer');

let review;
try {
  review = JSON.parse(fs.readFileSync(process.env.REVIEW_PATH, 'utf8'));
} catch (error) {
  throw new Error(`Claude structured output is not valid JSON: ${error.message}`);
}

validateReview(review);

const pr = await githubJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);
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
    const reserve = '\n\n_25 additional unanchored findings omitted because the GitHub review body reached its safe size limit._';

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

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
