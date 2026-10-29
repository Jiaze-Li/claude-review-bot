// Pure helpers that split a large PR diff into independently reviewable shards and
// merge the per-shard results back into one review with honest coverage.

export const SHARD_TARGET_BYTES = 100_000;
export const MAX_SHARDS = 20;
// Findings recorded in the durable session are capped; material ones are kept first.
export const MAX_MERGED_FINDINGS = 6;
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const MATERIAL = new Set(['P0', 'P1', 'P2']);

// Files whose diff has nothing a reviewer can read. Lockfiles and generated code are NOT
// here on purpose (a dependency or build change can matter); a repository opts those in
// with a .reviewbotignore read from the PR's base commit, never from the PR itself.
export const DEFAULT_IGNORE = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.icns', '*.pdf', '*.woff', '*.woff2', '*.ttf', '*.otf'];

export function parseIgnorePatterns(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.length <= 200).slice(0, 200);
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

// gitignore-like: a trailing slash matches a directory anywhere; a pattern with no slash
// matches a file name anywhere; otherwise it is anchored at the repository root.
export function matchesIgnore(path, patterns) {
  return patterns.some((raw) => {
    let pattern = raw.replace(/^\//, '');
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = raw.startsWith('/') || pattern.includes('/');
    const prefix = anchored ? '^' : '^(?:.*/)?';
    return new RegExp(`${prefix}${globToRegExp(pattern)}${dirOnly ? '/.*' : '(?:/.*)?'}$`, 'i').test(path);
  });
}

// One entry per `diff --git` block: { path, text, bytes }.
export function splitDiffByFile(diffText) {
  const chunks = [];
  let current = null;
  for (const line of String(diffText ?? '').split('\n')) {
    const header = line.startsWith('diff --git ') ? line.match(/^diff --git a\/.+ b\/(.+)$/) : null;
    if (line.startsWith('diff --git ')) {
      current = { path: header ? header[1] : null, lines: [line] };
      chunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return chunks.filter((c) => c.path).map((c) => {
    const joined = c.lines.join('\n');
    const text = joined.endsWith('\n') ? joined : `${joined}\n`;
    return { path: c.path, text, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

// Lockfiles, docs, fixtures and tests are reviewed after source files when the shard
// count has to be limited.
export function filePriority(path) {
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Package\.resolved)$/.test(path)) return 0;
  if (/\.(md|txt|json|svg|png|jpg|pdf)$/i.test(path)) return 0;
  if (/(^|\/)(tests?|__tests__|docs?|fixtures?)\//i.test(path)) return 0;
  return 1;
}

// `files` is the trusted changed-file list; chunks provide sizes and text. A changed
// file with no diff block (binary, mode change) still needs a home so coverage is exact.
export function planShards({ files, chunks, targetBytes = SHARD_TARGET_BYTES, maxShards = MAX_SHARDS }) {
  const byPath = new Map(chunks.map((c) => [c.path, c]));
  const entries = [...new Set([...files, ...byPath.keys()])].sort().map((path) => ({
    path, bytes: byPath.get(path)?.bytes ?? 0, text: byPath.get(path)?.text ?? '',
  }));
  const groups = [];
  let current = null;
  for (const entry of entries) {
    if (current && current.bytes + entry.bytes <= targetBytes) {
      current.entries.push(entry);
      current.bytes += entry.bytes;
    } else {
      current = { entries: [entry], bytes: entry.bytes };
      groups.push(current);
    }
  }
  const ranked = groups
    .map((group, order) => ({
      files: group.entries.map((e) => e.path),
      bytes: group.bytes,
      diff: group.entries.map((e) => e.text).join(''),
      priority: Math.max(...group.entries.map((e) => filePriority(e.path))),
      order,
    }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  return {
    shards: ranked.slice(0, maxShards).map(({ files: f, bytes, diff }) => ({ files: f, bytes, diff })),
    deferred: ranked.slice(maxShards).flatMap((g) => g.files),
  };
}

// Normalise one review's coverage claim against the trusted list of files it was
// assigned: anything not credited as reviewed counts as unreviewed.
export function reconcileCoverage(coverage, assignedFiles) {
  const assigned = new Set(assignedFiles);
  const reviewed = new Set((coverage?.reviewedPaths ?? []).filter((p) => assigned.has(p)));
  const unreviewed = [...new Set([
    ...(coverage?.unreviewedPaths ?? []).filter((p) => assigned.has(p)),
    ...assignedFiles.filter((p) => !reviewed.has(p)),
  ])];
  return {
    complete: coverage?.complete === true && unreviewed.length === 0,
    reviewedPaths: [...reviewed],
    unreviewedPaths: unreviewed,
    note: typeof coverage?.note === 'string' ? coverage.note : '',
  };
}

// results[i] is { ok: true, structured } or { ok: false, error } for shards[i]; shards
// that never started have no entry.
export function mergeShardResults({ shards, results, deferred = [], allFiles, priorReviewed = [], ignoredCount = 0 }) {
  const reviewed = new Set(priorReviewed);
  const notes = [];
  const findings = new Map();
  const summaries = [];
  let failedShards = 0;
  const shardStats = [];

  shards.forEach((shard, index) => {
    const result = results[index];
    if (!result?.ok) {
      failedShards += 1;
      shardStats.push(`${index + 1}: ${result ? 'failed' : 'not run'} 0/${shard.files.length}`);
      notes.push(`shard ${index + 1}/${shards.length} ${result ? `failed (${String(result.error).slice(0, 80)})` : 'did not run'}`);
      return;
    }
    const coverage = reconcileCoverage(result.structured.coverage, shard.files);
    shardStats.push(`${index + 1}: ok ${coverage.reviewedPaths.length}/${shard.files.length}`);
    coverage.reviewedPaths.forEach((p) => reviewed.add(p));
    if (!coverage.complete && coverage.note) notes.push(coverage.note);
    if (result.structured.summary) summaries.push(String(result.structured.summary).trim());
    for (const finding of result.structured.findings ?? []) {
      const key = `${finding.path}\0${String(finding.title).trim().toLowerCase()}`;
      if (!findings.has(key)) findings.set(key, finding);
    }
  });

  const unreviewedPaths = allFiles.filter((p) => !reviewed.has(p));
  if (deferred.length) notes.push(`${deferred.length} file(s) were beyond the ${shards.length}-shard limit`);
  const complete = unreviewedPaths.length === 0 && failedShards === 0;

  const ordered = [...findings.values()].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const kept = ordered.slice(0, MAX_MERGED_FINDINGS);
  const droppedMaterial = ordered.slice(MAX_MERGED_FINDINGS).filter((f) => MATERIAL.has(f.severity)).length;

  const prior = priorReviewed.length ? ` (${priorReviewed.length} already covered by an earlier run on this HEAD)` : '';
  const ignored = ignoredCount ? ` ${ignoredCount} more file(s) skipped by ignore rules.` : '';
  const header = `Reviewed ${reviewed.size} of ${allFiles.length} changed file(s) in ${shards.length} shard(s)${prior}${complete ? '' : ' — PARTIAL'}.${ignored}`;
  const extra = [
    ...(shards.length > 1 || deferred.length ? [`Shards (reviewed/assigned): ${shardStats.join(' · ')}${deferred.length ? ` · deferred beyond limit: ${deferred.length} file(s)` : ''}.`] : []),
    ...(droppedMaterial ? [`${droppedMaterial} more material finding(s) were omitted to fit the session limit; fix the listed ones and re-review.`] : []),
    ...(complete ? [] : [`Not reviewed: ${unreviewedPaths.slice(0, 15).join(', ')}${unreviewedPaths.length > 15 ? `, … (+${unreviewedPaths.length - 15})` : ''}.`]),
  ];
  const budget = 3500 - header.length - extra.join(' ').length;
  const perShard = Math.max(120, Math.floor(budget / Math.max(1, summaries.length)));
  const summary = [header, ...extra, ...summaries.map((s) => s.slice(0, perShard))].join('\n\n').slice(0, 3900);

  return {
    summary,
    shardStats,
    findings: kept,
    coverage: {
      complete,
      reviewedPaths: [...reviewed],
      unreviewedPaths,
      note: notes.join('; ').slice(0, 300),
    },
  };
}
