import fs from 'node:fs';
import path from 'node:path';
import { matchesIgnore } from './review-shards.mjs';

export const TOOL_NAMES = Object.freeze({
  READ: 'Read',
  GLOB: 'Glob',
  GREP: 'Grep',
});

export const DEFAULT_LIMITS = Object.freeze({
  MAX_CALLS: 100,
  MAX_CALL_READ_BYTES: 256 * 1024, // 256 KB per call
  MAX_TOTAL_READ_BYTES: 5 * 1024 * 1024, // 5 MB per session
  MAX_READ_LINES: 2000,
  MAX_GLOB_MATCHES: 500,
  MAX_GREP_MATCHES: 200,
  MAX_GREP_FILE_BYTES: 1024 * 1024, // 1 MB per file searched in grep
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB absolute file size limit
  TIMEOUT_MS: 30_000, // 30 seconds default timeout
});

const CONTROL_FILENAMES = new Set(['CLAUDE.md', '.mcp.json']);
const CONTROL_DIRNAMES = new Set(['.git', '.claude']);

export function isControlPath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath) return false;
  const normalized = candidatePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => CONTROL_DIRNAMES.has(part))) return true;
  const base = parts[parts.length - 1];
  if (base && CONTROL_FILENAMES.has(base)) return true;
  return false;
}

export function isInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function isSafeGlobPattern(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) return false;
  const parts = value.split(/[\\/]+/);
  return !parts.includes('..');
}

export function resolveAllowedPath(requestedPath, allowedRoots, { mustExist = true, cwd = process.cwd() } = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) {
    return { ok: false, error: 'Path must be a non-empty string without null bytes.' };
  }

  const absolute = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwd, requestedPath);

  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (err) {
    if (mustExist) {
      return { ok: false, error: `Path does not exist or cannot be accessed: ${err?.message ?? err}` };
    }
    // For non-existing paths, check realpath of deepest existing directory
    let current = path.dirname(absolute);
    while (current && current !== path.dirname(current)) {
      try {
        const currentReal = fs.realpathSync.native(current);
        const relativePart = path.relative(current, absolute);
        real = path.resolve(currentReal, relativePart);
        break;
      } catch {
        current = path.dirname(current);
      }
    }
    if (!real) real = absolute;
  }

  const matchedRoot = (allowedRoots || []).find((root) => isInside(root, real));
  if (!matchedRoot) {
    return { ok: false, error: `Path escapes authorized boundaries: ${requestedPath}` };
  }

  if (isControlPath(real) || isControlPath(requestedPath)) {
    return { ok: false, error: `Access to control path is forbidden: ${requestedPath}` };
  }

  return { ok: true, realPath: real, matchedRoot };
}

// Catastrophic backtracking / ReDoS heuristic detector
function isDangerousRegexPattern(pattern) {
  if (typeof pattern !== 'string') return true;
  if (pattern.length > 500) return true;
  // Nested quantifiers like (a+)+, (a*)*, ([a-z]+)*, etc.
  if (/\([^)]*[*+][^)]*\)[*+]/.test(pattern)) return true;
  // Overlapping quantifiers like a++ or a** or a*+
  if (/([*+])\s*([*+])/.test(pattern)) return true;
  return false;
}

