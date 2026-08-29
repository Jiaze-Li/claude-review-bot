import fs from 'node:fs';

const required = ['GH_TOKEN', 'TARGET_REPO', 'PR_NUMBER', 'HEAD_SHA', 'DIFF_PATH', 'REVIEW_JSON'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const [owner, repo] = process.env.TARGET_REPO.split('/');
if (!owner || !repo) throw new Error(`Invalid TARGET_REPO: ${process.env.TARGET_REPO}`);

const prNumber = Number(process.env.PR_NUMBER);
if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('PR_NUMBER must be a positive integer');

let review;
try {
  review = JSON.parse(process.env.REVIEW_JSON);
} catch (error) {
  throw new Error(`Claude structured output is not valid JSON: ${error.message}`);
}

if (!review || typeof review.summary !== 'string' || !Array.isArray(review.findings)) {
  throw new Error('Claude structured output does not match the expected shape');
}

const diff = fs.readFileSync(process.env.DIFF_PATH, 'utf8');
const addedLines = parseAddedLines(diff);

const inlineComments = [];
const unanchored = [];
for (const finding of review.findings.slice(0, 25)) {
  if (!isFinding(finding)) continue;

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
  for (const finding of unanchored) {
    const location = finding.line ? `\`${finding.path}:${finding.line}\`` : `\`${finding.path}\``;
    body += `\n- **[${finding.severity}] ${finding.title}** — ${location}: ${finding.body}`;
  }
}

const payload = {
  commit_id: process.env.HEAD_SHA,
  event: 'COMMENT',
  body,
  comments: inlineComments,
};

const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
  method: 'POST',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'claude-review-bot',
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const text = await response.text();
  throw new Error(`GitHub review publish failed (${response.status}): ${text}`);
}

const result = await response.json();
console.log(`Published Claude review ${result.html_url ?? result.id} with ${inlineComments.length} inline comment(s).`);

function isFinding(value) {
  return value &&
    ['P0', 'P1', 'P2', 'P3'].includes(value.severity) &&
    typeof value.title === 'string' && value.title.trim() &&
    typeof value.body === 'string' && value.body.trim() &&
    typeof value.path === 'string' && value.path.trim() &&
    (value.line === null || Number.isInteger(value.line));
}

function parseAddedLines(text) {
  const set = new Set();
  let path = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      path = line.slice(6);
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk || !path) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      set.add(`${path}:${newLine}`);
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line: no RIGHT-side line number increment.
    } else {
      newLine += 1;
    }
  }

  return set;
}
