import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyToolGateway, createGatewayMcpServer } from '../scripts/tool-gateway.mjs';
import { getProviderAdapter, PROVIDER_KINDS } from '../scripts/provider-adapter.mjs';

const [eq, deq, pj] = [assert.equal, assert.deepEqual, path.join];

function createFixture() {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(pj(os.tmpdir(), 'mcp-gw-test-')));
  const [s, c, o] = [pj(tmpDir, 'safe-target'), pj(tmpDir, '.review-context'), pj(tmpDir, 'outside')];
  const w = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };

  w(pj(s, 'index.js'), 'console.log("hello");\nline2\nline3\n');
  w(pj(s, 'src/app.js'), 'export function run() { return 42; }\n// search_term_target\nline3\n');
  w(pj(s, 'src/util.js'), 'export const helper = true;\n');
  w(pj(c, 'pr.diff'), 'diff content for review\n');
  w(pj(c, 'unauthorized-ctx.txt'), 'sensitive context\n');
  w(pj(o, 'secret.key'), 'SUPER_SECRET_KEY');

  try { fs.symlinkSync(pj(o, 'secret.key'), pj(s, 'leak-link.txt')); } catch {}
  try { fs.symlinkSync(o, pj(s, 'leak-dir')); } catch {}
  try { fs.symlinkSync(pj(s, 'src/app.js'), pj(s, 'safe-link.js')); } catch {}
  try { fs.symlinkSync(pj(c, 'pr.diff'), pj(s, 'ctx-link.diff')); } catch {}

  w(pj(s, '.git/HEAD'), 'ref: refs/heads/main\n');
  w(pj(s, '.claude/config.json'), '{}');
  w(pj(s, 'CLAUDE.md'), '# Project Instructions');
  w(pj(s, '.mcp.json'), '{}');
  w(pj(s, 'ignored.log'), 'test log file\n');

  return {
    tmpDir, safeRoot: s, contextRoot: c, outsideRoot: o,
    cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
  };
}

const openServers = new Set();
const withFixture = async (fn) => {
  const f = createFixture();
  try { return await fn(f); } finally {
    for (const server of openServers) {
      try { await server.instance?.close?.(); } finally { openServers.delete(server); }
    }
    f.cleanup();
  }
};

function getHandlers(gateway, serverName = 'gateway') {
  const { tools, toolNames, server } = createGatewayMcpServer(gateway, serverName);
  openServers.add(server);
  const map = Object.fromEntries(tools.map((t) => [t.name, t.handler]));
  return { handlers: map, toolNames, server, tools };
}

test('AC2 & AC7: Host actually executes MCP Read tool returning real file content and respects pagination', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  const { handlers } = getHandlers(gw);

  const res1 = await handlers.Read({ file_path: pj(f.safeRoot, 'index.js') });
  eq(res1.isError, undefined);
  assert.ok(Array.isArray(res1.content) && res1.content.length === 1);
  eq(res1.content[0].type, 'text');
  assert.match(res1.content[0].text, /console\.log\("hello"\);/);

  const resPaged = await handlers.Read({ file_path: pj(f.safeRoot, 'index.js'), offset: 2, limit: 1 });
  eq(resPaged.isError, undefined);
  assert.match(resPaged.content[0].text, /2: line2/);
  assert.match(resPaged.content[0].text, /next offset=3/);
}));

test('AC2 & AC7: Host actually executes MCP Glob tool returning matching files from safeRoot', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  const { handlers } = getHandlers(gw);

  const res = await handlers.Glob({ pattern: '**/*.js' });
  eq(res.isError, undefined);
  const text = res.content[0].text;
  const lines = text.split('\n');
  assert.ok(lines.includes('index.js'));
  assert.ok(lines.includes('src/app.js'));
  assert.ok(lines.includes('src/util.js'));
  // Ensure control files, outside files, and leak symlinks are NOT present
  assert.ok(!lines.some((l) => l.includes('.git') || l.includes('CLAUDE.md') || l.includes('secret') || l.includes('leak')));
}));