/**
 * Host-enforced Read-only Tool Gateway.
 * Controls Read, Glob, and Grep tools with boundary checks, quotas, truncation, and telemetry.
 */
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

    // Allowed roots for tools
    this.readRoots = [this.safeRoot, this.contextRoot].filter(Boolean);
    this.searchRoots = [this.safeRoot].filter(Boolean);

    // Telemetry state
    this.callCount = 0;
    this.totalReadBytes = 0;
    this.quotaExhausted = false;
    this.rejections = [];
    this.history = [];
  }

  getDiagnostics() {
    return {
      callCount: this.callCount,
      maxCalls: this.maxCalls,
      totalReadBytes: this.totalReadBytes,
      maxTotalReadBytes: this.maxTotalReadBytes,
      quotaExhausted: this.quotaExhausted,
      rejectionCount: this.rejections.length,
      rejections: [...this.rejections],
      history: [...this.history],
    };
  }

  logDiagnostic(msg) {
    if (this.logImpl) {
      this.logImpl(`[ToolGateway] ${msg}`);
    }
  }

  checkQuota() {
    if (this.callCount >= this.maxCalls) {
      this.quotaExhausted = true;
      return { ok: false, reason: `Tool invocation limit exceeded: reached ${this.maxCalls} calls.` };
    }
    if (this.totalReadBytes >= this.maxTotalReadBytes) {
      this.quotaExhausted = true;
      return { ok: false, reason: `Read byte quota exceeded: reached ${this.totalReadBytes} bytes.` };
    }
    return { ok: true };
  }

  recordRejection(toolName, input, reason) {
    const entry = {
      toolName,
      input,
      reason,
      timestamp: Date.now(),
    };
    this.rejections.push(entry);
    this.history.push({ ...entry, status: 'rejected' });
    this.logDiagnostic(`REJECT ${toolName}: ${reason}`);
  }

  recordSuccess(toolName, input, bytes, truncated = false) {
    this.callCount += 1;
    this.totalReadBytes += bytes;
    if (this.totalReadBytes >= this.maxTotalReadBytes) {
      this.quotaExhausted = true;
    }
    const entry = {
      toolName,
      input,
      bytes,
      truncated,
      timestamp: Date.now(),
    };
    this.history.push({ ...entry, status: 'success' });
    this.logDiagnostic(`ALLOW ${toolName}: ${bytes} bytes (total=${this.totalReadBytes}, calls=${this.callCount})`);
  }

  /**
   * Authorize a tool invocation before execution.
   * Compatible with Claude Agent SDK `canUseTool`.
   */
  async authorize(toolName, input) {
    const quota = this.checkQuota();
    if (!quota.ok) {
      this.recordRejection(toolName, input, quota.reason);
      return { behavior: 'deny', message: quota.reason };
    }

    if (toolName === TOOL_NAMES.READ) {
      if (!this.readRoots.length) {
        const msg = 'No authorized read roots configured.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      const rawPath = input?.file_path;
      const resolved = resolveAllowedPath(rawPath, this.readRoots, { mustExist: true, cwd: this.cwd });
      if (!resolved.ok) {
        this.recordRejection(toolName, input, resolved.error);
        return { behavior: 'deny', message: resolved.error };
      }

      // Check ignore patterns relative to the matched root
      const relToRoot = path.relative(resolved.matchedRoot, resolved.realPath).replace(/\\/g, '/');
      if (matchesIgnore(relToRoot, this.ignorePatterns)) {
        const msg = `Read is denied for ignored path: ${rawPath}`;
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }

      // Check stat
      try {
        const stat = fs.statSync(resolved.realPath);
        if (!stat.isFile()) {
          const msg = `Read target is not a regular file: ${rawPath}`;
          this.recordRejection(toolName, input, msg);
          return { behavior: 'deny', message: msg };
        }
        if (stat.size > this.maxFileSizeBytes) {
          const msg = `File size (${stat.size} bytes) exceeds safety limit of ${this.maxFileSizeBytes} bytes.`;
          this.recordRejection(toolName, input, msg);
          return { behavior: 'deny', message: msg };
        }
      } catch (err) {
        const msg = `Cannot stat file ${rawPath}: ${err?.message ?? err}`;
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }

      // Clamp offset and limit
      const offset = typeof input?.offset === 'number' && Number.isFinite(input.offset) && input.offset > 0
        ? Math.floor(input.offset)
        : 1;
      const limit = typeof input?.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), this.maxReadLines)
        : this.maxReadLines;

      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          file_path: resolved.realPath,
          offset,
          limit,
        },
      };
    }

    if (toolName === TOOL_NAMES.GLOB) {
      if (!this.searchRoots.length) {
        const msg = 'No authorized search roots configured.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      if (!isSafeGlobPattern(input?.pattern)) {
        const msg = 'Glob pattern escapes the sanitized repository.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      const rawPath = input?.path;
      const searchRoot = rawPath
        ? resolveAllowedPath(rawPath, this.searchRoots, { mustExist: true, cwd: this.cwd })
        : { ok: true, realPath: this.searchRoots[0] };

      if (!searchRoot.ok) {
        const msg = 'Glob is restricted to safe-target/.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }

      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          path: searchRoot.realPath,
        },
      };
    }

    if (toolName === TOOL_NAMES.GREP) {
      if (!this.searchRoots.length) {
        const msg = 'No authorized search roots configured.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      if (typeof input?.pattern !== 'string' || input.pattern.includes('\0') || !input.pattern) {
        const msg = 'Invalid Grep pattern.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      if (isDangerousRegexPattern(input.pattern)) {
        const msg = 'Invalid Grep pattern: complex or potential ReDoS pattern rejected.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      if (input?.glob && !isSafeGlobPattern(input.glob)) {
        const msg = 'Grep glob escapes the sanitized repository.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }
      const rawPath = input?.path;
      const searchRoot = rawPath
        ? resolveAllowedPath(rawPath, this.searchRoots, { mustExist: true, cwd: this.cwd })
        : { ok: true, realPath: this.searchRoots[0] };

      if (!searchRoot.ok) {
        const msg = 'Grep is restricted to safe-target/.';
        this.recordRejection(toolName, input, msg);
        return { behavior: 'deny', message: msg };
      }

      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          path: searchRoot.realPath,
        },
      };
    }

    const msg = `Tool ${toolName} is not available in review-only mode.`;
    this.recordRejection(toolName, input, msg);
    return { behavior: 'deny', message: msg };
  }

  /**
   * Direct execution of Read tool.
   */
  async executeRead(input) {
    const remainingQuota = Math.max(0, this.maxTotalReadBytes - this.totalReadBytes);
    if (remainingQuota <= 0) {
      const msg = `Read byte quota exceeded: reached ${this.totalReadBytes} bytes.`;
      this.recordRejection(TOOL_NAMES.READ, input, msg);
      return { ok: false, error: msg, kind: 'quota_exhausted' };
    }

    const auth = await this.authorize(TOOL_NAMES.READ, input);
    if (auth.behavior !== 'allow') {
      return { ok: false, error: auth.message, kind: 'denied' };
    }

    const filePath = auth.updatedInput.file_path;
    const offset = auth.updatedInput.offset;
    const limit = auth.updatedInput.limit;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, remainingQuota);

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
      return {
        ok: true,
        content: text,
        lines: selectedLines.length,
        totalLines: allLines.length,
        offset,
        limit,
        truncated,
        bytesRead: byteLen,
      };
    } catch (err) {
      const msg = `Failed to read file ${filePath}: ${err?.message ?? err}`;
      this.recordRejection(TOOL_NAMES.READ, input, msg);
      return { ok: false, error: msg, kind: 'io_error' };
    }
  }

  /**
   * Direct execution of Glob tool.
   */
  async executeGlob(input) {
    const remainingQuota = Math.max(0, this.maxTotalReadBytes - this.totalReadBytes);
    if (remainingQuota <= 0) {
      const msg = `Read byte quota exceeded: reached ${this.totalReadBytes} bytes.`;
      this.recordRejection(TOOL_NAMES.GLOB, input, msg);
      return { ok: false, error: msg, kind: 'quota_exhausted' };
    }

    const auth = await this.authorize(TOOL_NAMES.GLOB, input);
    if (auth.behavior !== 'allow') {
      return { ok: false, error: auth.message, kind: 'denied' };
    }

    const pattern = auth.updatedInput.pattern;
    const searchRoot = auth.updatedInput.path;
    const deadline = Date.now() + this.timeoutMs;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, remainingQuota);

    try {
      const matches = [];
      let truncated = false;
      const visitedRealDirs = new Set();
      try {
        visitedRealDirs.add(fs.realpathSync.native(searchRoot));
      } catch {}

      const regex = globToRegExp(pattern);
      const walk = (dir) => {
        if (Date.now() > deadline) {
          throw new Error(`Glob timed out after ${this.timeoutMs}ms`);
        }
        if (matches.length >= this.maxGlobMatches) {
          truncated = true;
          return;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= this.maxGlobMatches) {
            truncated = true;
            break;
          }
          const fullPath = path.join(dir, entry.name);

          let real;
          try {
            real = fs.realpathSync.native(fullPath);
          } catch {
            continue; // broken link or inaccessible file
          }

          if (this.safeRoot && !isInside(this.safeRoot, real)) {
            continue; // symlink escapes repository root
          }

          const relToRepo = this.safeRoot ? path.relative(this.safeRoot, fullPath).replace(/\\/g, '/') : entry.name;
          const realRelToRepo = this.safeRoot ? path.relative(this.safeRoot, real).replace(/\\/g, '/') : entry.name;

          if (isControlPath(relToRepo) || isControlPath(realRelToRepo) || isControlPath(entry.name)) continue;
          if (matchesIgnore(relToRepo, this.ignorePatterns) || matchesIgnore(realRelToRepo, this.ignorePatterns)) continue;

          let stat;
          try {
            stat = fs.statSync(real);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            if (visitedRealDirs.has(real)) continue; // cycle detection
            visitedRealDirs.add(real);
            walk(fullPath);
          } else if (stat.isFile()) {
            const relToSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
            if (regex.test(relToSearch) || regex.test(relToRepo) || regex.test(entry.name)) {
              matches.push(relToRepo);
            }
          }
        }
      };

      walk(searchRoot);

      let payload = JSON.stringify(matches);
      let byteLen = Buffer.byteLength(payload, 'utf8');
      if (byteLen > effectiveMaxBytes) {
        truncated = true;
        while (matches.length > 0 && Buffer.byteLength(JSON.stringify(matches), 'utf8') > effectiveMaxBytes) {
          matches.pop();
        }
        payload = JSON.stringify(matches);
        byteLen = Buffer.byteLength(payload, 'utf8');
      }

      this.recordSuccess(TOOL_NAMES.GLOB, input, byteLen, truncated);
      return {
        ok: true,
        matches,
        count: matches.length,
        truncated,
        bytes: byteLen,
      };
    } catch (err) {
      const msg = `Glob execution failed: ${err?.message ?? err}`;
      const isTimeout = String(err?.message ?? '').includes('timed out');
      this.recordRejection(TOOL_NAMES.GLOB, input, msg);
      return { ok: false, error: msg, kind: isTimeout ? 'timeout' : 'io_error' };
    }
  }

  /**
   * Direct execution of Grep tool with deadline protection.
   */
  async executeGrep(input) {
    const remainingQuota = Math.max(0, this.maxTotalReadBytes - this.totalReadBytes);
    if (remainingQuota <= 0) {
      const msg = `Read byte quota exceeded: reached ${this.totalReadBytes} bytes.`;
      this.recordRejection(TOOL_NAMES.GREP, input, msg);
      return { ok: false, error: msg, kind: 'quota_exhausted' };
    }

    const auth = await this.authorize(TOOL_NAMES.GREP, input);
    if (auth.behavior !== 'allow') {
      return { ok: false, error: auth.message, kind: 'denied' };
    }

    const pattern = auth.updatedInput.pattern;
    const searchRoot = auth.updatedInput.path;
    const fileGlob = auth.updatedInput.glob;
    const deadline = Date.now() + this.timeoutMs;
    const effectiveMaxBytes = Math.min(this.maxCallReadBytes, remainingQuota);

    let regex;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(escapeRegExp(pattern));
    }
    const globRegex = fileGlob ? globToRegExp(fileGlob) : null;

    try {
      const matches = [];
      let truncated = false;
      let totalBytes = 0;
      const visitedRealDirs = new Set();
      try {
        visitedRealDirs.add(fs.realpathSync.native(searchRoot));
      } catch {}

      const walk = (dir) => {
        if (Date.now() > deadline) {
          throw new Error(`Grep timed out after ${this.timeoutMs}ms`);
        }
        if (matches.length >= this.maxGrepMatches || totalBytes >= effectiveMaxBytes) {
          truncated = true;
          return;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= this.maxGrepMatches || totalBytes >= effectiveMaxBytes) {
            truncated = true;
            break;
          }
          if (Date.now() > deadline) {
            throw new Error(`Grep timed out after ${this.timeoutMs}ms`);
          }

          const fullPath = path.join(dir, entry.name);

          let real;
          try {
            real = fs.realpathSync.native(fullPath);
          } catch {
            continue;
          }

          if (this.safeRoot && !isInside(this.safeRoot, real)) {
            continue; // symlink escapes repository root
          }

          const relToRepo = this.safeRoot ? path.relative(this.safeRoot, fullPath).replace(/\\/g, '/') : entry.name;
          const realRelToRepo = this.safeRoot ? path.relative(this.safeRoot, real).replace(/\\/g, '/') : entry.name;

          if (isControlPath(relToRepo) || isControlPath(realRelToRepo) || isControlPath(entry.name)) continue;
          if (matchesIgnore(relToRepo, this.ignorePatterns) || matchesIgnore(realRelToRepo, this.ignorePatterns)) continue;

          let stat;
          try {
            stat = fs.statSync(real);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            if (visitedRealDirs.has(real)) continue; // cycle detection
            visitedRealDirs.add(real);
            walk(fullPath);
          } else if (stat.isFile()) {
            const relToSearch = path.relative(searchRoot, fullPath).replace(/\\/g, '/');
            if (globRegex && !globRegex.test(relToSearch) && !globRegex.test(relToRepo) && !globRegex.test(entry.name)) {
              continue;
            }

            try {
              if (stat.size > this.maxGrepFileBytes) continue;

              const content = fs.readFileSync(real, 'utf8');
              const lines = content.split(/\r?\n/);
              for (let lineNum = 1; lineNum <= lines.length; lineNum += 1) {
                if (Date.now() > deadline) {
                  throw new Error(`Grep timed out after ${this.timeoutMs}ms`);
                }
                const line = lines[lineNum - 1];
                // Limit test line length to prevent ReDoS on massive lines
                const testLine = line.length > 2000 ? line.slice(0, 2000) : line;
                if (regex.test(testLine)) {
                  const matchEntry = { path: relToRepo, line: lineNum, text: testLine.slice(0, 1000) };
                  const entryBytes = Buffer.byteLength(JSON.stringify(matchEntry), 'utf8');
                  if (totalBytes + entryBytes > effectiveMaxBytes) {
                    truncated = true;
                    return;
                  }
                  matches.push(matchEntry);
                  totalBytes += entryBytes;
                  if (matches.length >= this.maxGrepMatches) {
                    truncated = true;
                    return;
                  }
                }
              }
            } catch {
              // Ignore unreadable individual file
            }
          }
        }
      };

      walk(searchRoot);

      this.recordSuccess(TOOL_NAMES.GREP, input, totalBytes, truncated);
      return {
        ok: true,
        matches,
        count: matches.length,
        truncated,
        bytes: totalBytes,
      };
    } catch (err) {
      const msg = `Grep execution failed: ${err?.message ?? err}`;
      const isTimeout = String(err?.message ?? '').includes('timed out');
      this.recordRejection(TOOL_NAMES.GREP, input, msg);
      return { ok: false, error: msg, kind: isTimeout ? 'timeout' : 'io_error' };
    }
  }

  /**
   * Unified tool execution dispatcher.
   */
  async executeTool(toolName, input) {
    if (toolName === TOOL_NAMES.READ) return this.executeRead(input);
    if (toolName === TOOL_NAMES.GLOB) return this.executeGlob(input);
    if (toolName === TOOL_NAMES.GREP) return this.executeGrep(input);
    return { ok: false, error: `Tool ${toolName} is not available.`, kind: 'unknown_tool' };
  }

  /**
   * Create a Claude Agent SDK compatible `canUseTool` handler.
   */
  createCanUseTool() {
    return async (toolName, input) => this.authorize(toolName, input);
  }

  /**
   * Create a Claude Agent SDK compatible `PostToolUse` hook matcher.
   * Intercepts tool response, truncates output if exceeding quotas, and accounts for bytes.
   */
  createPostToolHook() {
    const gateway = this;
    return {
      matcher: 'Read|Glob|Grep',
      hooks: [
        async (hookInput) => {
          const toolName = hookInput?.tool_name;
          const rawResponse = hookInput?.tool_response;
          if (!rawResponse) return {};

          const remainingQuota = Math.max(0, gateway.maxTotalReadBytes - gateway.totalReadBytes);
          const effectiveLimit = Math.min(gateway.maxCallReadBytes, remainingQuota);

          let responseStr = typeof rawResponse === 'string'
            ? rawResponse
            : JSON.stringify(rawResponse);

          const byteLen = Buffer.byteLength(responseStr, 'utf8');
          let updatedToolOutput = null;

          if (byteLen > effectiveLimit) {
            const notice = `\n[... output truncated by host gateway: exceeded limit of ${effectiveLimit} bytes ...]`;

            if (typeof rawResponse === 'string') {
              const safeBytes = Math.max(0, effectiveLimit - 100);
              const truncatedBuf = Buffer.from(rawResponse, 'utf8').subarray(0, safeBytes);
              updatedToolOutput = `${truncatedBuf.toString('utf8')}${notice}`;
            } else if (Array.isArray(rawResponse)) {
              const boundedArray = [];
              let currentBytes = 0;
              for (const item of rawResponse) {
                const itemStr = JSON.stringify(item);
                const itemBytes = Buffer.byteLength(itemStr, 'utf8');
                if (currentBytes + itemBytes > effectiveLimit - 200) {
                  break;
                }
                boundedArray.push(item);
                currentBytes += itemBytes;
              }
              boundedArray.push({ _truncated: true, _note: notice.trim() });
              updatedToolOutput = boundedArray;
            } else if (rawResponse && typeof rawResponse === 'object') {
              const safeBytes = Math.max(0, effectiveLimit - 150);
              const truncatedStr = Buffer.from(responseStr, 'utf8').subarray(0, safeBytes).toString('utf8');
              updatedToolOutput = {
                _truncated: true,
                _note: notice.trim(),
                partial: truncatedStr,
              };
            } else {
              updatedToolOutput = notice.trim();
            }

            const recordedBytes = Math.min(effectiveLimit, Buffer.byteLength(JSON.stringify(updatedToolOutput) || String(updatedToolOutput), 'utf8'));
            gateway.recordSuccess(toolName, hookInput.tool_input, recordedBytes, true);
          } else {
            gateway.recordSuccess(toolName, hookInput.tool_input, byteLen, false);
          }

          if (updatedToolOutput !== null) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput,
              },
            };
          }
          return {};
        },
      ],
    };
  }

  /**
   * Tool definitions schema for PR5 Gemini Function Calling.
   */
  static getToolDeclarations() {
    return [
      {
        name: 'Read',
        description: 'Read file contents from the sanitized repository snapshot or trusted review context.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Repository-relative or context-relative path to read.' },
            offset: { type: 'integer', description: '1-based starting line number.', minimum: 1 },
            limit: { type: 'integer', description: 'Maximum number of lines to return.', minimum: 1, maximum: 2000 },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'Glob',
        description: 'Find files matching a glob pattern within the sanitized repository.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.js").' },
            path: { type: 'string', description: 'Subdirectory path within the repository to search.' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'Grep',
        description: 'Search for a pattern across files within the sanitized repository.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex or text pattern to search.' },
            path: { type: 'string', description: 'Subdirectory path within the repository to search.' },
            glob: { type: 'string', description: 'Optional file pattern to limit search.' },
          },
          required: ['pattern'],
        },
      },
    ];
  }
}

function realDirPath(value) {
  try {
    const resolved = fs.realpathSync.native(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`${value} is not a directory`);
    }
    return resolved;
  } catch (err) {
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
  let reStr = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          reStr += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          reStr += '.*';
          i += 2;
          continue;
        }
      } else {
        reStr += '[^/]*';
        i += 1;
        continue;
      }
    } else if (c === '?') {
      reStr += '[^/]';
      i += 1;
      continue;
    } else if (['.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\'].includes(c)) {
      reStr += `\\${c}`;
      i += 1;
      continue;
    } else {
      reStr += c;
      i += 1;
      continue;
    }
  }
  reStr += '$';
  return new RegExp(reStr);
}
