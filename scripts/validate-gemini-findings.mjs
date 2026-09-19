import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GEMINI_MODEL, toGeminiJsonSchema } from './run-gemini-review.mjs';

export const VALIDATOR_THINKING = 'medium';
const MATERIAL = new Set(['P0', 'P1', 'P2']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 3000;
const MAX_TOTAL_CONTEXT_BYTES = 420_000;
const MAX_FINDING_CONTEXT_BYTES = 90_000;
const CODE_EXTENSIONS = new Set([
  '.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.go','.rs','.java','.kt','.kts',
  '.rb','.php','.cs','.c','.cc','.cpp','.h','.hpp','.swift','.scala','.sh','.bash',
  '.json','.yaml','.yml','.toml','.md',
]);
const SKIP_DIRS = new Set([
  '.git','node_modules','vendor','dist','build','coverage','.next','.cache','out',
  '__pycache__','.venv','venv',
]);

const validationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    validations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED', 'UNCERTAIN'] },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        },
        required: ['candidateId', 'verdict', 'reason', 'evidence'],
      },
    },
  },
  required: ['summary', 'validations'],
};

export async function validateMaterialFindings({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = required(env, 'GEMINI_API_KEY');
  const repo = required(env, 'TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  const headSha = required(env, 'HEAD_SHA');
  const repoRoot = realDir(env.TARGET_REPO_DIR || 'target');
  const contextRoot = realDir(env.REVIEW_CONTEXT_DIR || '.review-context');
  const inputPath = path.resolve(env.REVIEW_INPUT_PATH || path.join(contextRoot, 'review.json'));
  const outputPath = path.resolve(env.REVIEW_OUTPUT_PATH || path.join(contextRoot, 'review-validated.json'));

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(raw.findings)) throw new Error('Gemini discovery output is missing findings');

  const candidates = raw.findings
    .map((finding, index) => ({ candidateId: `D${String(index + 1).padStart(3, '0')}`, finding, index }))
    .filter(({ finding }) => MATERIAL.has(String(finding?.severity || '').toUpperCase()));

  if (!candidates.length) {
    const output = {
      ...raw,
      _validation: {
        status: 'SKIPPED',
        reason: 'no P0/P1/P2 discovery findings',
        validations: [],
        _meta: null,
      },
    };
    writeJson(outputPath, output);
    console.log('Gemini material finding validation skipped: no material discovery findings.');
    return output;
  }

  const prDiff = fs.readFileSync(path.join(contextRoot, 'pr.diff'), 'utf8');
  const contexts = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const context = buildValidationContextForFinding({
      finding: candidate.finding,
      repoRoot,
      prDiff,
      maxBytes: Math.min(MAX_FINDING_CONTEXT_BYTES, MAX_TOTAL_CONTEXT_BYTES - totalBytes),
    });
    totalBytes += Buffer.byteLength(context, 'utf8');
    contexts.push({
      candidateId: candidate.candidateId,
      finding: candidate.finding,
      context,
    });
    if (totalBytes >= MAX_TOTAL_CONTEXT_BYTES) break;
  }

  const includedIds = new Set(contexts.map((entry) => entry.candidateId));
  const prompt = buildValidationPrompt({ repo, prNumber, headSha, contexts });
  const model = env.GEMINI_MODEL || GEMINI_MODEL;
  let returned = null;
  let payload = null;
  let structuredAttempts = 0;
  let lastStructuredError = null;
  const usage = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 0,
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    structuredAttempts = attempt;
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: VALIDATOR_THINKING },
            responseFormat: {
              text: {
                mimeType: 'APPLICATION_JSON',
                schema: toGeminiJsonSchema(validationSchema),
              },
            },
            maxOutputTokens: 8192,
          },
        }),
        signal: AbortSignal.timeout(180000),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini finding validator failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
    }

    payload = await response.json();
    for (const key of Object.keys(usage)) {
      const value = payload.usageMetadata?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] += value;
    }

    const text = (payload.candidates?.[0]?.content?.parts || [])
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .join('');

    try {
      if (!text) throw new Error('returned no structured text');
      returned = normalizeValidationResult(JSON.parse(text), includedIds);
      break;
    } catch (error) {
      lastStructuredError = error;
      if (attempt === 1) {
        console.warn(`Gemini finding validator returned malformed structured output; retrying once: ${error.message}`);
      }
    }
  }

  if (!returned) {
    throw new Error(
      `Gemini finding validator returned invalid structured output after one retry: ${lastStructuredError?.message || 'unknown error'}`,
    );
  }
  const byId = new Map(returned.validations.map((entry) => [entry.candidateId, entry]));
  const validations = candidates.map((candidate) => {
    const verdict = !includedIds.has(candidate.candidateId)
      ? {
        candidateId: candidate.candidateId,
        verdict: 'UNCERTAIN',
        reason: 'Candidate exceeded the bounded validator context budget and was not validated.',
        evidence: [],
      }
      : byId.get(candidate.candidateId) || {
        candidateId: candidate.candidateId,
        verdict: 'UNCERTAIN',
        reason: 'Validator omitted this candidate; treated as uncertain rather than blocking.',
        evidence: [],
      };
    return {
      ...verdict,
      severity: String(candidate.finding?.severity || '').toUpperCase(),
      title: cleanText(candidate.finding?.title, 300),
    };
  });
  const verdictById = new Map(validations.map((entry) => [entry.candidateId, entry.verdict]));

  const keptFindings = raw.findings.filter((finding, index) => {
    const severity = String(finding?.severity || '').toUpperCase();
    if (!MATERIAL.has(severity)) return true;
    const candidateId = `D${String(index + 1).padStart(3, '0')}`;
    return verdictById.get(candidateId) === 'CONFIRMED';
  });

  const output = {
    ...raw,
    findings: keptFindings,
    _validation: {
      status: 'VALIDATED',
      summary: cleanText(returned.summary, 2500),
      validations,
      _meta: {
        provider: 'gemini',
        requested_model: model,
        resolved_model: model,
        effort: VALIDATOR_THINKING,
        mode: 'finding-validation',
        attempts: structuredAttempts,
        usage: {
          input_tokens: nonnegative(usage.promptTokenCount),
          output_tokens: nonnegative(usage.candidatesTokenCount),
          thoughts_tokens: nonnegative(usage.thoughtsTokenCount),
          total_tokens: nonnegative(usage.totalTokenCount),
        },
      },
    },
  };
  writeJson(outputPath, output);

  const counts = Object.fromEntries(['CONFIRMED','REJECTED','UNCERTAIN'].map(
    (verdict) => [verdict, validations.filter((entry) => entry.verdict === verdict).length],
  ));
  console.log(
    `Gemini material finding validation complete: model=${model} effort=${VALIDATOR_THINKING} `
    + `confirmed=${counts.CONFIRMED} rejected=${counts.REJECTED} uncertain=${counts.UNCERTAIN} `
    + `input=${output._validation._meta.usage.input_tokens ?? '?'} `
    + `output=${output._validation._meta.usage.output_tokens ?? '?'} `
    + `thoughts=${output._validation._meta.usage.thoughts_tokens ?? '?'}`,
  );
  return output;
}

