import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyToolGateway, isControlPath, isSafeGlobPattern, resolveAllowedPath } from '../scripts/tool-gateway.mjs';

function createFixture() {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-')));
  const safeRoot = path.join(tmpDir, 'safe-target'), contextRoot = path.join(tmpDir, '.review-context'), outsideRoot = path.join(tmpDir, 'outside');
  const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  write(path.join(safeRoot, 'index.js'), 'console.log("hello");\nline2\nline3\n');
  write(path.join(safeRoot, 'src/app.js'), 'export function run() { return 42; }\n// search_term_target\n');
  write(path.join(safeRoot, 'src/util.js'), 'export const helper = true;\n');
  write(path.join(contextRoot, 'pr.diff'), 'diff --git a/index.js b/index.js\n');
  write(path.join(outsideRoot, 'secret.key'), 'SUPER_SECRET_TOKEN');
  try { fs.symlinkSync(path.join(outsideRoot, 'secret.key'), path.join(safeRoot, 'leak-link.txt')); } catch {}
  try { fs.symlinkSync(outsideRoot, path.join(safeRoot, 'leak-dir')); } catch {}
  try { fs.symlinkSync(path.join(safeRoot, 'src/app.js'), path.join(safeRoot, 'safe-link.js')); } catch {}
  write(path.join(safeRoot, '.git/HEAD'), 'ref: refs/heads/main\n');
  write(path.join(safeRoot, '.claude/config.json'), '{}');
  write(path.join(safeRoot, 'CLAUDE.md'), '# Instructions');
  write(path.join(safeRoot, '.mcp.json'), '{}');
  write(path.join(safeRoot, 'ignored.log'), 'debug log');
  return { tmpDir, safeRoot, contextRoot, outsideRoot, cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } };
}

const withFixture = async (fn) => { const f = createFixture(); try { return await fn(f); } finally { f.cleanup(); } };

test('Path resolution and boundary checks: prevents escape via ../, absolute paths, and symlinks', () => withFixture((f) => {
  const roots = [f.safeRoot, f.contextRoot];
  for (const p of [path.join(f.safeRoot, 'index.js'), path.join(f.contextRoot, 'pr.diff')]) assert.equal(resolveAllowedPath(p, roots).ok, true);
  for (const p of [path.join(f.safeRoot, '../outside/secret.key'), path.join(f.outsideRoot, 'secret.key'), path.join(f.safeRoot, 'leak-link.txt'), path.join(f.safeRoot, 'leak-dir/secret.key'), 'index.js\0evil', path.join(f.safeRoot, 'missing.txt')]) {
    assert.equal(resolveAllowedPath(p, roots).ok, false);
  }
}));

test('Control path checks: forbids .git, .claude, CLAUDE.md, and .mcp.json', () => withFixture((f) => {
  const roots = [f.safeRoot];
  for (const p of ['CLAUDE.md', '.claude/config.json', '.git/HEAD', '.mcp.json']) {
    assert.equal(isControlPath(p), true);
    assert.equal(resolveAllowedPath(path.join(f.safeRoot, p), roots).ok, false);
  }
  assert.equal(isControlPath('src/normal.js'), false);
}));

test('Safe glob pattern validator: rejects unsafe patterns with ../ or absolute paths', () => {
  for (const p of ['**/*.js', 'src/*.swift']) assert.equal(isSafeGlobPattern(p), true);
  for (const p of ['../outside/*.js', '/etc/*', 'foo/../../bar', 'pattern\0', '', null]) assert.equal(isSafeGlobPattern(p), false);
});

