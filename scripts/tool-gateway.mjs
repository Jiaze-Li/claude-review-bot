import fs from 'node:fs';
import path from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { matchesIgnore } from './review-shards.mjs';

export const TOOL_NAMES = Object.freeze({ READ: 'Read', GLOB: 'Glob', GREP: 'Grep' });
export const DEFAULT_LIMITS = Object.freeze({
  MAX_CALLS: 100, MAX_CALL_READ_BYTES: 262144, MAX_TOTAL_READ_BYTES: 5242880, MAX_READ_LINES: 2000,
  MAX_GLOB_MATCHES: 500, MAX_GREP_MATCHES: 200, MAX_GREP_FILE_BYTES: 1048576, MAX_FILE_SIZE_BYTES: 10485760, TIMEOUT_MS: 30_000,
});

const CONTROL_PATHS = new Set(['CLAUDE.md', '.mcp.json', '.git', '.claude']);

export function isControlPath(p) {
  return typeof p === 'string' && Boolean(p) && p.replace(/\\/g, '/').split('/').some((x) => CONTROL_PATHS.has(x));
}

export function isInside(root, candidate) {
  return typeof root === 'string' && typeof candidate === 'string' && (candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

export function isSafeGlobPattern(val) {
  return typeof val === 'string' && Boolean(val) && !val.includes('\0') && !path.isAbsolute(val) && !val.split(/[\\/]+/).includes('..');
}

export function resolveAllowedPath(requestedPath, allowedRoots, { mustExist = true, cwd = process.cwd() } = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) return { ok: false, error: 'Path must be a non-empty string without null bytes.' };
  const absolute = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(cwd, requestedPath);
  let real;
  try { real = fs.realpathSync.native(absolute); } catch (err) {
    if (mustExist) return { ok: false, error: `Path does not exist: ${err?.message ?? err}` };
    real = absolute;
  }
  const matchedRoot = (allowedRoots || []).find((root) => isInside(root, real));
  if (!matchedRoot) return { ok: false, error: `Path escapes authorized boundaries: ${requestedPath}` };
  if (isControlPath(real) || isControlPath(requestedPath)) return { ok: false, error: `Access to control path is forbidden: ${requestedPath}` };
  return { ok: true, realPath: real, matchedRoot };
}

function isDangerousRegexPattern(p) {
  return typeof p !== 'string' || p.length > 500 || /\([^)]*[*+][^)]*\)[*+]/.test(p) || /([*+])\s*([*+])/.test(p);
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

const truncMsg = (n) => `\n[... output truncated by host gateway: exceeded limit of ${n} bytes ...]`;

export class ReadOnlyToolGateway {
  constructor(options = {}) {
    this.safeRoot = options.safeRoot ? realDirPath(options.safeRoot) : null;
    this.contextRoot = options.contextRoot ? realDirPath(options.contextRoot) : null;
    this.cwd = options.cwd ? realDirPath(options.cwd) : process.cwd();
    this.ignorePatterns = Array.isArray(options.ignorePatterns) ? [...options.ignorePatterns] : [];
    const p = (k, d) => positiveInt(options[k], d);
    this.maxCalls = p('maxCalls', DEFAULT_LIMITS.MAX_CALLS);
    this.maxCallReadBytes = p('maxCallReadBytes', DEFAULT_LIMITS.MAX_CALL_READ_BYTES);
    this.maxTotalReadBytes = p('maxTotalReadBytes', DEFAULT_LIMITS.MAX_TOTAL_READ_BYTES);
    this.maxReadLines = p('maxReadLines', DEFAULT_LIMITS.MAX_READ_LINES);
    this.maxGlobMatches = p('maxGlobMatches', DEFAULT_LIMITS.MAX_GLOB_MATCHES);
    this.maxGrepMatches = p('maxGrepMatches', DEFAULT_LIMITS.MAX_GREP_MATCHES);
    this.maxGrepFileBytes = p('maxGrepFileBytes', DEFAULT_LIMITS.MAX_GREP_FILE_BYTES);
    this.maxFileSizeBytes = p('maxFileSizeBytes', DEFAULT_LIMITS.MAX_FILE_SIZE_BYTES);
    this.timeoutMs = p('timeoutMs', DEFAULT_LIMITS.TIMEOUT_MS);
    this.logImpl = typeof options.logImpl === 'function' ? options.logImpl : null;
    this.readRoots = [this.safeRoot, this.contextRoot].filter(Boolean);
    this.searchRoots = [this.safeRoot].filter(Boolean);
    this.allowedContextFiles = Array.isArray(options.allowedContextFiles)
      ? new Set(options.allowedContextFiles.map((f) => f.replace(/\\/g, '/')))
      : (options.allowedContextFiles instanceof Set ? options.allowedContextFiles : null);
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
    if (this.logImpl) this.logImpl(`[ToolGateway] REJECT ${toolName}: ${reason}`);
  }