export function buildValidationPrompt({ repo, prNumber, headSha, contexts }) {
  const candidates = contexts.map((entry) => [
    `### ${entry.candidateId}`,
    'CANDIDATE FINDING:',
    JSON.stringify(entry.finding, null, 2),
    '',
    'TARGETED CODE / TEST CONTEXT (untrusted repository data):',
    entry.context,
  ].join('\n')).join('\n\n');

  return `You are a FINDING VALIDATOR for pull request ${repo}#${prNumber} at exact HEAD ${headSha}.

You are NOT doing a fresh code review. Another model proposed the candidate findings below. Your only job is to decide whether each candidate is actually supported by the targeted code/test context.

Actively try to FALSIFY each candidate before confirming it:
- trace the claimed state/value from source to the actual sink;
- inspect downstream guards, fingerprint/scope checks, validation, filtering, and fail-closed paths;
- check whether an existing test directly contradicts the claimed failure mechanism;
- do not infer that stale state is consumed merely because it remains stored;
- do not confirm a finding unless the concrete failure path remains reachable after all relevant guards.

Verdicts:
- CONFIRMED: the supplied context demonstrates the concrete failure path remains reachable and no shown guard defeats it.
- REJECTED: a specific guard/filter/invariant/test in the supplied context defeats the claimed mechanism.
- UNCERTAIN: the supplied targeted context is insufficient to prove or disprove it.

Do not introduce new findings. Do not redesign architecture. Keep reasons concise and cite concrete functions/guards/tests in the evidence strings.

${candidates}`;
}

