import fs from 'node:fs';
import path from 'node:path';
import { matchesIgnore } from './review-shards.mjs';

export const TOOL_NAMES = Object.freeze({ READ: 'Read', GLOB: 'Glob', GREP: 'Grep' });
export const DEFAULT_LIMITS = Object.freeze({
  MAX_CALLS: 100, MAX_CALL_READ_BYTES: 256 * 1024, MAX_TOTAL_READ_BYTES: 5 * 1024 * 1024, MAX_READ_LINES: 2000,
  MAX_GLOB_MATCHES: 500, MAX_GREP_MATCHES: 200, MAX_GREP_FILE_BYTES: 1024 * 1024, MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, TIMEOUT_MS: 30_000,
});

const CONTROL_FILENAMES = new Set(['CLAUDE.md', '.mcp.json']);
const CONTROL_DIRNAMES = new Set(['.git', '.claude']);

export function isControlPath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath) return false;
  const parts = candidatePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((p) => CONTROL_DIRNAMES.has(p)) || Boolean(parts.length && CONTROL_FILENAMES.has(parts[parts.length - 1]));
}

export function isInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function isSafeGlobPattern(val) {
  if (typeof val !== 'string' || !val || val.includes('\0') || path.isAbsolute(val)) return false;
  return !val.split(/[\\/]+/).includes('..');
}

export function resolveAllowedPath(requestedPath, allowedRoots, { mustExist = true, cwd = process.cwd() } = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) {
    return { ok: false, error: 'Path must be a non-empty string without null bytes.' };
  }
  const absolute = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(cwd, requestedPath);
  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (err) {
    if (mustExist) return { ok: false, error: `Path does not exist: ${err?.message ?? err}` };
    real = absolute;
  }
  const matchedRoot = (allowedRoots || []).find((root) => isInside(root, real));
  if (!matchedRoot) return { ok: false, error: `Path escapes authorized boundaries: ${requestedPath}` };
  if (isControlPath(real) || isControlPath(requestedPath)) return { ok: false, error: `Access to control path is forbidden: ${requestedPath}` };
  return { ok: true, realPath: real, matchedRoot };
}

function isDangerousRegexPattern(p) {
  if (typeof p !== 'string' || p.length > 500) return true;
  return /\([^)]*[*+][^)]*\)[*+]/.test(p) || /([*+])\s*([*+])/.test(p);
}

function safeWalk({ searchRoot, safeRoot, ignorePatterns, timeoutMs, onFile }) {
  const deadline = Date.now() + timeoutMs;
  const visitedRealDirs = new Set();
  try { visitedRealDirs.add(fs.realpathSync.native(searchRoot)); } catch {}

  const walk = (dir) => {
    if (Date.now() > deadline) throw new Error(`Operation timed out after ${timeoutMs}ms`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() > deadline) throw new Error(`Operation timed out after ${timeoutMs}ms`);
      const fullPath = path.join(dir, entry.name);
      let real;
      try { real = fs.realpathSync.native(fullPath); } catch { continue; }
      if (safeRoot && !isInside(safeRoot, real)) continue;
      const relToRepo = safeRoot ? path.relative(safeRoot, fullPath).replace(/\\/g, '/') : entry.name;
      const realRelToRepo = safeRoot ? path.relative(safeRoot, real).replace(/\\/g, '/') : entry.name;
      if (isControlPath(relToRepo) || isControlPath(realRelToRepo) || isControlPath(entry.name)) continue;
      if (matchesIgnore(relToRepo, ignorePatterns) || matchesIgnore(realRelToRepo, ignorePatterns)) continue;

      let stat;
      try { stat = fs.statSync(real); } catch { continue; }
      if (stat.isDirectory()) {
        if (!visitedRealDirs.has(real)) { visitedRealDirs.add(real); walk(fullPath); }
      } else if (stat.isFile() && onFile({ fullPath, realPath: real, relToRepo, stat, entryName: entry.name })) {
        return true;
      }
    }
  };
  walk(searchRoot);
}