  recordSuccess(toolName, input, bytes, truncated = false, { incrementCalls = true } = {}) {
    if (incrementCalls) {
      this.callCount += 1;
      if (this.callCount >= this.maxCalls) this.quotaExhausted = true;
    }
    this.totalReadBytes += bytes;
    if (this.totalReadBytes >= this.maxTotalReadBytes) this.quotaExhausted = true;
    this.history.push({ toolName, input, bytes, truncated, timestamp: Date.now(), status: 'success' });
    if (this.logImpl) this.logImpl(`[ToolGateway] ALLOW ${toolName}: ${bytes} bytes`);
  }

  async authorize(toolName, input) {
    if (this.callCount >= this.maxCalls) {
      this.quotaExhausted = true;
      return this.denyAndRecord(toolName, input, `Tool invocation limit exceeded: reached ${this.maxCalls} calls.`);
    }
    const quota = this.checkQuota();
    if (!quota.ok) return this.denyAndRecord(toolName, input, quota.reason);

    this.callCount += 1;
    if (this.callCount >= this.maxCalls) this.quotaExhausted = true;

    if (toolName === TOOL_NAMES.READ) {
      if (!this.readRoots.length) return this.denyAndRecord(toolName, input, 'No authorized read roots configured.');
      const rawPath = typeof input?.file_path === 'string' ? input.file_path : '';
      if (!rawPath || rawPath.includes('\0')) return this.denyAndRecord(toolName, input, 'Invalid file path for Read.');
      if (isControlPath(rawPath)) return this.denyAndRecord(toolName, input, 'Access to control path is forbidden.');

      const resolved = resolveAllowedPath(rawPath, this.readRoots, { mustExist: true, cwd: this.cwd });
      if (!resolved.ok) return this.denyAndRecord(toolName, input, resolved.error);

      if (this.contextRoot && resolved.matchedRoot === this.contextRoot && this.allowedContextFiles) {
        const relContext = path.relative(this.contextRoot, resolved.realPath).replace(/\\/g, '/');
        const isAllowed = this.allowedContextFiles.has(relContext) || this.allowedContextFiles.has(path.basename(relContext));
        if (!isAllowed) {
          return this.denyAndRecord(toolName, input, `Read is denied for unauthorized context file: ${rawPath}`);
        }
      }

      const relToRoot = path.relative(resolved.matchedRoot, resolved.realPath).replace(/\\/g, '/');
      if (isControlPath(resolved.realPath) || isControlPath(relToRoot)) {
        return this.denyAndRecord(toolName, input, 'Access to control path is forbidden.');
      }
      if (matchesIgnore(relToRoot, this.ignorePatterns)) {
        return this.denyAndRecord(toolName, input, `Read is denied for ignored path: ${rawPath}`);
      }

      const relLex = path.relative(resolved.matchedRoot, path.resolve(this.cwd, rawPath)).replace(/\\/g, '/');
      if (matchesIgnore(relLex, this.ignorePatterns) || matchesIgnore(rawPath.replace(/\\/g, '/'), this.ignorePatterns)) {
        return this.denyAndRecord(toolName, input, `Read is denied for ignored path alias: ${rawPath}`);
      }

      try {
        const stat = fs.statSync(resolved.realPath);
        if (!stat.isFile()) return this.denyAndRecord(toolName, input, `Read target is not a regular file: ${rawPath}`);
        if (stat.size > this.maxFileSizeBytes) return this.denyAndRecord(toolName, input, `File size exceeds safety limit of ${this.maxFileSizeBytes} bytes.`);
      } catch (err) {
        return this.denyAndRecord(toolName, input, `Cannot stat file ${rawPath}: ${err?.message ?? err}`);
      }

      const rem = Math.max(0, this.maxTotalReadBytes - this.totalReadBytes);
      if (rem <= 0) return this.denyAndRecord(toolName, input, `Read byte quota exceeded: ${this.totalReadBytes}/${this.maxTotalReadBytes} bytes used.`);

      const offset = positiveInt(input?.offset, 1);
      const limit = Math.min(positiveInt(input?.limit, this.maxReadLines), this.maxReadLines);
      return { behavior: 'allow', updatedInput: { ...input, file_path: resolved.realPath, offset, limit } };
    }

    if (toolName === TOOL_NAMES.GLOB || toolName === TOOL_NAMES.GREP) {
      if (!this.searchRoots.length) return this.denyAndRecord(toolName, input, 'No authorized search roots configured.');
      if (toolName === TOOL_NAMES.GLOB && !isSafeGlobPattern(input?.pattern)) return this.denyAndRecord(toolName, input, 'Glob pattern escapes the sanitized repository.');
      if (toolName === TOOL_NAMES.GREP) {
        if (typeof input?.pattern !== 'string' || input.pattern.includes('\0') || !input.pattern) return this.denyAndRecord(toolName, input, 'Invalid Grep pattern.');
        if (isDangerousRegexPattern(input.pattern)) return this.denyAndRecord(toolName, input, 'Invalid Grep pattern: complex or potential ReDoS pattern rejected.');
        if (input?.glob && !isSafeGlobPattern(input.glob)) return this.denyAndRecord(toolName, input, 'Grep glob escapes the sanitized repository.');
        if (input?.output_mode === 'count' || input?.mode === 'count' || input?.mode === 'stats' || input?.count || input?.stats) {
          return this.denyAndRecord(toolName, input, 'Grep count or stats mode is forbidden: use files_with_matches or content mode.');
        }
      }
      if (input?.path) {
        const rawP = String(input.path);
        if (isControlPath(rawP)) return this.denyAndRecord(toolName, input, 'Access to control path is forbidden.');
        const relP = path.relative(this.safeRoot || this.cwd, path.resolve(this.cwd, rawP)).replace(/\\/g, '/');
        if (matchesIgnore(relP, this.ignorePatterns) || matchesIgnore(`${relP}/`, this.ignorePatterns) || matchesIgnore(rawP.replace(/\\/g, '/'), this.ignorePatterns)) {
          return this.denyAndRecord(toolName, input, `${toolName} is denied for ignored path: ${input.path}`);
        }
      }
      const searchRoot = input?.path ? resolveAllowedPath(input.path, this.searchRoots, { mustExist: true, cwd: this.cwd }) : { ok: true, realPath: this.searchRoots[0] };
      if (!searchRoot.ok) return this.denyAndRecord(toolName, input, `${toolName} is restricted to safe-target/.`);
      if (isControlPath(searchRoot.realPath)) return this.denyAndRecord(toolName, input, 'Access to control path is forbidden.');
      const relReal = path.relative(this.safeRoot || this.cwd, searchRoot.realPath).replace(/\\/g, '/');
      if (matchesIgnore(relReal, this.ignorePatterns) || matchesIgnore(`${relReal}/`, this.ignorePatterns)) {
        return this.denyAndRecord(toolName, input, `${toolName} is denied for ignored path: ${input?.path || relReal}`);
      }
      if (input?.path) {
        try {
          const lstat = fs.lstatSync(path.resolve(this.cwd, String(input.path)));
          if (lstat.isSymbolicLink()) {
            const real = fs.realpathSync.native(path.resolve(this.cwd, String(input.path)));
            const relSym = path.relative(this.safeRoot || this.cwd, real).replace(/\\/g, '/');
            if (this.safeRoot && (!isInside(this.safeRoot, real) || isControlPath(real) || matchesIgnore(relSym, this.ignorePatterns))) {
              return this.denyAndRecord(toolName, input, `${toolName} is denied for unauthorized symlink target: ${input.path}`);
            }
          }
        } catch (err) {
          return this.denyAndRecord(toolName, input, `Cannot verify path ${input.path}: ${err?.message ?? err}`);
        }
      }

      return { behavior: 'allow', updatedInput: { ...input, path: searchRoot.realPath } };
    }

    return this.denyAndRecord(toolName, input, `Tool ${toolName} is not available in review-only mode.`);
  }

