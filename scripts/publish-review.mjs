import fs from 'node:fs';
import { REVIEW_BODY_MAX_BYTES, anchorFindings, assertPrUnmoved, escapeHtml, githubJson, loadAnchors, pullUrl } from './github-review-api.mjs';

// The review POST can carry many inline comments, so it gets a longer timeout than the other API calls.
const REVIEW_POST_TIMEOUT_MS = 60_000;
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

const token = process.env.GH_TOKEN;
const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA;
await assertPrUnmoved({ owner, repo, prNumber, baseSha, headSha, token, fetchImpl: fetch });

const anchors = await loadAnchors({ owner, repo, prNumber, token, fetchImpl: fetch });
const { inline: inlineComments, unanchored } = anchorFindings(anchors, review.findings,
  (finding) => `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`);

const providerCounts = review._meta?.providers && typeof review._meta.providers === 'object' ? review._meta.providers : {};
const heading = providerCounts.gemini > 0 ? (providerCounts.claude > 0 ? 'Gemini + Claude Code Review' : 'Gemini Code Review') : 'Claude Code Review';
let body = `## ${heading}\n\n${review.summary.trim()}`;
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
  commit_id: headSha,
  event: 'COMMENT',
  body,
  comments: inlineComments,
};

const result = await githubJson(`${pullUrl({ owner, repo, prNumber })}/reviews`, token, fetch, {
  method: 'POST',
  body: JSON.stringify(payload),
  timeoutMs: REVIEW_POST_TIMEOUT_MS,
});

console.log(`Published explicit Claude review ${result.html_url ?? result.id} with ${inlineComments.length} inline comment(s).`);

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
  const shards = nonnegativeInteger(value.shards);
  const shardsRun = nonnegativeInteger(value.shards_run);
  const deferredFiles = nonnegativeInteger(value.deferred_files);
  const providers = value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers)
    ? Object.entries(value.providers).filter(([name, count]) => ['gemini', 'claude'].includes(name) && nonnegativeInteger(count)).map(([name, count]) => `${name} ${count}`)
    : [];
  if (shards !== null && shards > 1) {
    details.push(`shards ${shardsRun !== null ? `${shardsRun}/` : ''}${shards}${deferredFiles ? ` (+${deferredFiles} file(s) deferred)` : ''}${providers.length ? ` by ${providers.join(', ')}` : ''}`);
  } else if (providers.length) {
    details.push(`by ${providers.join(', ')}`);
  }

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

function sourceCommentMarker(commentId) {
  return `<!-- jiaze-review-source-comment:${String(commentId)} -->`;
}