test('ReadOnlyToolGateway Read: normal read, offset/limit pagination, truncation, and bounds', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir, maxCallReadBytes: 50 });
  const r1 = await gw.executeRead({ file_path: path.join(f.safeRoot, 'index.js') });
  assert.equal(r1.ok && r1.lines, 3);
  assert.match(r1.content, /hello/);

  const r2 = await gw.executeRead({ file_path: path.join(f.safeRoot, 'index.js'), offset: 2, limit: 1 });
  assert.equal(r2.ok && r2.content, 'line2');

  const bigFile = path.join(f.safeRoot, 'large.txt');
  fs.writeFileSync(bigFile, 'x'.repeat(200));
  const r3 = await gw.executeRead({ file_path: bigFile });
  assert.equal(r3.ok && r3.truncated, true);
  assert.match(r3.content, /truncated by host gateway/i);
  assert.equal((await gw.executeRead({ file_path: path.join(f.contextRoot, 'pr.diff') })).ok, true);
}));

test('ReadOnlyToolGateway Glob: safe directory scan without shell, obeys boundary and limits', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxGlobMatches: 2 });
  const res = await gw.executeGlob({ pattern: '**/*.js' });
  assert.equal(res.ok && res.count === 2 && res.truncated, true);
  assert.ok(res.matches.every((m) => !m.includes('.git') && !m.includes('CLAUDE.md') && !m.includes('leak')));
  assert.equal((await gw.executeGlob({ pattern: '*.key', path: f.outsideRoot })).ok, false);
  assert.equal((await gw.executeGlob({ pattern: '../../escaped/*.js' })).ok, false);
}));

test('ReadOnlyToolGateway Grep: safe pattern search without shell, obeys boundary and limits', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxGrepMatches: 1 });
  const res = await gw.executeGrep({ pattern: 'search_term_target' });
  assert.equal(res.ok && res.count, 1);
  assert.ok(['src/app.js', 'safe-link.js'].includes(res.matches[0].path));
  assert.equal(res.matches[0].line, 2);
  assert.equal((await gw.executeGrep({ pattern: 'abc\0def' })).ok, false);
  assert.equal((await gw.executeGrep({ pattern: 'SECRET', path: f.outsideRoot })).ok, false);
}));

test('Quota exhaustion and Fail Closed: call budget and total byte budget enforcement', () => withFixture(async (f) => {
  const gw1 = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCalls: 2 });
  assert.equal((await gw1.executeRead({ file_path: path.join(f.safeRoot, 'index.js') })).ok, true);
  assert.equal((await gw1.executeRead({ file_path: path.join(f.safeRoot, 'index.js') })).ok, true);
  assert.match((await gw1.executeRead({ file_path: path.join(f.safeRoot, 'index.js') })).error, /Tool invocation limit exceeded/i);

  const gw2 = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxTotalReadBytes: 30 });
  assert.equal((await gw2.executeRead({ file_path: path.join(f.safeRoot, 'index.js') })).ok, true);
  assert.match((await gw2.executeRead({ file_path: path.join(f.safeRoot, 'index.js') })).error, /Read byte quota exceeded/i);
  assert.equal(gw2.getDiagnostics().quotaExhausted, true);
}));

test('Ignore patterns enforcement: files matching ignore rules are denied', () => withFixture(async (f) => {
  fs.mkdirSync(path.join(f.safeRoot, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.safeRoot, 'nested/tempfile.tmp'), 'temp');
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['ignored.log', '*.tmp'] });
  assert.equal((await gw.authorize('Read', { file_path: path.join(f.safeRoot, 'ignored.log') })).behavior, 'deny');
  assert.equal((await gw.authorize('Read', { file_path: path.join(f.safeRoot, 'nested/tempfile.tmp') })).behavior, 'deny');
}));

test('Glob and Grep ignore rules with subdirectory searchRoot: enforces root-anchored rules', () => withFixture(async (f) => {
  fs.mkdirSync(path.join(f.safeRoot, 'src/build'), { recursive: true });
  fs.writeFileSync(path.join(f.safeRoot, 'src/build/temp.js'), 'export const tmp = true;');
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['/src/build/', 'ignored.log'] });

  const globRes = await gw.executeGlob({ pattern: '**/*.js', path: path.join(f.safeRoot, 'src') });
  assert.ok(globRes.ok && globRes.matches.every((m) => !m.includes('build/temp.js')));

  const grepRes = await gw.executeGrep({ pattern: 'tmp = true', path: path.join(f.safeRoot, 'src') });
  assert.equal(grepRes.ok && grepRes.matches.length, 0);
}));