  denyAndRecord(toolName, input, message) {
    this.recordRejection(toolName, input, message);
    return { behavior: 'deny', message };
  }

  async prepareExecution(toolName, input) {
    const q = this.checkRemainingQuota(toolName, input);
    if (!q.ok) return q;
    const auth = await this.authorize(toolName, input);
    if (auth.behavior !== 'allow') return { ok: false, error: auth.message, kind: 'denied' };
    return { ok: true, input: auth.updatedInput, maxBytes: Math.min(this.maxCallReadBytes, q.remaining) };
  }

  async executeRead(rawInput) {
    const prep = await this.prepareExecution(TOOL_NAMES.READ, rawInput);
    if (!prep.ok) return prep;
    const { file_path: filePath, offset, limit } = prep.input;
    try {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
      const all = raw.length ? raw.split(/\r?\n/) : [];
      const sel = all.slice(Math.max(0, offset - 1), Math.max(0, offset - 1) + limit);
      let text = sel.join('\n'), truncated = false, byteLen = Buffer.byteLength(text, 'utf8');
      if (byteLen > prep.maxBytes) {
        truncated = true;
        text = `${Buffer.from(text, 'utf8').subarray(0, prep.maxBytes).toString('utf8')}${truncMsg(prep.maxBytes)}`;
        byteLen = Buffer.byteLength(text, 'utf8');
      }
      this.recordSuccess(TOOL_NAMES.READ, rawInput, byteLen, truncated, { incrementCalls: false });
      return { ok: true, content: text, lines: sel.length, totalLines: all.length, offset, limit, truncated, bytesRead: byteLen };
    } catch (err) {
      this.recordRejection(TOOL_NAMES.READ, rawInput, err?.message ?? String(err));
      return { ok: false, error: `Failed to read file ${filePath}: ${err?.message ?? err}`, kind: 'io_error' };
    }
  }

