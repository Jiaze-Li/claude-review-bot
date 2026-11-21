// Pure helpers for the unified review: ignore rules, Git path decoding, per-file diff splitting.

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

// Git quotes non-ASCII and control characters with C-style byte escapes by default.
// Decode name-only output and diff headers to the same UTF-8 repository paths.
export function decodeGitPath(path) {
  if (!path.startsWith('"')) return path;
  if (!path.endsWith('"')) throw new Error('Malformed Git-quoted path: unterminated quote');
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < path.length - 1; i += 1) {
    if (path[i] !== '\\') {
      const codePoint = path.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) i += 1;
      continue;
    }
    const escape = path[++i];
    if (escape === undefined || i >= path.length - 1) throw new Error('Malformed Git-quoted path: dangling escape');
    if (/^[0-7]$/.test(escape)) {
      const octal = path.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal) || i + 2 >= path.length - 1) throw new Error('Malformed Git-quoted path: invalid octal escape');
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (Object.hasOwn(escapes, escape)) {
      bytes.push(escapes[escape]);
    } else {
      throw new Error(`Malformed Git-quoted path: unknown escape \\${escape}`);
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

// Quoted paths have unambiguous boundaries. For unquoted headers Git does not
// quote ordinary spaces, so the literal " b/" can also be part of either path.
// Prefer matching identical source/destination names, then Git's rename/copy
// metadata for ambiguous moves. Never guess between multiple boundaries.
function parseDiffHeaderPath(line, followingLines = []) {
  const match = line.match(/^diff --git (?:"a\/((?:\\.|[^"\\])*)"|a\/(.+)) (?:"b\/((?:\\.|[^"\\])*)"|b\/(.+))$/);
  if (!match) throw new Error(`Cannot parse Git diff header: ${line.slice(0, 300)}`);
  if (match[3] !== undefined) return decodeGitPath(`"${match[3]}"`);
  if (match[1] !== undefined) return match[4];

  const body = line.slice('diff --git a/'.length);
  const candidates = [];
  let position = -1;
  while ((position = body.indexOf(' b/', position + 1)) !== -1) {
    const source = body.slice(0, position);
    const destination = body.slice(position + 3);
    if (!source || !destination) continue;
    if (source === destination) return destination;
    candidates.push(destination);
  }
  if (candidates.length === 1) return candidates[0];
  const metadata = followingLines.find((entry) => entry.startsWith('rename to ') || entry.startsWith('copy to '));
  if (metadata) return decodeGitPath(metadata.slice(metadata.indexOf(' to ') + 4));
  throw new Error(`Cannot disambiguate Git diff header: ${line.slice(0, 300)}`);
}

// One entry per `diff --git` block: { path, text, bytes }.
// Parse after collecting metadata, and fail closed on unknown headers.
export function splitDiffByFile(diffText) {
  const chunks = [];
  let current = null;
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { lines: [line] };
      chunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return chunks.map((c) => {
    const path = parseDiffHeaderPath(c.lines[0], c.lines.slice(1));
    const joined = c.lines.join('\n');
    const text = joined.endsWith('\n') ? joined : `${joined}\n`;
    return { path, text, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

// Name-only and full diff come from the same Git comparison. A missing block
// indicates path mismatch/truncated input and must not generate an empty shard.
export function assertDiffCoverage(files, chunks) {
  const present = new Set(chunks.map((chunk) => chunk.path));
  const missing = [...new Set(files)].filter((file) => !present.has(file));
  if (missing.length) {
    throw new Error(`Missing Git diff block for ${missing.length} changed file(s): ${missing.slice(0, 5).join(', ')}; refusing incomplete review`);
  }
}

// Lockfiles, docs, fixtures and tests are reviewed after source files when the shard
// count has to be limited.
export function filePriority(path) {
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Package\.resolved)$/.test(path)) return 0;
  if (/\.(md|txt|json|svg|png|jpg|pdf)$/i.test(path)) return 0;
  if (/(^|\/)(tests?|__tests__|docs?|fixtures?)\//i.test(path)) return 0;
  return 1;
}