test('AC2 & AC7: Host actually executes MCP Grep tool in content and files_with_matches modes', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  const { handlers } = getHandlers(gw);

  const resContent = await handlers.Grep({ pattern: 'search_term_target' });
  eq(resContent.isError, undefined);
  assert.match(resContent.content[0].text, /src\/app\.js:2: \/\/ search_term_target/);

  const resFiles = await handlers.Grep({ pattern: 'search_term_target', output_mode: 'files_with_matches' });
  eq(resFiles.isError, undefined);
  const matchedFiles = resFiles.content[0].text.split('\n');
  assert.ok(matchedFiles.includes('src/app.js'));
  assert.ok(!matchedFiles.some((f) => f.includes('leak') || f.includes('secret')));
}));

test('AC4: Read can access authorized contextRoot files', () => withFixture(async (f) => {
  // Case A: default access is denied; allowlist is mandatory.
  const gwDefault = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  const { handlers: hDef } = getHandlers(gwDefault);
  const resDef = await hDef.Read({ file_path: pj(f.contextRoot, 'pr.diff') });
  eq(resDef.isError, true);
  assert.match(resDef.content[0].text, /unauthorized context file/i);

  // Case B: explicit allowedContextFiles restriction
  const gwRestricted = new ReadOnlyToolGateway({
    safeRoot: f.safeRoot,
    contextRoot: f.contextRoot,
    cwd: f.tmpDir,
    allowedContextFiles: ['pr.diff'],
  });
  const { handlers: hRes } = getHandlers(gwRestricted);

  const resAllowed = await hRes.Read({ file_path: pj(f.contextRoot, 'pr.diff') });
  eq(resAllowed.isError, undefined);
  assert.match(resAllowed.content[0].text, /diff content for review/);

  const resForbidden = await hRes.Read({ file_path: pj(f.contextRoot, 'unauthorized-ctx.txt') });
  eq(resForbidden.isError, true);
  assert.match(resForbidden.content[0].text, /denied for unauthorized context file/i);
}));

test('AC5: Glob and Grep cannot scan contextRoot', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  const { handlers } = getHandlers(gw);

  // Default scan must not return contextRoot files
  const globDef = await handlers.Glob({ pattern: '**/*' });
  eq(globDef.isError, undefined);
  assert.ok(!globDef.content[0].text.includes('pr.diff'));
  assert.ok(!globDef.content[0].text.includes('.review-context'));

  // Explicit path targeting contextRoot must be rejected with isError: true
  const globCtx = await handlers.Glob({ pattern: '*', path: f.contextRoot });
  eq(globCtx.isError, true);
  assert.match(globCtx.content[0].text, /restricted to safe-target/i);

  // Grep targeting contextRoot must be rejected with isError: true
  const grepCtx = await handlers.Grep({ pattern: 'diff', path: f.contextRoot });
  eq(grepCtx.isError, true);
  assert.match(grepCtx.content[0].text, /restricted to safe-target/i);
}));

test('AC6: Path traversal, symlink escapes, control files, and ReDoS Fail Closed', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({
    safeRoot: f.safeRoot,
    contextRoot: f.contextRoot,
    cwd: f.tmpDir,
    ignorePatterns: ['*.log'],
    maxFileSizeBytes: 100,
  });
  const { handlers } = getHandlers(gw);

  // Read ../outside/secret.key
  const rTraversal = await handlers.Read({ file_path: pj(f.safeRoot, '../outside/secret.key') });
  eq(rTraversal.isError, true);
  assert.match(rTraversal.content[0].text, /escapes authorized boundaries/i);

  // Read symlink to outside
  const rSymlink = await handlers.Read({ file_path: pj(f.safeRoot, 'leak-link.txt') });
  eq(rSymlink.isError, true);
  assert.match(rSymlink.content[0].text, /escapes authorized boundaries/i);

  // Read control file
  const rControl = await handlers.Read({ file_path: pj(f.safeRoot, 'CLAUDE.md') });
  eq(rControl.isError, true);
  assert.match(rControl.content[0].text, /Access to control path is forbidden/i);

  // Read ignored file
  const rIgnored = await handlers.Read({ file_path: pj(f.safeRoot, 'ignored.log') });
  eq(rIgnored.isError, true);
  assert.match(rIgnored.content[0].text, /denied for ignored path/i);

  // Read oversized file
  const bigFile = pj(f.safeRoot, 'big.txt');
  fs.writeFileSync(bigFile, 'x'.repeat(200));
  const rBig = await handlers.Read({ file_path: bigFile });
  eq(rBig.isError, true);
  assert.match(rBig.content[0].text, /File size exceeds safety limit/i);

  // Glob path traversal
  const gTraversal = await handlers.Glob({ pattern: '../../escaped/*.js' });
  eq(gTraversal.isError, true);
  assert.match(gTraversal.content[0].text, /escapes the sanitized repository/i);

  // Grep ReDoS
  const grepRedos = await handlers.Grep({ pattern: '(a+)+' });
  eq(grepRedos.isError, true);
  assert.match(grepRedos.content[0].text, /potential ReDoS/i);

  // Grep count mode forbidden
  const grepCount = await handlers.Grep({ pattern: 'run', output_mode: 'count' });
  eq(grepCount.isError, true);
  assert.match(grepCount.content[0].text, /count or stats mode is forbidden/i);
}));