  async executeGlob(rawInput) {
    const prep = await this.prepareExecution(TOOL_NAMES.GLOB, rawInput);
    if (!prep.ok) return prep;
    const { pattern, path: searchRoot } = prep.input;
    const regex = globToRegExp(pattern), matches = [];
    let truncated = false;
    try {
      safeWalk({
        searchRoot, safeRoot: this.safeRoot, ignorePatterns: this.ignorePatterns, timeoutMs: this.timeoutMs,
        onFile: ({ fullPath, relToRepo, entryName }) => {
          if (!this.isPathAllowed(relToRepo)) return false;
          if (matches.length >= this.maxGlobMatches) { truncated = true; return true; }
          const relSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
          if (regex.test(relSearch) || regex.test(relToRepo) || regex.test(entryName)) matches.push(relToRepo);
          return false;
        },
      });
      let byteLen = Buffer.byteLength(JSON.stringify(matches), 'utf8');
      if (byteLen > prep.maxBytes) {
        truncated = true;
        while (matches.length > 0 && Buffer.byteLength(JSON.stringify(matches), 'utf8') > prep.maxBytes) matches.pop();
        byteLen = Buffer.byteLength(JSON.stringify(matches), 'utf8');
      }
      this.recordSuccess(TOOL_NAMES.GLOB, rawInput, byteLen, truncated, { incrementCalls: false });
      return { ok: true, matches, count: matches.length, truncated, bytes: byteLen };
    } catch (err) {
      this.recordRejection(TOOL_NAMES.GLOB, rawInput, err?.message ?? String(err));
      return { ok: false, error: `Glob execution failed: ${err?.message ?? err}`, kind: String(err?.message ?? '').includes('timed out') ? 'timeout' : 'io_error' };
    }
  }

