import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyToolGateway as ToolGW, isControlPath, isSafeGlobPattern, resolveAllowedPath } from '../scripts/tool-gateway.mjs';

const [eq, deq, pj] = [assert.equal, assert.deepEqual, path.join];

function createFixture() {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(pj(os.tmpdir(), 'gw-test-')));
  const [s, c, o] = [pj(tmpDir, 'safe-target'), pj(tmpDir, '.review-context'), pj(tmpDir, 'outside')];
  const w = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
  w(pj(s, 'index.js'), 'console.log("hello");\nline2\nline3\n');
  w(pj(s, 'src/app.js'), 'export function run() { return 42; }\n// search_term_target\n');
  w(pj(s, 'src/util.js'), 'export const helper = true;\n');
  w(pj(c, 'pr.diff'), 'diff\n');
  w(pj(o, 'secret.key'), 'SECRET');
  try { fs.symlinkSync(pj(o, 'secret.key'), pj(s, 'leak-link.txt')); } catch {}
  try { fs.symlinkSync(o, pj(s, 'leak-dir')); } catch {}
  try { fs.symlinkSync(pj(s, 'src/app.js'), pj(s, 'safe-link.js')); } catch {}
  w(pj(s, '.git/HEAD'), 'ref\n');
  w(pj(s, '.claude/config.json'), '{}');
  w(pj(s, 'CLAUDE.md'), '# Instructions');
  w(pj(s, '.mcp.json'), '{}');
  w(pj(s, 'ignored.log'), 'log');
  return { tmpDir, safeRoot: s, contextRoot: c, outsideRoot: o, cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } };
}

const withFixture = async (fn) => { const f = createFixture(); try { return await fn(f); } finally { f.cleanup(); } };

test('Path resolution and boundary checks: prevents escape via ../, absolute paths, and symlinks', () => withFixture((f) => {
  const roots = [f.safeRoot, f.contextRoot];
  for (const p of [pj(f.safeRoot, 'index.js'), pj(f.contextRoot, 'pr.diff')]) eq(resolveAllowedPath(p, roots).ok, true);
  for (const p of [pj(f.safeRoot, '../outside/secret.key'), pj(f.outsideRoot, 'secret.key'), pj(f.safeRoot, 'leak-link.txt'), pj(f.safeRoot, 'leak-dir/secret.key'), 'index.js\0evil', pj(f.safeRoot, 'missing.txt')]) eq(resolveAllowedPath(p, roots).ok, false);
}));

test('Control path checks: forbids .git, .claude, CLAUDE.md, and .mcp.json', () => withFixture((f) => {
  for (const p of ['CLAUDE.md', '.claude/config.json', '.git/HEAD', '.mcp.json']) {
    eq(isControlPath(p), true);
    eq(resolveAllowedPath(pj(f.safeRoot, p), [f.safeRoot]).ok, false);
  }
  eq(isControlPath('src/normal.js'), false);
}));

test('Safe glob pattern validator: rejects unsafe patterns with ../ or absolute paths', () => {
  for (const p of ['**/*.js', 'src/*.swift']) eq(isSafeGlobPattern(p), true);
  for (const p of ['../outside/*.js', '/etc/*', 'foo/../../bar', 'pattern\0', '', null]) eq(isSafeGlobPattern(p), false);
});

test('ReadOnlyToolGateway Read: numbered pagination, bounded output, continuation and allowlist', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir, maxCallReadBytes: 70 });
  const p = pj(f.safeRoot, 'index.js');
  const r1 = await gw.executeRead({ file_path: p });
  eq(r1.ok, true);
  assert.match(r1.content, /1: console\.log/);
  assert.ok(Buffer.byteLength(r1.content, 'utf8') <= 70);
  const r2 = await gw.executeRead({ file_path: p, offset: 2, limit: 1 });
  eq(r2.ok, true);
  assert.match(r2.content, /2: line2/);
  assert.match(r2.content, /next offset=3/);
  const big = pj(f.safeRoot, 'large.txt');
  fs.writeFileSync(big, 'x'.repeat(200));
  const r3 = await gw.executeRead({ file_path: big });
  eq(r3.ok && r3.truncated, true);
  assert.match(r3.content, /more offset=1 col=/);
  assert.ok(Buffer.byteLength(r3.content, 'utf8') <= 70);
  eq((await gw.executeRead({ file_path: pj(f.contextRoot, 'pr.diff') })).ok, false);
  const gwAllowed = new ToolGW({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir, allowedContextFiles: ['pr.diff'] });
  eq((await gwAllowed.executeRead({ file_path: pj(f.contextRoot, 'pr.diff') })).ok, true);
}));