test('AC3 & Req 5: Output size truncation and quota limits enforced before tool returns', () => withFixture(async (f) => {
  const longFile = pj(f.safeRoot, 'long.txt');
  fs.writeFileSync(longFile, 'a'.repeat(500));

  // maxCallReadBytes = 60
  const gw = new ReadOnlyToolGateway({
    safeRoot: f.safeRoot,
    cwd: f.tmpDir,
    maxCallReadBytes: 60,
    maxTotalReadBytes: 200,
    maxCalls: 3,
  });
  const { handlers } = getHandlers(gw);

  // Call 1: Read long file - must be truncated to within maxCallReadBytes and contain truncation note
  const r1 = await handlers.Read({ file_path: longFile });
  eq(r1.isError, undefined);
  assert.match(r1.content[0].text, /more offset=1 col=/i);
  assert.ok(Buffer.byteLength(r1.content[0].text, 'utf8') <= 60);

  // Call 2: Glob
  const r2 = await handlers.Glob({ pattern: '**/*.js' });
  eq(r2.isError, undefined);

  // Call 3: Grep
  const r3 = await handlers.Grep({ pattern: 'helper' });
  eq(r3.isError, undefined);

  // Call 4: maxCalls limit reached (3 calls max) -> must fail closed
  const r4 = await handlers.Read({ file_path: pj(f.safeRoot, 'index.js') });
  eq(r4.isError, true);
  assert.match(r4.content[0].text, /Tool invocation limit exceeded/i);
}));

test('AC3 & Req 5: Total byte budget exhaustion fails closed', () => withFixture(async (f) => {
  const longFile = pj(f.safeRoot, 'long-quota.txt');
  fs.writeFileSync(longFile, 'z'.repeat(500));
  const gw = new ReadOnlyToolGateway({
    safeRoot: f.safeRoot,
    cwd: f.tmpDir,
    maxCallReadBytes: 80,
    maxTotalReadBytes: 80, // first long line fills the bounded result
  });
  const { handlers } = getHandlers(gw);

  const r1 = await handlers.Read({ file_path: longFile });
  eq(r1.isError, undefined);

  // Second call fails because byte quota is exhausted
  const r2 = await handlers.Read({ file_path: pj(f.safeRoot, 'src/util.js') });
  eq(r2.isError, true);
  assert.match(r2.content[0].text, /Read byte quota exceeded/i);
}));

test('Req 5: Concurrent calls share gateway quota safely without race condition bypass', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({
    safeRoot: f.safeRoot,
    cwd: f.tmpDir,
    maxCalls: 2,
  });
  const { handlers } = getHandlers(gw);

  const calls = [
    handlers.Read({ file_path: pj(f.safeRoot, 'index.js') }),
    handlers.Read({ file_path: pj(f.safeRoot, 'src/app.js') }),
    handlers.Read({ file_path: pj(f.safeRoot, 'src/util.js') }),
    handlers.Glob({ pattern: '*.js' }),
  ];

  const results = await Promise.all(calls);
  const successes = results.filter((r) => !r.isError);
  const failures = results.filter((r) => r.isError);

  eq(successes.length, 2);
  eq(failures.length, 2);
  assert.ok(failures.every((f) => /Tool invocation limit exceeded/i.test(f.content[0].text)));
  eq(gw.getDiagnostics().callCount, 2);
  eq(gw.getDiagnostics().quotaExhausted, true);
}));

