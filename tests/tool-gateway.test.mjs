import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReadOnlyToolGateway,
  TOOL_NAMES,
  isControlPath,
  isSafeGlobPattern,
  resolveAllowedPath,
} from '../scripts/tool-gateway.mjs';

function createFixture() {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-gateway-test-')));
  const safeRoot = path.join(tmpDir, 'safe-target');
  const contextRoot = path.join(tmpDir, '.review-context');
  const outsideRoot = path.join(tmpDir, 'outside');

  fs.mkdirSync(safeRoot, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  // Safe files
  fs.writeFileSync(path.join(safeRoot, 'index.js'), 'console.log("hello");\nline2\nline3\n');
  fs.mkdirSync(path.join(safeRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(safeRoot, 'src', 'app.js'), 'export function run() { return 42; }\n// search_term_target\n');
  fs.writeFileSync(path.join(safeRoot, 'src', 'util.js'), 'export const helper = true;\n');

  // Context files
  fs.writeFileSync(path.join(contextRoot, 'pr.diff'), 'diff --git a/index.js b/index.js\n');

  // Outside secret file
  fs.writeFileSync(path.join(outsideRoot, 'secret.key'), 'SUPER_SECRET_TOKEN_DO_NOT_LEAK');

  // Symlinks:
  // 1. Escaping link pointing to outside file
  try {
    fs.symlinkSync(path.join(outsideRoot, 'secret.key'), path.join(safeRoot, 'leak-link.txt'));
  } catch {}

  // 2. Escaping directory link pointing to outside directory
  try {
    fs.symlinkSync(outsideRoot, path.join(safeRoot, 'leak-dir'));
  } catch {}

  // 3. Safe symlink pointing within safeRoot
  try {
    fs.symlinkSync(path.join(safeRoot, 'src', 'app.js'), path.join(safeRoot, 'safe-link.js'));
  } catch {}

  // Control files
  fs.mkdirSync(path.join(safeRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(safeRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  fs.mkdirSync(path.join(safeRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(safeRoot, '.claude', 'config.json'), '{}');

  fs.writeFileSync(path.join(safeRoot, 'CLAUDE.md'), '# Instructions');
  fs.writeFileSync(path.join(safeRoot, '.mcp.json'), '{}');

  // Ignored file
  fs.writeFileSync(path.join(safeRoot, 'ignored.log'), 'debug log');

  return {
    tmpDir,
    safeRoot,
    contextRoot,
    outsideRoot,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('Path resolution and boundary checks: prevents escape via ../, absolute paths, and symlinks', () => {
  const fixture = createFixture();
  try {
    const allowedRoots = [fixture.safeRoot, fixture.contextRoot];

    // 1. Valid paths within allowed roots
    const validSafe = resolveAllowedPath(path.join(fixture.safeRoot, 'index.js'), allowedRoots);
    assert.equal(validSafe.ok, true);
    assert.equal(validSafe.realPath, path.join(fixture.safeRoot, 'index.js'));

    const validContext = resolveAllowedPath(path.join(fixture.contextRoot, 'pr.diff'), allowedRoots);
    assert.equal(validContext.ok, true);

    // 2. Path traversal escaping root via ../
    const escapeDotDot = resolveAllowedPath(path.join(fixture.safeRoot, '../outside/secret.key'), allowedRoots);
    assert.equal(escapeDotDot.ok, false);
    assert.match(escapeDotDot.error, /escapes authorized boundaries/i);

    // 3. Absolute path outside allowed roots
    const escapeAbs = resolveAllowedPath(path.join(fixture.outsideRoot, 'secret.key'), allowedRoots);
    assert.equal(escapeAbs.ok, false);
    assert.match(escapeAbs.error, /escapes authorized boundaries/i);

    // 4. Symlink escaping root to outside
    const escapeSymlink = resolveAllowedPath(path.join(fixture.safeRoot, 'leak-link.txt'), allowedRoots);
    assert.equal(escapeSymlink.ok, false);
    assert.match(escapeSymlink.error, /escapes authorized boundaries/i);

    // 5. Symlink through directory link escaping root
    const escapeDirSymlink = resolveAllowedPath(path.join(fixture.safeRoot, 'leak-dir', 'secret.key'), allowedRoots);
    assert.equal(escapeDirSymlink.ok, false);
    assert.match(escapeDirSymlink.error, /escapes authorized boundaries/i);

    // 6. Null byte injection
    const nullByte = resolveAllowedPath('index.js\0evil', allowedRoots);
    assert.equal(nullByte.ok, false);
    assert.match(nullByte.error, /null bytes/i);

    // 7. Non-existent path
    const nonExistent = resolveAllowedPath(path.join(fixture.safeRoot, 'does-not-exist.txt'), allowedRoots, { mustExist: true });
    assert.equal(nonExistent.ok, false);
    assert.match(nonExistent.error, /does not exist/i);
  } finally {
    fixture.cleanup();
  }
});

test('Control path checks: forbids .git, .claude, CLAUDE.md, and .mcp.json', () => {
  const fixture = createFixture();
  try {
    const allowedRoots = [fixture.safeRoot];

    assert.equal(isControlPath('CLAUDE.md'), true);
    assert.equal(isControlPath('.claude/settings.json'), true);
    assert.equal(isControlPath('.git/config'), true);
    assert.equal(isControlPath('.mcp.json'), true);
    assert.equal(isControlPath('src/normal.js'), false);

    const gitCheck = resolveAllowedPath(path.join(fixture.safeRoot, '.git', 'HEAD'), allowedRoots);
    assert.equal(gitCheck.ok, false);
    assert.match(gitCheck.error, /control path is forbidden/i);

    const claudeCheck = resolveAllowedPath(path.join(fixture.safeRoot, 'CLAUDE.md'), allowedRoots);
    assert.equal(claudeCheck.ok, false);
    assert.match(claudeCheck.error, /control path is forbidden/i);

    const mcpCheck = resolveAllowedPath(path.join(fixture.safeRoot, '.mcp.json'), allowedRoots);
    assert.equal(mcpCheck.ok, false);
    assert.match(mcpCheck.error, /control path is forbidden/i);
  } finally {
    fixture.cleanup();
  }
});

test('Safe glob pattern validator: rejects unsafe patterns with ../ or absolute paths', () => {
  assert.equal(isSafeGlobPattern('**/*.js'), true);
  assert.equal(isSafeGlobPattern('src/*.swift'), true);
  assert.equal(isSafeGlobPattern('../outside/*.js'), false);
  assert.equal(isSafeGlobPattern('/etc/*'), false);
  assert.equal(isSafeGlobPattern('foo/../../bar'), false);
  assert.equal(isSafeGlobPattern('pattern\0'), false);
  assert.equal(isSafeGlobPattern(''), false);
  assert.equal(isSafeGlobPattern(null), false);
});

test('ReadOnlyToolGateway Read: verifies normal read, offset/limit pagination, and truncation', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxCallReadBytes: 50, // low byte limit to trigger truncation
    });

    // 1. Normal read within safe-target
    const readSafe = await gateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(readSafe.ok, true);
    assert.equal(readSafe.lines, 3);
    assert.match(readSafe.content, /hello/);

    // 2. Pagination: offset=2, limit=1
    const paged = await gateway.executeRead({
      file_path: path.join(fixture.safeRoot, 'index.js'),
      offset: 2,
      limit: 1,
    });
    assert.equal(paged.ok, true);
    assert.equal(paged.content, 'line2');
    assert.equal(paged.lines, 1);

    // 3. Truncation when exceeding maxCallReadBytes
    const largeFile = path.join(fixture.safeRoot, 'large.txt');
    fs.writeFileSync(largeFile, 'x'.repeat(200));

    const truncated = await gateway.executeRead({ file_path: largeFile });
    assert.equal(truncated.ok, true);
    assert.equal(truncated.truncated, true);
    assert.match(truncated.content, /truncated by host gateway/i);

    // 4. Read from context root
    const readContext = await gateway.executeRead({ file_path: path.join(fixture.contextRoot, 'pr.diff') });
    assert.equal(readContext.ok, true);
    assert.match(readContext.content, /diff --git/);
  } finally {
    fixture.cleanup();
  }
});

test('ReadOnlyToolGateway Glob: safe directory scan without shell, obeys boundary and limits', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxGlobMatches: 2, // low match limit to test truncation
    });

    // 1. Normal glob
    const res = await gateway.executeGlob({ pattern: '**/*.js' });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2); // capped at maxGlobMatches
    assert.equal(res.truncated, true);
    // Does not include escaping symlinks or control files
    assert.ok(res.matches.every((m) => !m.includes('.git') && !m.includes('CLAUDE.md') && !m.includes('leak')));

    // 2. Glob with path escaping
    const escapeGlob = await gateway.executeGlob({ pattern: '*.key', path: fixture.outsideRoot });
    assert.equal(escapeGlob.ok, false);
    assert.match(escapeGlob.error, /Glob is restricted to safe-target\//i);

    // 3. Glob with invalid pattern
    const invalidGlob = await gateway.executeGlob({ pattern: '../../escaped/*.js' });
    assert.equal(invalidGlob.ok, false);
    assert.match(invalidGlob.error, /escapes the sanitized repository/i);
  } finally {
    fixture.cleanup();
  }
});