  async executeGrep(rawInput) {
    const prep = await this.prepareExecution(TOOL_NAMES.GREP, rawInput);
    if (!prep.ok) return prep;
    const { pattern, path: searchRoot, glob: fileGlob } = prep.input;
    let regex;
    try { regex = new RegExp(pattern); } catch { regex = new RegExp(escapeRegExp(pattern)); }
    const globRegex = fileGlob ? globToRegExp(fileGlob) : null, matches = [];
    let truncated = false, totalBytes = 0;
    try {
      safeWalk({
        searchRoot, safeRoot: this.safeRoot, ignorePatterns: this.ignorePatterns, timeoutMs: this.timeoutMs,
        onFile: ({ realPath, relToRepo, stat, entryName, fullPath }) => {
          if (!this.isPathAllowed(relToRepo)) return false;
          if (matches.length >= this.maxGrepMatches || totalBytes >= prep.maxBytes) { truncated = true; return true; }
          const relSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
          if (globRegex && !globRegex.test(relSearch) && !globRegex.test(relToRepo) && !globRegex.test(entryName)) return false;
          if (stat.size > this.maxGrepFileBytes) return false;
          try {
            const lines = fs.readFileSync(realPath, 'utf8').split(/\r?\n/);
            for (let lineNum = 1; lineNum <= lines.length; lineNum += 1) {
              const testLine = lines[lineNum - 1].slice(0, 2000);
              if (regex.test(testLine)) {
                const match = { path: relToRepo, line: lineNum, text: testLine.slice(0, 1000) };
                const entryBytes = Buffer.byteLength(JSON.stringify(match), 'utf8');
                if (totalBytes + entryBytes > prep.maxBytes) { truncated = true; return true; }
                matches.push(match);
                totalBytes += entryBytes;
                if (matches.length >= this.maxGrepMatches) { truncated = true; return true; }
              }
            }
          } catch {}
          return false;
        },
      });
      this.recordSuccess(TOOL_NAMES.GREP, rawInput, totalBytes, truncated, { incrementCalls: false });
      return { ok: true, matches, count: matches.length, truncated, bytes: totalBytes };
    } catch (err) {
      this.recordRejection(TOOL_NAMES.GREP, rawInput, err?.message ?? String(err));
      return { ok: false, error: `Grep execution failed: ${err?.message ?? err}`, kind: String(err?.message ?? '').includes('timed out') ? 'timeout' : 'io_error' };
    }
  }

  executeTool(name, input) {
    if (name === TOOL_NAMES.READ) return this.executeRead(input);
    if (name === TOOL_NAMES.GLOB) return this.executeGlob(input);
    if (name === TOOL_NAMES.GREP) return this.executeGrep(input);
    return { ok: false, error: `Tool ${name} is not available.`, kind: 'unknown_tool' };
  }

  isPathAllowed(candidatePath) {
    if (typeof candidatePath !== 'string' || !candidatePath.trim()) return false;
    const clean = candidatePath.trim().replace(/\\/g, '/');
    if (clean.includes('\0') || isControlPath(clean)) return false;
    const rel = this.safeRoot ? path.relative(this.safeRoot, path.resolve(this.safeRoot, clean)).replace(/\\/g, '/') : clean;
    if (isControlPath(rel) || matchesIgnore(rel, this.ignorePatterns)) return false;
    if (this.safeRoot) {
      try {
        const full = path.resolve(this.safeRoot, clean);
        if (!fs.existsSync(full)) return false;
        const real = fs.realpathSync.native(full);
        if (!isInside(this.safeRoot, real) || isControlPath(real) || matchesIgnore(path.relative(this.safeRoot, real).replace(/\\/g, '/'), this.ignorePatterns)) return false;
      } catch { return false; }
    }
    return true;
  }

  createCanUseTool() {
    const gateway = this;
    return async (toolName, input) => {
      return gateway.authorize(toolName, input);
    };
  }