export class ReadOnlyToolGateway {
  constructor(options = {}) {
    this.safeRoot = options.safeRoot ? realDirPath(options.safeRoot) : null;
    this.contextRoot = options.contextRoot ? realDirPath(options.contextRoot) : null;
    this.cwd = options.cwd ? realDirPath(options.cwd) : process.cwd();
    this.ignorePatterns = Array.isArray(options.ignorePatterns) ? [...options.ignorePatterns] : [];
    this.maxCalls = positiveInt(options.maxCalls, DEFAULT_LIMITS.MAX_CALLS);
    this.maxCallReadBytes = positiveInt(options.maxCallReadBytes, DEFAULT_LIMITS.MAX_CALL_READ_BYTES);
    this.maxTotalReadBytes = positiveInt(options.maxTotalReadBytes, DEFAULT_LIMITS.MAX_TOTAL_READ_BYTES);
    this.maxReadLines = positiveInt(options.maxReadLines, DEFAULT_LIMITS.MAX_READ_LINES);
    this.maxGlobMatches = positiveInt(options.maxGlobMatches, DEFAULT_LIMITS.MAX_GLOB_MATCHES);
    this.maxGrepMatches = positiveInt(options.maxGrepMatches, DEFAULT_LIMITS.MAX_GREP_MATCHES);
    this.maxGrepFileBytes = positiveInt(options.maxGrepFileBytes, DEFAULT_LIMITS.MAX_GREP_FILE_BYTES);
    this.maxFileSizeBytes = positiveInt(options.maxFileSizeBytes, DEFAULT_LIMITS.MAX_FILE_SIZE_BYTES);
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULT_LIMITS.TIMEOUT_MS);
    this.logImpl = typeof options.logImpl === 'function' ? options.logImpl : null;
    this.readRoots = [this.safeRoot, this.contextRoot].filter(Boolean);
    this.searchRoots = [this.safeRoot].filter(Boolean);
    this.callCount = 0;
    this.totalReadBytes = 0;
    this.quotaExhausted = false;
    this.rejections = [];
    this.history = [];
  }

  getDiagnostics() {
    return {
      callCount: this.callCount, maxCalls: this.maxCalls, totalReadBytes: this.totalReadBytes, maxTotalReadBytes: this.maxTotalReadBytes,
      quotaExhausted: this.quotaExhausted, rejectionCount: this.rejections.length, rejections: [...this.rejections], history: [...this.history],
    };
  }

  logDiagnostic(msg) {
    if (this.logImpl) this.logImpl(`[ToolGateway] ${msg}`);
  }

  checkQuota() {
    if (this.callCount >= this.maxCalls) {
      this.quotaExhausted = true;
      return { ok: false, reason: `Tool invocation limit exceeded: reached ${this.maxCalls} calls.` };
    }
    return this.checkRemainingQuota();
  }

  checkRemainingQuota(toolName = null, input = null) {
    const remaining = Math.max(0, this.maxTotalReadBytes - this.totalReadBytes);
    if (remaining <= 0) {
      this.quotaExhausted = true;
      const error = `Read byte quota exceeded: reached ${this.totalReadBytes} bytes.`;
      if (toolName) this.recordRejection(toolName, input, error);
      return { ok: false, error, reason: error, kind: 'quota_exhausted' };
    }
    return { ok: true, remaining };
  }

  recordRejection(toolName, input, reason) {
    const entry = { toolName, input, reason, timestamp: Date.now() };
    this.rejections.push(entry);
    this.history.push({ ...entry, status: 'rejected' });
    this.logDiagnostic(`REJECT ${toolName}: ${reason}`);
  }

  recordSuccess(toolName, input, bytes, truncated = false) {
    this.callCount += 1;
    this.totalReadBytes += bytes;
    if (this.totalReadBytes >= this.maxTotalReadBytes) this.quotaExhausted = true;
    this.history.push({ toolName, input, bytes, truncated, timestamp: Date.now(), status: 'success' });
    this.logDiagnostic(`ALLOW ${toolName}: ${bytes} bytes`);
  }

  async authorize(toolName, input) {
    const quota = this.checkQuota();
    if (!quota.ok) return this.denyAndRecord(toolName, input, quota.reason);

    if (toolName === TOOL_NAMES.READ) {
      if (!this.readRoots.length) return this.denyAndRecord(toolName, input, 'No authorized read roots configured.');
      const resolved = resolveAllowedPath(input?.file_path, this.readRoots, { mustExist: true, cwd: this.cwd });
      if (!resolved.ok) return this.denyAndRecord(toolName, input, resolved.error);
      const relToRoot = path.relative(resolved.matchedRoot, resolved.realPath).replace(/\\/g, '/');
      if (matchesIgnore(relToRoot, this.ignorePatterns)) return this.denyAndRecord(toolName, input, `Read is denied for ignored path: ${input?.file_path}`);
      try {
        const stat = fs.statSync(resolved.realPath);
        if (!stat.isFile()) return this.denyAndRecord(toolName, input, `Read target is not a regular file: ${input?.file_path}`);
        if (stat.size > this.maxFileSizeBytes) return this.denyAndRecord(toolName, input, `File size exceeds safety limit of ${this.maxFileSizeBytes} bytes.`);
      } catch (err) {
        return this.denyAndRecord(toolName, input, `Cannot stat file ${input?.file_path}: ${err?.message ?? err}`);
      }
      const offset = positiveInt(input?.offset, 1);
      const limit = Math.min(positiveInt(input?.limit, this.maxReadLines), this.maxReadLines);
      return { behavior: 'allow', updatedInput: { ...input, file_path: resolved.realPath, offset, limit } };
    }

    if (toolName === TOOL_NAMES.GLOB) {
      if (!this.searchRoots.length) return this.denyAndRecord(toolName, input, 'No authorized search roots configured.');
      if (!isSafeGlobPattern(input?.pattern)) return this.denyAndRecord(toolName, input, 'Glob pattern escapes the sanitized repository.');
      const searchRoot = input?.path ? resolveAllowedPath(input.path, this.searchRoots, { mustExist: true, cwd: this.cwd }) : { ok: true, realPath: this.searchRoots[0] };
      if (!searchRoot.ok) return this.denyAndRecord(toolName, input, 'Glob is restricted to safe-target/.');
      return { behavior: 'allow', updatedInput: { ...input, path: searchRoot.realPath } };
    }

    if (toolName === TOOL_NAMES.GREP) {
      if (!this.searchRoots.length) return this.denyAndRecord(toolName, input, 'No authorized search roots configured.');
      if (typeof input?.pattern !== 'string' || input.pattern.includes('\0') || !input.pattern) return this.denyAndRecord(toolName, input, 'Invalid Grep pattern.');
      if (isDangerousRegexPattern(input.pattern)) return this.denyAndRecord(toolName, input, 'Invalid Grep pattern: complex or potential ReDoS pattern rejected.');
      if (input?.glob && !isSafeGlobPattern(input.glob)) return this.denyAndRecord(toolName, input, 'Grep glob escapes the sanitized repository.');
      const searchRoot = input?.path ? resolveAllowedPath(input.path, this.searchRoots, { mustExist: true, cwd: this.cwd }) : { ok: true, realPath: this.searchRoots[0] };
      if (!searchRoot.ok) return this.denyAndRecord(toolName, input, 'Grep is restricted to safe-target/.');
      return { behavior: 'allow', updatedInput: { ...input, path: searchRoot.realPath } };
    }

    return this.denyAndRecord(toolName, input, `Tool ${toolName} is not available in review-only mode.`);
  }

  denyAndRecord(toolName, input, message) {
    this.recordRejection(toolName, input, message);
    return { behavior: 'deny', message };
  }

  async executeRead(input) {
    const q = this.checkRemainingQuota(TOOL_NAMES.READ, input);
    if (!q.ok) return q;

    const auth = await this.authorize(TOOL_NAMES.READ, input);
    if (auth.behavior !== 'allow') return { ok: false, error: auth.message, kind: 'denied' };

    const { file_path: filePath, offset, limit } = auth.updatedInput;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, q.remaining);

    try {
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const trimmed = rawContent.endsWith('\n') ? rawContent.slice(0, -1) : rawContent;
      const allLines = trimmed.length ? trimmed.split(/\r?\n/) : [];
      const startLineIndex = Math.max(0, offset - 1);
      const selectedLines = allLines.slice(startLineIndex, startLineIndex + limit);

      let text = selectedLines.join('\n');
      let truncated = false;
      let byteLen = Buffer.byteLength(text, 'utf8');

      if (byteLen > effectiveMaxBytes) {
        truncated = true;
        const buf = Buffer.from(text, 'utf8').subarray(0, effectiveMaxBytes);
        text = `${buf.toString('utf8')}\n[... truncated by host gateway: output exceeded limit of ${effectiveMaxBytes} bytes ...]`;
        byteLen = Buffer.byteLength(text, 'utf8');
      }

      this.recordSuccess(TOOL_NAMES.READ, input, byteLen, truncated);
      return { ok: true, content: text, lines: selectedLines.length, totalLines: allLines.length, offset, limit, truncated, bytesRead: byteLen };
    } catch (err) {
      const msg = `Failed to read file ${filePath}: ${err?.message ?? err}`;
      this.recordRejection(TOOL_NAMES.READ, input, msg);
      return { ok: false, error: msg, kind: 'io_error' };
    }
  }

  async executeGlob(input) {
    const q = this.checkRemainingQuota(TOOL_NAMES.GLOB, input);
    if (!q.ok) return q;

    const auth = await this.authorize(TOOL_NAMES.GLOB, input);
    if (auth.behavior !== 'allow') return { ok: false, error: auth.message, kind: 'denied' };

    const { pattern, path: searchRoot } = auth.updatedInput;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, q.remaining);
    const regex = globToRegExp(pattern);
    const matches = [];
    let truncated = false;

    try {
      safeWalk({
        searchRoot,
        safeRoot: this.safeRoot,
        ignorePatterns: this.ignorePatterns,
        timeoutMs: this.timeoutMs,
        onFile: ({ fullPath, relToRepo, entryName }) => {
          if (matches.length >= this.maxGlobMatches) { truncated = true; return true; }
          const relToSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
          if (regex.test(relToSearch) || regex.test(relToRepo) || regex.test(entryName)) matches.push(relToRepo);
          return false;
        },
      });

      let byteLen = Buffer.byteLength(JSON.stringify(matches), 'utf8');
      if (byteLen > effectiveMaxBytes) {
        truncated = true;
        while (matches.length > 0 && Buffer.byteLength(JSON.stringify(matches), 'utf8') > effectiveMaxBytes) matches.pop();
        byteLen = Buffer.byteLength(JSON.stringify(matches), 'utf8');
      }

      this.recordSuccess(TOOL_NAMES.GLOB, input, byteLen, truncated);
      return { ok: true, matches, count: matches.length, truncated, bytes: byteLen };
    } catch (err) {
      const msg = `Glob execution failed: ${err?.message ?? err}`;
      this.recordRejection(TOOL_NAMES.GLOB, input, msg);
      return { ok: false, error: msg, kind: String(err?.message ?? '').includes('timed out') ? 'timeout' : 'io_error' };
    }
  }

  async executeGrep(input) {
    const q = this.checkRemainingQuota(TOOL_NAMES.GREP, input);
    if (!q.ok) return q;

    const auth = await this.authorize(TOOL_NAMES.GREP, input);
    if (auth.behavior !== 'allow') return { ok: false, error: auth.message, kind: 'denied' };

    const { pattern, path: searchRoot, glob: fileGlob } = auth.updatedInput;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, q.remaining);

    let regex;
    try { regex = new RegExp(pattern); } catch { regex = new RegExp(escapeRegExp(pattern)); }
    const globRegex = fileGlob ? globToRegExp(fileGlob) : null;
    const matches = [];
    let truncated = false;
    let totalBytes = 0;

    try {
      safeWalk({
        searchRoot,
        safeRoot: this.safeRoot,
        ignorePatterns: this.ignorePatterns,
        timeoutMs: this.timeoutMs,
        onFile: ({ realPath, relToRepo, stat, entryName, fullPath }) => {
          if (matches.length >= this.maxGrepMatches || totalBytes >= effectiveMaxBytes) { truncated = true; return true; }
          const relToSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
          if (globRegex && !globRegex.test(relToSearch) && !globRegex.test(relToRepo) && !globRegex.test(entryName)) return false;
          if (stat.size > this.maxGrepFileBytes) return false;

          try {
            const lines = fs.readFileSync(realPath, 'utf8').split(/\r?\n/);
            for (let lineNum = 1; lineNum <= lines.length; lineNum += 1) {
              const line = lines[lineNum - 1];
              const testLine = line.length > 2000 ? line.slice(0, 2000) : line;
              if (regex.test(testLine)) {
                const matchEntry = { path: relToRepo, line: lineNum, text: testLine.slice(0, 1000) };
                const entryBytes = Buffer.byteLength(JSON.stringify(matchEntry), 'utf8');
                if (totalBytes + entryBytes > effectiveMaxBytes) { truncated = true; return true; }
                matches.push(matchEntry);
                totalBytes += entryBytes;
                if (matches.length >= this.maxGrepMatches) { truncated = true; return true; }
              }
            }
          } catch {}
          return false;
        },
      });

      this.recordSuccess(TOOL_NAMES.GREP, input, totalBytes, truncated);
      return { ok: true, matches, count: matches.length, truncated, bytes: totalBytes };
    } catch (err) {
      const msg = `Grep execution failed: ${err?.message ?? err}`;
      this.recordRejection(TOOL_NAMES.GREP, input, msg);
      return { ok: false, error: msg, kind: String(err?.message ?? '').includes('timed out') ? 'timeout' : 'io_error' };
    }
  }

  executeTool(name, input) {
    if (name === TOOL_NAMES.READ) return this.executeRead(input);
    if (name === TOOL_NAMES.GLOB) return this.executeGlob(input);
    if (name === TOOL_NAMES.GREP) return this.executeGrep(input);
    return { ok: false, error: `Tool ${name} is not available.`, kind: 'unknown_tool' };
  }

  createCanUseTool() {
    return async (toolName, input) => this.authorize(toolName, input);
  }

  createPostToolHook() {
    const gateway = this;
    return {
      matcher: 'Read|Glob|Grep',
      hooks: [
        async ({ tool_name, tool_input, tool_response: resp }) => {
          if (!resp) return {};
          const limit = Math.min(gateway.maxCallReadBytes, Math.max(0, gateway.maxTotalReadBytes - gateway.totalReadBytes));
          const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
          const byteLen = Buffer.byteLength(str, 'utf8');
          if (byteLen <= limit) {
            gateway.recordSuccess(tool_name, tool_input, byteLen, false);
            return {};
          }
          const note = `[... output truncated by host gateway: exceeded limit of ${limit} bytes ...]`;
          let out = null;
          if (typeof resp === 'string') out = `${Buffer.from(resp, 'utf8').subarray(0, Math.max(0, limit - 100)).toString('utf8')}\n${note}`;
          else if (Array.isArray(resp)) {
            out = [];
            let cur = 0;
            for (const item of resp) {
              const b = Buffer.byteLength(JSON.stringify(item), 'utf8');
              if (cur + b > limit - 200) break;
              out.push(item);
              cur += b;
            }
            out.push({ _truncated: true, _note: note });
          } else if (resp && typeof resp === 'object') {
            out = { _truncated: true, _note: note, partial: Buffer.from(str, 'utf8').subarray(0, Math.max(0, limit - 150)).toString('utf8') };
          } else out = note;

          const rec = Math.min(limit, Buffer.byteLength(JSON.stringify(out) || String(out), 'utf8'));
          gateway.recordSuccess(tool_name, tool_input, rec, true);
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out } };
        },
      ],
    };
  }

  static getToolDeclarations() {
    return [
      { name: 'Read', description: 'Read file contents from sanitized repository snapshot or review context.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['file_path'] } },
      { name: 'Glob', description: 'Find files matching a glob pattern within the sanitized repository.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Grep', description: 'Search for a pattern across files within the sanitized repository.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
    ];
  }
}

function realDirPath(value) {
  try {
    const resolved = fs.realpathSync.native(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${value} is not a directory`);
    return resolved;
  } catch {
    return path.resolve(value);
  }
}

function positiveInt(val, fallback) {
  const num = Number(val);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  let reStr = '^', i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { reStr += '(?:.+/)?'; i += 3; continue; }
        reStr += '.*'; i += 2; continue;
      }
      reStr += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { reStr += '[^/]'; i += 1; continue; }
    if (['.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\'].includes(c)) reStr += `\\${c}`;
    else reStr += c;
    i += 1;
  }
  return new RegExp(`${reStr}$`);
}