test('ReadOnlyToolGateway Grep: safe pattern search without shell, obeys boundary and limits', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxGrepMatches: 1, // limit to 1 match
    });

    // 1. Search for term
    const grepRes = await gateway.executeGrep({ pattern: 'search_term_target' });
    assert.equal(grepRes.ok, true);
    assert.equal(grepRes.count, 1);
    assert.ok(['src/app.js', 'safe-link.js'].includes(grepRes.matches[0].path));
    assert.equal(grepRes.matches[0].line, 2);

    // 2. Invalid pattern (null byte)
    const invalidGrep = await gateway.executeGrep({ pattern: 'abc\0def' });
    assert.equal(invalidGrep.ok, false);
    assert.match(invalidGrep.error, /Invalid Grep pattern/i);

    // 3. Search outside safe root denied
    const outsideGrep = await gateway.executeGrep({ pattern: 'SECRET', path: fixture.outsideRoot });
    assert.equal(outsideGrep.ok, false);
    assert.match(outsideGrep.error, /Grep is restricted to safe-target\//i);
  } finally {
    fixture.cleanup();
  }
});

test('Quota exhaustion and Fail Closed: call budget and total byte budget enforcement', async () => {
  const fixture = createFixture();
  try {
    // Test call count limit
    const callLimitedGateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxCalls: 2,
    });

    const call1 = await callLimitedGateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(call1.ok, true);
    const call2 = await callLimitedGateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(call2.ok, true);

    // 3rd call must fail closed
    const call3 = await callLimitedGateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(call3.ok, false);
    assert.match(call3.error, /Tool invocation limit exceeded/i);

    // Test byte budget limit
    const byteLimitedGateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxTotalReadBytes: 30, // 30 bytes budget
    });

    const b1 = await byteLimitedGateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(b1.ok, true);
    assert.ok(byteLimitedGateway.totalReadBytes >= 20);

    // Next call exceeds byte budget and fails closed
    const b2 = await byteLimitedGateway.executeRead({ file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(b2.ok, false);
    assert.match(b2.error, /Read byte quota exceeded/i);
    assert.equal(byteLimitedGateway.quotaExhausted, true);

    // Check diagnostics
    const diag = byteLimitedGateway.getDiagnostics();
    assert.ok(diag.quotaExhausted);
    assert.ok(diag.rejections.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test('Ignore patterns enforcement: files matching ignore rules are denied', async () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.join(fixture.safeRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(fixture.safeRoot, 'nested', 'tempfile.tmp'), 'temp data');

    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      ignorePatterns: ['ignored.log', '*.tmp'],
    });

    // Root-level literal ignore via absolute path
    const auth1 = await gateway.authorize('Read', { file_path: path.join(fixture.safeRoot, 'ignored.log') });
    assert.equal(auth1.behavior, 'deny');
    assert.match(auth1.message, /ignored path/i);

    // Subdirectory wildcard ignore via absolute path
    const auth2 = await gateway.authorize('Read', { file_path: path.join(fixture.safeRoot, 'nested', 'tempfile.tmp') });
    assert.equal(auth2.behavior, 'deny');
    assert.match(auth2.message, /ignored path/i);
  } finally {
    fixture.cleanup();
  }
});