  createPostToolHook() {
    const gateway = this;
    const sanitizePath = (p) => typeof p === 'string' && Boolean(p) && gateway.isPathAllowed(p);
    const extractGrepLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const m = trimmed.match(/^(.+?)(?::\d+:|-\d+-)/);
      if (m && sanitizePath(m[1].trim())) return trimmed;
      if (sanitizePath(trimmed)) return trimmed;
      return null;
    };
    const filterItem = (item) => {
      if (typeof item === 'string') return sanitizePath(item);
      if (item && typeof item === 'object') {
        const p = item.path || item.filePath || item.file || item.filename;
        return sanitizePath(p);
      }
      return false;
    };
    return {
      matcher: 'Read|Glob|Grep',
      hooks: [
        async ({ tool_name, tool_input, tool_response: resp }) => {
          if (!resp || (Array.isArray(resp) && resp.length === 0)) {
            gateway.recordSuccess(tool_name, tool_input, 0, false, { incrementCalls: false });
            return {};
          }

          let sanitized = resp;
          if (Array.isArray(resp)) {
            sanitized = resp.filter(filterItem);
          } else if (typeof resp === 'string') {
            if (tool_name === TOOL_NAMES.GLOB) {
              sanitized = resp.split('\n').filter((l) => sanitizePath(l.trim())).join('\n');
            } else if (tool_name === TOOL_NAMES.GREP) {
              sanitized = resp.split('\n').map(extractGrepLine).filter(Boolean).join('\n');
            }
          } else if (resp && typeof resp === 'object') {
            const obj = {};
            for (const [k, v] of Object.entries(resp)) {
              if (Array.isArray(v) && /^(filenames|files|paths|matches)$/.test(k)) {
                obj[k] = v.filter(filterItem);
              } else if (typeof v === 'string' && /^(content|output|matches)$/.test(k)) {
                obj[k] = tool_name === TOOL_NAMES.GLOB
                  ? v.split('\n').filter((l) => sanitizePath(l.trim())).join('\n')
                  : tool_name === TOOL_NAMES.GREP
                    ? v.split('\n').map(extractGrepLine).filter(Boolean).join('\n')
                    : v;
              }
            }
            sanitized = obj;
          }

          const limit = Math.min(gateway.maxCallReadBytes, Math.max(0, gateway.maxTotalReadBytes - gateway.totalReadBytes));
          const str = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
          const byteLen = Buffer.byteLength(str, 'utf8');
          const isIdentical = (sanitized === resp) || (
            Array.isArray(resp) && Array.isArray(sanitized) && resp.length === sanitized.length && resp.every((v, i) => v === sanitized[i])
          );
          if (byteLen <= limit && isIdentical) {
            gateway.recordSuccess(tool_name, tool_input, byteLen, false, { incrementCalls: false });
            return {};
          }

          let out = sanitized, truncated = false;
          if (byteLen > limit) {
            truncated = true;
            if (typeof sanitized === 'string') {
              out = `${Buffer.from(sanitized, 'utf8').subarray(0, Math.max(0, limit - 100)).toString('utf8')}${truncMsg(limit)}`;
            } else if (Array.isArray(sanitized)) {
              out = [];
              let cur = 0;
              for (const item of sanitized) {
                const b = Buffer.byteLength(JSON.stringify(item), 'utf8');
                if (cur + b > limit - 200) break;
                out.push(item);
                cur += b;
              }
              out.push({ _truncated: true, _note: truncMsg(limit).trim() });
            } else if (sanitized && typeof sanitized === 'object') {
              out = { _truncated: true, _note: truncMsg(limit).trim(), partial: Buffer.from(str, 'utf8').subarray(0, Math.max(0, limit - 150)).toString('utf8') };
            } else out = truncMsg(limit).trim();
          }

          const rec = Math.min(limit, Buffer.byteLength(JSON.stringify(out) || String(out), 'utf8'));
          gateway.recordSuccess(tool_name, tool_input, rec, truncated, { incrementCalls: false });
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out } };
        },
      ],
    };
  }

  createMcpServer(serverName = 'gateway') {
    return createGatewayMcpServer(this, serverName).server;
  }

  createMcpTools(serverName = 'gateway') {
    return createGatewayMcpServer(this, serverName).tools;
  }

  getMcpToolNames(serverName = 'gateway') {
    return createGatewayMcpServer(this, serverName).toolNames;
  }

  static getToolDeclarations() {
    return [
      { name: 'Read', description: 'Read file contents.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['file_path'] } },
      { name: 'Glob', description: 'Find files matching glob.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
      { name: 'Grep', description: 'Search pattern across files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
    ];
  }
}

export function createGatewayMcpServer(gateway, serverName = 'gateway') {
  const readTool = tool(
    TOOL_NAMES.READ,
    'Read file contents from the repository or authorized review context.',
    {
      file_path: z.string().describe('Path to the file to read (must be within repository or authorized review context)'),
      offset: z.number().int().optional().describe('1-based line number to start reading from'),
      limit: z.number().int().optional().describe('Number of lines to read'),
    },
    async (args) => {
      const res = await gateway.executeRead(args);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: res.error || res.reason || 'Read failed' }],
        };
      }
      return {
        content: [{ type: 'text', text: res.content }],
      };
    }
  );

  const globTool = tool(
    TOOL_NAMES.GLOB,
    'Find files matching a glob pattern within the repository.',
    {
      pattern: z.string().describe('Glob pattern to match files against'),
      path: z.string().optional().describe('Directory to search in (must be within repository)'),
    },
    async (args) => {
      const res = await gateway.executeGlob(args);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: res.error || res.reason || 'Glob failed' }],
        };
      }
      const text = res.matches.length > 0 ? res.matches.join('\n') : 'No files matched the pattern.';
      const limit = Math.min(gateway.maxCallReadBytes, Math.max(0, gateway.maxTotalReadBytes - gateway.totalReadBytes + res.bytes));
      let outText = res.truncated ? `${text}${truncMsg(limit)}` : text;
      const bLen = Buffer.byteLength(outText, 'utf8');
      if (bLen > limit) {
        outText = `${Buffer.from(outText, 'utf8').subarray(0, Math.max(0, limit - 100)).toString('utf8')}${truncMsg(limit)}`;
      }
      return {
        content: [{ type: 'text', text: outText }],
      };
    }
  );

  const grepTool = tool(
    TOOL_NAMES.GREP,
    'Search for pattern across files in the repository.',
    {
      pattern: z.string().describe('Pattern or regular expression to search for'),
      path: z.string().optional().describe('Directory to search in (must be within repository)'),
      glob: z.string().optional().describe('Glob pattern to filter files'),
      output_mode: z.string().optional().describe('Output mode: files_with_matches or content'),
      mode: z.string().optional().describe('Output mode alias'),
    },
    async (args) => {
      const res = await gateway.executeGrep(args);
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: res.error || res.reason || 'Grep failed' }],
        };
      }
      let text;
      const isFilesOnly = args?.output_mode === 'files_with_matches' || args?.mode === 'files_with_matches';
      if (isFilesOnly) {
        const files = [...new Set(res.matches.map((m) => m.path))];
        text = files.length > 0 ? files.join('\n') : 'No files matched.';
      } else {
        text = res.matches.length > 0
          ? res.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
          : 'No matches found.';
      }
      const limit = Math.min(gateway.maxCallReadBytes, Math.max(0, gateway.maxTotalReadBytes - gateway.totalReadBytes + res.bytes));
      let outText = res.truncated ? `${text}${truncMsg(limit)}` : text;
      const bLen = Buffer.byteLength(outText, 'utf8');
      if (bLen > limit) {
        outText = `${Buffer.from(outText, 'utf8').subarray(0, Math.max(0, limit - 100)).toString('utf8')}${truncMsg(limit)}`;
      }
      return {
        content: [{ type: 'text', text: outText }],
      };
    }
  );

  const server = createSdkMcpServer({
    name: serverName,
    tools: [readTool, globTool, grepTool],
  });

  return {
    server,
    tools: [readTool, globTool, grepTool],
    toolNames: [
      `mcp__${serverName}__${TOOL_NAMES.READ}`,
      `mcp__${serverName}__${TOOL_NAMES.GLOB}`,
      `mcp__${serverName}__${TOOL_NAMES.GREP}`,
    ],
  };
}

function realDirPath(v) {
  try {
    const r = fs.realpathSync.native(path.resolve(v));
    return fs.statSync(r).isDirectory() ? r : path.resolve(v);
  } catch { return path.resolve(v); }
}

function positiveInt(val, fallback) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function globToRegExp(pattern) {
  let r = '^', i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { r += '(?:.+/)?'; i += 3; continue; }
        r += '.*'; i += 2; continue;
      }
      r += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { r += '[^/]'; i += 1; continue; }
    r += ['.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\'].includes(c) ? `\\${c}` : c;
    i += 1;
  }
  return new RegExp(`${r}$`);
}