test('ReadOnlyToolGateway Glob: safe directory scan without shell, obeys boundary and limits', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxGlobMatches: 2 });
  const res = await gw.executeGlob({ pattern: '**/*.js' });
  eq(res.ok && res.count === 2 && res.truncated, true);
  assert.ok(res.matches.every((m) => !m.includes('.git') && !m.includes('CLAUDE.md') && !m.includes('leak')));
  eq((await gw.executeGlob({ pattern: '*.key', path: f.outsideRoot })).ok, false);
  eq((await gw.executeGlob({ pattern: '../../escaped/*.js' })).ok, false);
}));

test('ReadOnlyToolGateway Grep: safe pattern search without shell, obeys boundary and limits', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxGrepMatches: 1 });
  const res = await gw.executeGrep({ pattern: 'search_term_target' });
  eq(res.ok && res.count === 1 && res.matches[0].line === 2, true);
  assert.ok(['src/app.js', 'safe-link.js'].includes(res.matches[0].path));
  eq((await gw.executeGrep({ pattern: 'abc\0def' })).ok, false);
  eq((await gw.executeGrep({ pattern: 'SECRET', path: f.outsideRoot })).ok, false);
}));

test('Quota exhaustion and Fail Closed: call budget and total byte budget enforcement', () => withFixture(async (f) => {
  const p = pj(f.safeRoot, 'index.js'), g1 = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCalls: 2 });
  eq((await g1.executeRead({ file_path: p })).ok, true);
  eq((await g1.executeRead({ file_path: p })).ok, true);
  assert.match((await g1.executeRead({ file_path: p })).error, /Tool invocation limit exceeded/i);

  const long = pj(f.safeRoot, 'big-budget.txt');
  fs.writeFileSync(long, 'z'.repeat(500));
  const g2 = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCallReadBytes: 80, maxTotalReadBytes: 80 });
  const first = await g2.executeRead({ file_path: long });
  eq(first.ok && first.truncated, true);
  assert.ok(first.bytesRead <= 80);
  const second = await g2.executeRead({ file_path: long });
  eq(second.ok, false);
  assert.match(second.error, /byte quota|budget too small/i);
  assert.ok(g2.getDiagnostics().totalReadBytes <= 80);
}));

test('Ignore patterns enforcement: files matching ignore rules are denied', () => withFixture(async (f) => {
  fs.mkdirSync(pj(f.safeRoot, 'nested'), { recursive: true });
  fs.writeFileSync(pj(f.safeRoot, 'nested/tempfile.tmp'), 'temp');
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['ignored.log', '*.tmp'] });
  eq((await gw.authorize('Read', { file_path: pj(f.safeRoot, 'ignored.log') })).behavior, 'deny');
  eq((await gw.authorize('Read', { file_path: pj(f.safeRoot, 'nested/tempfile.tmp') })).behavior, 'deny');
}));

test('Glob and Grep ignore rules with subdirectory searchRoot: enforces root-anchored rules', () => withFixture(async (f) => {
  fs.mkdirSync(pj(f.safeRoot, 'src/build'), { recursive: true });
  fs.writeFileSync(pj(f.safeRoot, 'src/build/temp.js'), 'export const tmp = true;');
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['/src/build/', 'ignored.log'] });
  const globRes = await gw.executeGlob({ pattern: '**/*.js', path: pj(f.safeRoot, 'src') });
  assert.ok(globRes.ok && globRes.matches.every((m) => !m.includes('build/temp.js')));
  const grepRes = await gw.executeGrep({ pattern: 'tmp = true', path: pj(f.safeRoot, 'src') });
  eq(grepRes.ok && grepRes.matches.length, 0);
}));

test('Symlink alias to ignored file and cycle detection in Glob and Grep', () => withFixture(async (f) => {
  try { fs.symlinkSync(pj(f.safeRoot, 'ignored.log'), pj(f.safeRoot, 'link-to-ignored.txt')); } catch {}
  try { fs.symlinkSync(pj(f.safeRoot, 'src'), pj(f.safeRoot, 'src/cycle')); } catch {}
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['ignored.log'] });
  const globRes = await gw.executeGlob({ pattern: '**/*' });
  assert.ok(globRes.ok && globRes.matches.every((m) => !m.includes('link-to-ignored')));
  const grepRes = await gw.executeGrep({ pattern: 'helper' });
  assert.ok(grepRes.ok && grepRes.matches.some((m) => m.path === 'src/util.js'));
}));

test('ReDoS protection in Grep: rejects catastrophic backtracking regex patterns', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir });
  eq((await gw.executeGrep({ pattern: '(a+)+' })).ok, false);
  eq((await gw.executeGrep({ pattern: 'a++' })).ok, false);
}));