test('Glob and Grep ignore rules with subdirectory searchRoot: enforces repository-root-anchored ignore patterns', async () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.join(fixture.safeRoot, 'src', 'build'), { recursive: true });
    fs.writeFileSync(path.join(fixture.safeRoot, 'src', 'build', 'temp.js'), 'export const tmp = true;');

    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      ignorePatterns: ['/src/build/', 'ignored.log'],
    });

    // Glob in subdirectory 'src': should NOT return 'src/build/temp.js' because /src/build/ is ignored
    const globRes = await gateway.executeGlob({ pattern: '**/*.js', path: path.join(fixture.safeRoot, 'src') });
    assert.equal(globRes.ok, true);
    assert.ok(globRes.matches.every((m) => !m.includes('build/temp.js')));

    // Grep in subdirectory 'src': should NOT search or match inside 'src/build/'
    const grepRes = await gateway.executeGrep({ pattern: 'tmp = true', path: path.join(fixture.safeRoot, 'src') });
    assert.equal(grepRes.ok, true);
    assert.equal(grepRes.matches.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('Symlink alias to ignored file and cycle detection in Glob and Grep', async () => {
  const fixture = createFixture();
  try {
    // 1. Create a symlink aliasing an ignored file
    try {
      fs.symlinkSync(path.join(fixture.safeRoot, 'ignored.log'), path.join(fixture.safeRoot, 'link-to-ignored.txt'));
    } catch {}

    // 2. Create a directory symlink cycle: safeRoot/src/cycle -> safeRoot/src
    try {
      fs.symlinkSync(path.join(fixture.safeRoot, 'src'), path.join(fixture.safeRoot, 'src', 'cycle'));
    } catch {}

    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      ignorePatterns: ['ignored.log'],
    });

    // Glob should skip link-to-ignored.txt because its real target is ignored
    const globRes = await gateway.executeGlob({ pattern: '**/*' });
    assert.equal(globRes.ok, true);
    assert.ok(globRes.matches.every((m) => !m.includes('link-to-ignored')));
    // And it must not infinite loop on 'src/cycle'

    // Grep should also skip link-to-ignored.txt and cycle safely without infinite loop
    const grepRes = await gateway.executeGrep({ pattern: 'helper' });
    assert.equal(grepRes.ok, true);
    assert.ok(grepRes.matches.some((m) => m.path === 'src/util.js'));
  } finally {
    fixture.cleanup();
  }
});