test('AC1 & AC8: Claude provider adapter mounts MCP Gateway with tools: [], strictMcpConfig, and dontAsk mode', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
  let capturedOptions = null;

  const outcome = await getProviderAdapter(PROVIDER_KINDS.CLAUDE).execute({
    prompt: 'review this PR',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-val' },
    toolGateway: gw,
    queryImpl: async function* ({ options }) {
      capturedOptions = options;
      openServers.add(options.mcpServers.gateway);
      yield {
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        total_cost_usd: 0.2,
        structured_output: { summary: 'review passed' },
      };
    },
  });

  eq(outcome.ok, true);
  eq(outcome.structured.summary, 'review passed');

  // Verify AC1: No built-in tool path exists to bypass gateway
  assert.deepEqual(capturedOptions.tools, []);

  // Verify MCP server configuration
  assert.ok(capturedOptions.mcpServers && capturedOptions.mcpServers.gateway);
  eq(capturedOptions.mcpServers.gateway.name, 'gateway');
  eq(capturedOptions.mcpServers.gateway.type, 'sdk');

  // Verify allowedTools lists ONLY the gateway MCP tools
  assert.deepEqual(capturedOptions.allowedTools, [
    'mcp__gateway__Read',
    'mcp__gateway__Glob',
    'mcp__gateway__Grep',
  ]);

  // Verify toolAliases map built-in names to MCP tools
  assert.deepEqual(capturedOptions.toolAliases, {
    Read: 'mcp__gateway__Read',
    Glob: 'mcp__gateway__Glob',
    Grep: 'mcp__gateway__Grep',
  });

  // Verify security settings
  eq(capturedOptions.permissionMode, 'dontAsk');
  eq(capturedOptions.strictMcpConfig, true);
  assert.deepEqual(capturedOptions.settingSources, []);
}));
test('F001: explicit single-file paths work for Grep and Glob without ENOTDIR', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
  const { handlers } = getHandlers(gw);
  const file = pj(f.safeRoot, 'src/app.js');
  const grep = await handlers.Grep({ pattern: 'search_term_target', path: file });
  eq(grep.isError, undefined);
  assert.match(grep.content[0].text, /src\/app\.js:2/);
  const glob = await handlers.Glob({ pattern: '*.js', path: file });
  eq(glob.isError, undefined);
  assert.match(glob.content[0].text, /src\/app\.js/);
}));

test('F002: catastrophic alternative regex is killed without blocking host event loop', () => withFixture(async (f) => {
  fs.writeFileSync(pj(f.safeRoot, 'evil.txt'), 'a'.repeat(1999) + '!');
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, timeoutMs: 600 });
  const { handlers } = getHandlers(gw);
  const call = handlers.Grep({ pattern: '(a|aa)+b', path: pj(f.safeRoot, 'evil.txt') });
  const responsiveness = await Promise.race([
    call.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('responsive'), 35)),
  ]);
  eq(responsiveness, 'responsive', 'malicious pattern must run off main thread');
  const result = await call;
  eq(result.isError, true);
  assert.match(result.content[0].text, /timed out/i);
}));

test('F003: Read reports line numbers and a next-offset cursor', () => withFixture(async (f) => {
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxReadLines: 1 });
  const { handlers } = getHandlers(gw);
  const first = await handlers.Read({ file_path: pj(f.safeRoot, 'index.js') });
  eq(first.isError, undefined);
  assert.match(first.content[0].text, /1: console\.log/);
  assert.match(first.content[0].text, /next offset=2/);
  const second = await handlers.Read({ file_path: pj(f.safeRoot, 'index.js'), offset: 2 });
  assert.match(second.content[0].text, /2: line2/);
  assert.match(second.content[0].text, /next offset=3/);
}));

test('Host MCP tool result never exceeds maxCallReadBytes, including truncation notice', () => withFixture(async (f) => {
  fs.writeFileSync(pj(f.safeRoot, 'long.txt'), 'x'.repeat(500));
  const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir, maxCallReadBytes: 85 });
  const { handlers } = getHandlers(gw);
  for (const name of ['Read', 'Glob', 'Grep']) {
    const input = name === 'Read'
      ? { file_path: pj(f.safeRoot, 'long.txt') }
      : name === 'Glob' ? { pattern: '**/*' } : { pattern: 'x+', path: pj(f.safeRoot, 'long.txt') };
    const result = await handlers[name](input);
    eq(result.isError, undefined);
    assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 85, name + ' exceeded 85 bytes');
  }
}));
