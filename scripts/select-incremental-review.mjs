import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MAX_INCREMENTAL_FILES = 3;
export const MAX_INCREMENTAL_LINES = 50;
export const MAX_INCREMENTAL_PATCH_BYTES = 150_000;
export const MAX_INCREMENTAL_REVIEWS = 15;

// Conservative escalation: small changes to these surfaces can affect the
// entire PR. Content checks also inspect removed lines (e.g. deleting a lock).
const HIGH_RISK_PATH = /(^|\/)(?:\.github\/|\.claude\/|\.agents\/|migrations?\/|schemas?\/|auth(?:entication|orization)?\/|security\/|permissions?\/|crypto\/|database\/|db\/|storage\/|persistence\/|ci\/)|(^|\/)(?:AGENTS\.md|CLAUDE\.md|Dockerfile|Makefile|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.mod|go\.sum|Podfile\.lock|Gemfile\.lock|requirements[^/]*\.txt|pyproject\.toml|\.env[^/]*)$/i;
// Unknown/binary/manifest formats do not receive a cheap pass just because
// their textual patch is short. Source, UI markup, and plain prose are eligible.
const SAFE_DELTA_EXTENSION = /\.(?:swift|js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|c|cc|cpp|css|scss|html|md|txt)$/i;
const HIGH_RISK_CHANGE = /\b(?:mutex|semaphore|atomic|lock|unlock|deadlock|race|concurren\w*|transaction|rollback|commitTransaction|compareAndSwap|compare[-_]?and[-_]?swap|thread|actor|dispatchQueue|TaskGroup|Promise\.all|database|migration|schema|credential|secret|password|permission|authorization|authentication|encrypt|decrypt|signature|jwt|webhook|token|sessionCookie)\b/i;

function full(reason) {
  return { mode: 'discovery', reason: 'Full review: ' + reason };
}

function parseStatusEntries(raw) {
  const tokens = String(raw).split('\0');
  if (tokens.at(-1) !== '') throw new Error('Unterminated name-status response');
  tokens.pop();
  const entries = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const file = tokens[i++];
    if (!status || !file) throw new Error('Invalid name-status entry');
    // Renames/copies require two paths; reject without parsing them further.
    if (/^[RC]/.test(status)) return null;
    if (!/^[MA]$/.test(status)) return null;
    entries.push({ status, path: file });
  }
  return entries;
}

function parseNumstat(raw) {
  const tokens = String(raw).split('\0');
  if (tokens.at(-1) !== '') throw new Error('Unterminated numstat response');
  tokens.pop();
  return tokens.map((token) => {
    const match = token.match(/^(\d+)\t(\d+)\t(.+)$/s);
    if (!match) return null; // Binary or rename/copy; require full review.
    return { additions: Number(match[1]), deletions: Number(match[2]), path: match[3] };
  });
}

export function classifyIncrementalDelta({ session, numstat, nameStatus, patch } = {}) {
  if (!session || session.status !== 'READY' || session.auditCompleted !== true || session.override) {
    return full('a previously completed non-overridden READY audit is required');
  }
  if ((session.incrementalReviewCount ?? 0) >= MAX_INCREMENTAL_REVIEWS) {
    return full('periodic full audit is due');
  }
  if (session.findings.length > 48 || Buffer.byteLength(JSON.stringify(session), 'utf8') > 16_000) {
    return full('durable finding ledger is nearing its size limit');
  }
  if (typeof patch !== 'string' || Buffer.byteLength(patch, 'utf8') > MAX_INCREMENTAL_PATCH_BYTES) {
    return full('delta patch exceeds its safe context limit');
  }

  let files, stats;
  try {
    files = parseStatusEntries(nameStatus);
    stats = parseNumstat(numstat);
  } catch {
    return full('malformed git diff metadata');
  }
  if (!files || !stats || !files.length || files.length !== stats.length) {
    return full('empty, renamed, deleted, binary, or ambiguous changes');
  }
  if (files.length > MAX_INCREMENTAL_FILES) return full('too many changed files');
  let changedLines = 0;
  for (let i = 0; i < files.length; i++) {
    const entry = files[i], stat = stats[i];
    if (!stat || entry.path !== stat.path || !Number.isSafeInteger(stat.additions)
        || !Number.isSafeInteger(stat.deletions)) return full('ambiguous change statistics');
    if (/[^\x20-\x7e]/.test(entry.path) || entry.path.includes('\\')
        || entry.path.split('/').includes('..')) return full('unusual changed path');
    if (HIGH_RISK_PATH.test(entry.path)) return full('high-risk path: ' + entry.path);
    if (!SAFE_DELTA_EXTENSION.test(entry.path)) return full('unclassified file type: ' + entry.path);
    changedLines += stat.additions + stat.deletions;
    if (changedLines > MAX_INCREMENTAL_LINES) return full('delta exceeds line budget');
  }
  if (!patch.startsWith('diff --git ')) return full('delta patch is missing');
  const changedText = patch.split('\n')
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++'))
      || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => line.slice(1)).join('\n');
  if (HIGH_RISK_CHANGE.test(changedText)) return full('high-risk code behavior changed');
  return {
    mode: 'incremental',
    reason: 'Review only the delta and its related code context',
    files: files.length,
    changedLines,
  };
}

function git(repoDir, args, env = process.env) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 45_000,
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A comparison of exact trees covers even force-pushes or rebases: no ancestry
// assumption is needed. If the old Git object cannot be fetched, review fully.
export function prepareIncrementalDelta({
  repoDir = 'target', contextDir = '.review-context', previousHead, headSha, session,
  token = process.env.GH_TOKEN,
} = {}) {
  const sha = /^[0-9a-f]{40}$/i;
  if (!sha.test(previousHead) || !sha.test(headSha)) return full('invalid review baseline SHA');
  try {
    try {
      git(repoDir, ['cat-file', '-e', previousHead + '^{commit}']);
    } catch {
      // actions/checkout uses persist-credentials:false. Supply the scoped App
      // token to this fetch only; never persist it in the target checkout.
      if (!token) return full('old reviewed revision cannot be fetched');
      const auth = Buffer.from('x-access-token:' + token).toString('base64');
      const env = { ...process.env, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + auth };
      git(repoDir, ['fetch', '--no-tags', '--depth=1', 'origin', previousHead], env);
    }
    const base = ['--no-ext-diff', '--no-textconv', previousHead, headSha];
    const nameStatus = git(repoDir, ['diff', '--name-status', '-z', ...base]);
    const numstat = git(repoDir, ['diff', '--numstat', '-z', ...base]);
    const patch = git(repoDir, ['diff', '--unified=80', ...base]);
    const scope = classifyIncrementalDelta({ session, nameStatus, numstat, patch });
    if (scope.mode === 'incremental') {
      fs.writeFileSync(path.join(contextDir, 'repair.diff'), patch, { mode: 0o600 });
    }
    return scope;
  } catch {
    return full('prior SHA or exact delta unavailable');
  }
}