test('Single call quota truncation against remaining session byte budget', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCallReadBytes: 1000, maxTotalReadBytes: 80 });
  const big = pj(f.safeRoot, 'big.txt');
  fs.writeFileSync(big, 'z'.repeat(500));
  const res = await gw.executeRead({ file_path: big });
  eq(res.ok && res.truncated && /more offset=1 col=/i.test(res.content), true);
  assert.ok(Buffer.byteLength(res.content, 'utf8') <= 80);
  assert.match((await gw.executeRead({ file_path: big })).error, /Read byte quota exceeded|Read byte budget too small|Read output budget too small/i);
}));

test('Claude canUseTool and PostToolHook integration bridges with Array and Object responses', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir, maxCallReadBytes: 100, ignorePatterns: ['ignored.log'] });
  const canUseTool = gw.createCanUseTool(), hookFn = gw.createPostToolHook().hooks[0];
  const allowRes = await canUseTool('Read', { file_path: pj(f.safeRoot, 'index.js') });
  eq(allowRes.behavior === 'allow' && allowRes.updatedInput.offset === 1 && allowRes.updatedInput.limit === 2000, true);
  for (const [t, inp] of [['Bash', { command: 'ls' }], ['Glob', { pattern: '*.js', path: pj(f.safeRoot, 'ignored.log') }], ['Grep', { pattern: 'test', path: pj(f.safeRoot, 'ignored.log') }]]) {
    eq((await canUseTool(t, inp)).behavior, 'deny');
  }
  deq(await hookFn({ tool_name: 'Read', tool_input: {}, tool_response: 'short' }), {});
  assert.match((await hookFn({ tool_name: 'Read', tool_input: {}, tool_response: 'y'.repeat(500) })).hookSpecificOutput.updatedToolOutput, /output truncated by host gateway/i);
  deq((await hookFn({ tool_name: 'Glob', tool_input: {}, tool_response: Array.from({ length: 50 }, (_, i) => ({ id: i, payload: 'data' })) })).hookSpecificOutput.updatedToolOutput, []);
  eq((await hookFn({ tool_name: 'Grep', tool_input: {}, tool_response: { content: 'index.js:1: ' + 'k'.repeat(1000) } })).hookSpecificOutput.updatedToolOutput._truncated, true);
  const rawGlob = ['.git/config', 'CLAUDE.md', 'index.js', 'leak-link.txt'];
  deq((await hookFn({ tool_name: 'Glob', tool_input: {}, tool_response: rawGlob })).hookSpecificOutput.updatedToolOutput, ['index.js']);
  deq((await hookFn({ tool_name: 'Glob', tool_input: {}, tool_response: { filenames: rawGlob, other: 'drop' } })).hookSpecificOutput.updatedToolOutput, { filenames: ['index.js'] });
  deq((await hookFn({ tool_name: 'Grep', tool_input: {}, tool_response: { content: 'index.js:1: valid\nCLAUDE.md:1: secret\nleak-link.txt:1: key' } })).hookSpecificOutput.updatedToolOutput, { content: 'index.js:1: valid' });
  const grepContext = await hookFn({ tool_name: 'Grep', tool_input: {}, tool_response: 'index.js-1-ctx\nCLAUDE.md-1-secret' });
  deq(grepContext.hookSpecificOutput.updatedToolOutput, 'index.js-1-ctx');
}));

test('Regression: authorize increments callCount immediately to prevent concurrent/batched quota bypass', () => withFixture(async (f) => {
  const p = pj(f.safeRoot, 'index.js');
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCalls: 2 });
  eq((await gw.authorize('Read', { file_path: p })).behavior, 'allow');
  eq(gw.getDiagnostics().callCount, 1);
  eq((await gw.authorize('Read', { file_path: p })).behavior, 'allow');
  eq(gw.getDiagnostics().callCount, 2);
  eq((await gw.authorize('Read', { file_path: p })).behavior, 'deny');
  eq(gw.getDiagnostics().quotaExhausted, true);
}));

test('Regression: authorize Read checks symlink alias against ignorePatterns and enforces maxFileSizeBytes', () => withFixture(async (f) => {
  try { fs.symlinkSync(pj(f.safeRoot, 'index.js'), pj(f.safeRoot, 'alias.log')); } catch {}
  const huge = pj(f.safeRoot, 'huge.js');
  fs.writeFileSync(huge, 'x'.repeat(600));
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['*.log'], maxFileSizeBytes: 500 });
  const aliasRes = await gw.authorize('Read', { file_path: pj(f.safeRoot, 'alias.log') });
  eq(aliasRes.behavior, 'deny');
  assert.match(aliasRes.message, /ignored path alias/i);
  const hugeRes = await gw.authorize('Read', { file_path: huge });
  eq(hugeRes.behavior, 'deny');
  assert.match(hugeRes.message, /File size exceeds safety limit/i);
}));