test('ReDoS protection in Grep: rejects catastrophic backtracking regex patterns', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      cwd: fixture.tmpDir,
    });

    // Dangerous nested quantifiers pattern (a+)+
    const dangerous = await gateway.executeGrep({ pattern: '(a+)+' });
    assert.equal(dangerous.ok, false);
    assert.match(dangerous.error, /potential ReDoS pattern/i);

    // Overlapping quantifiers a++
    const overlapping = await gateway.executeGrep({ pattern: 'a++' });
    assert.equal(overlapping.ok, false);
    assert.match(overlapping.error, /potential ReDoS pattern/i);
  } finally {
    fixture.cleanup();
  }
});

test('Single call quota truncation against remaining session byte budget', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      cwd: fixture.tmpDir,
      maxCallReadBytes: 1000,
      maxTotalReadBytes: 80, // session total budget is 80 bytes
    });

    const bigFile = path.join(fixture.safeRoot, 'big.txt');
    fs.writeFileSync(bigFile, 'z'.repeat(500));

    // First call has remainingSessionBytes = 80, so effectiveLimit is 80, not 1000!
    const res = await gateway.executeRead({ file_path: bigFile });
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.match(res.content, /exceeded limit of 80 bytes/i);
    assert.ok(gateway.totalReadBytes >= 80);

    // Second call is immediately rejected because total quota is exhausted
    const res2 = await gateway.executeRead({ file_path: bigFile });
    assert.equal(res2.ok, false);
    assert.match(res2.error, /Read byte quota exceeded/i);
  } finally {
    fixture.cleanup();
  }
});