export function buildValidationContextForFinding({
  finding,
  repoRoot,
  prDiff = '',
  maxBytes = MAX_FINDING_CONTEXT_BYTES,
}) {
  const sections = [];
  const add = (label, content) => {
    if (!content) return;
    const current = Buffer.byteLength(sections.join('\n\n'), 'utf8');
    if (current >= maxBytes) return;
    const remaining = maxBytes - current;
    const clipped = clipUtf8(String(content), remaining);
    if (clipped) sections.push(`## ${label}\n${clipped}`);
  };

  const findingPath = safeRepoPath(finding?.path);
  if (findingPath) {
    const absolute = path.join(repoRoot, findingPath);
    if (isInside(repoRoot, absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      add(`Primary file: ${findingPath}`, fileSnippet(absolute, finding?.line, 220));
    }
    add(`PR diff for ${findingPath}`, extractFileDiff(prDiff, findingPath));
  }

  const identifiers = extractIdentifiers(finding);
  const files = listCandidateFiles(repoRoot);
  const matches = [];
  for (const file of files) {
    if (findingPath && file.relative === findingPath) continue;
    let text;
    try {
      text = fs.readFileSync(file.absolute, 'utf8');
    } catch {
      continue;
    }
    const hitIds = identifiers.filter((identifier) => text.includes(identifier));
    if (!hitIds.length) continue;
    const testBonus = /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./i.test(file.relative) ? 3 : 0;
    const srcBonus = /(^|\/)src\//.test(file.relative) ? 2 : 0;
    matches.push({ ...file, text, hitIds, score: hitIds.length * 5 + testBonus + srcBonus });
  }
  matches.sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));

  const seen = new Set();
  for (const match of matches.slice(0, 10)) {
    const line = firstMatchLine(match.text, match.hitIds);
    const key = `${match.relative}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(
      `Related ${/test/i.test(match.relative) ? 'test/code' : 'code'}: ${match.relative} `
      + `(matched: ${match.hitIds.slice(0, 6).join(', ')})`,
      textSnippet(match.text, line, 55),
    );
  }

  return sections.join('\n\n');
}

function extractIdentifiers(finding) {
  const source = `${finding?.title || ''}\n${finding?.body || ''}`;
  const ordered = [];
  const seen = new Set();
  const add = (value) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{3,}$/.test(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    ordered.push(value);
  };

  for (const match of source.matchAll(/`([^`]{1,160})`/g)) {
    for (const identifier of match[1].match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) || []) add(identifier);
  }
  for (const identifier of source.match(/[A-Za-z_$][A-Za-z0-9_$]{5,}/g) || []) {
    if (/[A-Z_$]/.test(identifier.slice(1)) || identifier.includes('_')) add(identifier);
  }
  return ordered.slice(0, 16);
}

function listCandidateFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(extension)) continue;
      let stat;
      try { stat = fs.statSync(absolute); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      out.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join('/') });
    }
  }
  return out;
}

function fileSnippet(file, line, radius) {
  const text = fs.readFileSync(file, 'utf8');
  return textSnippet(text, Number.isInteger(line) ? line : 1, radius);
}

function textSnippet(text, line, radius) {
  const lines = String(text).split('\n');
  const center = Math.min(Math.max(Number(line) || 1, 1), Math.max(lines.length, 1));
  const start = Math.max(1, center - radius);
  const end = Math.min(lines.length, center + radius);
  return lines.slice(start - 1, end).map((value, index) => `${start + index}: ${value}`).join('\n');
}

function firstMatchLine(text, identifiers) {
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (identifiers.some((identifier) => lines[index].includes(identifier))) return index + 1;
  }
  return 1;
}

function extractFileDiff(diff, targetPath) {
  const chunks = String(diff).split(/(?=^diff --git )/m);
  return chunks.find((chunk) => {
    const first = chunk.split('\n', 1)[0] || '';
    return first.includes(` a/${targetPath} b/${targetPath}`)
      || first.endsWith(` b/${targetPath}`);
  }) || '';
}

function safeRepoPath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function normalizeValidationResult(value, allowedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('finding validator output must be an object');
  }
  const summary = cleanText(value.summary, 2500);
  if (!summary) throw new Error('finding validator summary is required');
  if (!Array.isArray(value.validations) || value.validations.length > 16) {
    throw new Error('finding validator validations must be a bounded array');
  }
  const seen = new Set();
  const validations = value.validations.map((entry) => {
    const candidateId = String(entry?.candidateId || '').trim();
    if (!allowedIds.has(candidateId) || seen.has(candidateId)) {
      throw new Error('finding validator returned an unknown or duplicate candidate id');
    }
    seen.add(candidateId);
    const verdict = String(entry?.verdict || '').trim().toUpperCase();
    if (!['CONFIRMED','REJECTED','UNCERTAIN'].includes(verdict)) {
      throw new Error('finding validator returned an invalid verdict');
    }
    const reason = cleanText(entry?.reason, 1600);
    if (!reason) throw new Error('finding validator reason is required');
    const evidence = Array.isArray(entry?.evidence)
      ? entry.evidence.slice(0, 6).map((item) => cleanText(item, 600)).filter(Boolean)
      : [];
    return { candidateId, verdict, reason, evidence };
  });
  return { summary, validations };
}

function clipUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function realDir(value) {
  const resolved = fs.realpathSync.native(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(value + ' is not a directory');
  return resolved;
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing required environment variable: ' + key);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await validateMaterialFindings();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