test('Regression: authorize Grep allows files_with_matches and content modes, forbids count mode and unauthorized paths', () => withFixture(async (f) => {
  const gw = new ToolGW({ safeRoot: f.safeRoot, cwd: f.tmpDir, ignorePatterns: ['ignored.log'] });
  for (const extra of [{ mode: 'count' }, { count: true }, { stats: true }, { output_mode: 'count' }]) {
    eq((await gw.authorize('Grep', { pattern: 'test', ...extra })).behavior, 'deny');
  }
  for (const extra of [{ output_mode: 'files_with_matches' }, { output_mode: 'content' }, {}]) {
    eq((await gw.authorize('Grep', { pattern: 'test', ...extra })).behavior, 'allow');
  }
  for (const badPath of ['CLAUDE.md', 'ignored.log', 'leak-link.txt']) {
    eq((await gw.authorize('Grep', { pattern: 'test', path: pj(f.safeRoot, badPath) })).behavior, 'deny');
  }
  eq((await gw.authorize('Grep', { pattern: '(a+)+' })).behavior, 'deny');

  // Verify Host-enforced bridge delegating to authorize and PostToolHook sanitization:
  const prevCount = gw.getDiagnostics().callCount;
  const canUseTool = gw.createCanUseTool(), hookFn = gw.createPostToolHook().hooks[0];
  const canRes = await canUseTool('Grep', { pattern: 'search_term_target', output_mode: 'files_with_matches' });
  eq(canRes.behavior, 'allow');
  eq(canRes.updatedInput.path, f.safeRoot);
  eq(gw.getDiagnostics().callCount, prevCount + 1);

  // Verify fallback plain-path sanitization in files_with_matches mode:
  const rawFiles = 'index.js\nCLAUDE.md\nleak-link.txt\nsrc/app.js';
  const sanitizedFiles = await hookFn({ tool_name: 'Grep', tool_input: {}, tool_response: rawFiles });
  deq(sanitizedFiles.hookSpecificOutput.updatedToolOutput, 'index.js\nsrc/app.js');
  eq(gw.getDiagnostics().callCount, prevCount + 1);
}));

test('PR5 compatibility: getToolDeclarations returns valid schema definitions for Read, Glob, Grep', () => {
  const decls = ToolGW.getToolDeclarations();
  eq(decls.length, 3);
  deq(decls.map((d) => d.name), ['Read', 'Glob', 'Grep']);
});

test('F001 & F003: tool-gateway and provider-adapter have no static ESM imports of SDK or Zod and do not resolve them at load time', async () => {
  const { execSync } = await import('node:child_process');

  // 1. Static text verification: ensure no static ESM import statements exist in the files
  const forbiddenImportPattern = /(?:^|\n)\s*import\s+.*(?:from\s+)?['"](?:@anthropic-ai\/claude-agent-sdk|zod)['"]/m;
  const toolGatewaySrc = fs.readFileSync(path.resolve(process.cwd(), 'scripts/tool-gateway.mjs'), 'utf8');
  const providerAdapterSrc = fs.readFileSync(path.resolve(process.cwd(), 'scripts/provider-adapter.mjs'), 'utf8');
  assert.equal(forbiddenImportPattern.test(toolGatewaySrc), false, 'scripts/tool-gateway.mjs must not contain static imports of SDK or zod');
  assert.equal(forbiddenImportPattern.test(providerAdapterSrc), false, 'scripts/provider-adapter.mjs must not contain static imports of SDK or zod');

  // 2. Dynamic ESM loader verification: ensure ESM module resolution fails if SDK or zod is requested at import time
  const loaderCode = `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '@anthropic-ai/claude-agent-sdk' || specifier === 'zod') {
        throw new Error('RESOLVE_BLOCKED: ' + specifier);
      }
      return nextResolve(specifier, context);
    }
  `;
  const loaderUrl = 'data:text/javascript,' + encodeURIComponent(loaderCode);

  // Importing tool-gateway and provider-adapter must NOT trigger SDK or zod resolution
  execSync(`node --no-warnings --loader "${loaderUrl}" -e "await import('./scripts/tool-gateway.mjs'); await import('./scripts/provider-adapter.mjs');"`, {
    cwd: process.cwd(),
    stdio: 'pipe',
  });

  // Verify that the blocking loader indeed catches static imports of zod or the SDK
  let blocked = false;
  try {
    execSync(`node --no-warnings --loader "${loaderUrl}" -e "import 'zod';"`, {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
  } catch (err) {
    blocked = err.stderr?.toString()?.includes('RESOLVE_BLOCKED: zod');
  }
  assert.equal(blocked, true, 'Custom ESM loader must catch static ESM imports');
});