test('Symlink alias to ignored file and cycle detection in Glob and Grep', () => withFixture(async (f) => {
  try { fs.symlinkSync(path.join(f.safeRoot, 'ignored.log'), path.join(f.safeRoot, 'link-to-ignored.txt')); } catch {}
  try { fs.symlinkSync(path.join(f.safeRoot, 'src'), path.join(f.safeRoot, 'src/cycle')); } catch {}
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['ignored.log'] });

  const globRes = await gw.executeGlob({ pattern: '**/*' });
  assert.ok(globRes.ok && globRes.matches.every((m) => !m.includes('link-to-ignored')));

  const grepRes = await gw.executeGrep({ pattern: 'helper' });
  assert.ok(grepRes.ok && grepRes.matches.some((m) => m.path === 'src/util.js'));
}));

test('ReDoS protection in Grep: rejects catastrophic backtracking regex patterns', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
  assert.equal((await gw.executeGrep({ pattern: '(a+)+' })).ok, false);
  assert.equal((await gw.executeGrep({ pattern: 'a++' })).ok, false);
}));

test('Single call quota truncation against remaining session byte budget', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCallReadBytes: 1000, maxTotalReadBytes: 80 });
  const bigFile = path.join(f.safeRoot, 'big.txt');
  fs.writeFileSync(bigFile, 'z'.repeat(500));

  const res = await gw.executeRead({ file_path: bigFile });
  assert.equal(res.ok && res.truncated, true);
  assert.match(res.content, /exceeded limit of 80 bytes/i);
  assert.match((await gw.executeRead({ file_path: bigFile })).error, /Read byte quota exceeded/i);
}));

test('Claude canUseTool and PostToolHook integration bridges with Array and Object responses', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir, maxCallReadBytes: 100 });
  const canUseTool = gw.createCanUseTool();

  const allowRes = await canUseTool('Read', { file_path: path.join(f.safeRoot, 'index.js') });
  assert.equal(allowRes.behavior, 'allow');
  assert.equal(allowRes.updatedInput.offset, 1);
  assert.equal(allowRes.updatedInput.limit, 2000);
  assert.equal((await canUseTool('Bash', { command: 'ls' })).behavior, 'deny');

  const hookFn = gw.createPostToolHook().hooks[0];
  assert.deepEqual(await hookFn({ tool_name: 'Read', tool_input: {}, tool_response: 'short' }), {});
  assert.match((await hookFn({ tool_name: 'Read', tool_input: {}, tool_response: 'y'.repeat(500) })).hookSpecificOutput.updatedToolOutput, /output truncated by host gateway/i);

  const bigArray = Array.from({ length: 50 }, (_, i) => ({ id: i, payload: 'data_entry_string' }));
  assert.ok(Array.isArray((await hookFn({ tool_name: 'Glob', tool_input: {}, tool_response: bigArray })).hookSpecificOutput.updatedToolOutput));

  const objOut = await hookFn({ tool_name: 'Grep', tool_input: {}, tool_response: { huge: 'k'.repeat(1000) } });
  assert.equal(objOut.hookSpecificOutput.updatedToolOutput._truncated, true);
}));

test('PR5 compatibility: getToolDeclarations returns valid schema definitions for Read, Glob, Grep', () => {
  const decls = ReadOnlyToolGateway.getToolDeclarations();
  assert.equal(decls.length, 3);
  assert.deepEqual(decls.map((d) => d.name), ['Read', 'Glob', 'Grep']);
});