test('Claude canUseTool and PostToolHook integration bridges with Array and Object responses', async () => {
  const fixture = createFixture();
  try {
    const gateway = new ReadOnlyToolGateway({
      safeRoot: fixture.safeRoot,
      contextRoot: fixture.contextRoot,
      cwd: fixture.tmpDir,
      maxCallReadBytes: 100,
    });

    const canUseTool = gateway.createCanUseTool();

    // 1. Allowed Read
    const allowRes = await canUseTool('Read', { file_path: path.join(fixture.safeRoot, 'index.js') });
    assert.equal(allowRes.behavior, 'allow');
    assert.equal(allowRes.updatedInput.offset, 1);
    assert.equal(allowRes.updatedInput.limit, 2000);

    // 2. Denied unauthorized tool
    const denyTool = await canUseTool('Bash', { command: 'ls' });
    assert.equal(denyTool.behavior, 'deny');
    assert.match(denyTool.message, /not available in review-only mode/i);

    // 3. PostToolUse hook truncates string output exceeding maxCallReadBytes
    const postHook = gateway.createPostToolHook();
    assert.equal(postHook.matcher, 'Read|Glob|Grep');
    const hookFn = postHook.hooks[0];

    const normalOutput = await hookFn({ tool_name: 'Read', tool_input: {}, tool_response: 'short string' });
    assert.deepEqual(normalOutput, {});

    const bigStringOutput = await hookFn({
      tool_name: 'Read',
      tool_input: { file_path: 'foo' },
      tool_response: 'y'.repeat(500),
    });
    assert.ok(bigStringOutput.hookSpecificOutput);
    assert.equal(bigStringOutput.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(bigStringOutput.hookSpecificOutput.updatedToolOutput, /output truncated by host gateway/i);

    // 4. PostToolUse hook truncates oversized Array response
    const bigArray = Array.from({ length: 50 }, (_, i) => ({ id: i, payload: 'large_data_entry_string_item' }));
    const arrayOutput = await hookFn({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*' },
      tool_response: bigArray,
    });
    assert.ok(arrayOutput.hookSpecificOutput);
    assert.ok(Array.isArray(arrayOutput.hookSpecificOutput.updatedToolOutput));
    const lastItem = arrayOutput.hookSpecificOutput.updatedToolOutput[arrayOutput.hookSpecificOutput.updatedToolOutput.length - 1];
    assert.equal(lastItem._truncated, true);

    // 5. PostToolUse hook truncates oversized Object response
    const bigObj = { huge: 'k'.repeat(1000) };
    const objOutput = await hookFn({
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_response: bigObj,
    });
    assert.ok(objOutput.hookSpecificOutput);
    assert.equal(objOutput.hookSpecificOutput.updatedToolOutput._truncated, true);
  } finally {
    fixture.cleanup();
  }
});

test('PR5 compatibility: getToolDeclarations returns valid schema definitions for Read, Glob, Grep', () => {
  const decls = ReadOnlyToolGateway.getToolDeclarations();
  assert.equal(decls.length, 3);
  const names = decls.map((d) => d.name);
  assert.deepEqual(names, ['Read', 'Glob', 'Grep']);
  for (const decl of decls) {
    assert.ok(decl.description);
    assert.equal(decl.parameters.type, 'object');
    assert.ok(decl.parameters.properties);
    assert.ok(Array.isArray(decl.parameters.required));
  }
});
