// Disposable, opt-in validation for PR4. Never merge into main.
// Executes only a bounded Claude SDK call and Host MCP Read/Grep over a fresh temp fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProviderAdapter, PROVIDER_KINDS } from './provider-adapter.mjs';
import { ReadOnlyToolGateway } from './tool-gateway.mjs';

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  throw new Error('CLAUDE_CODE_OAUTH_TOKEN is unavailable; no paid smoke was attempted');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr4-live-mcp-'));
const safeRoot = path.join(root, 'safe-target');
fs.mkdirSync(safeRoot, { recursive: true, mode: 0o700 });
const fixture = path.join(safeRoot, 'case.txt');
const expectedMarker = 'PR4_MCP_READ_VERIFIED_20261106';
fs.writeFileSync(fixture, `marker=${expectedMarker}\nsearch=MiXeD_CaSe_SpInLaB\n`, { mode: 0o600 });

try {
  const gateway = new ReadOnlyToolGateway({
    safeRoot, cwd: root,
    maxCalls: 6, maxCallReadBytes: 1024, maxTotalReadBytes: 3072,
    maxReadLines: 20, timeoutMs: 5000,
  });
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE, {
    defaultModel: 'sonnet', defaultEffort: 'medium',
  });
  const prompt = `You are performing an authorized one-time MCP tool integration test.
You MUST actually invoke both registered tools mcp__gateway__Read and mcp__gateway__Grep.
First use Read with file_path ${JSON.stringify(fixture)}.
Then use Grep with path "case.txt", pattern "mixed_case_spinlab", and "-i": true.
Only after receiving both tool outputs, return structured JSON containing:
- marker: exactly the value after "marker=" from the Read output
- summary: a brief statement that Grep matched the mixed-case line.
Do not guess the marker or replace tool calls with a simulated answer.
Do not read or search any other files.`;
  const outcome = await adapter.execute({
    prompt,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { marker: { type: 'string' }, summary: { type: 'string' } },
      required: ['marker', 'summary'],
    },
    cwd: root, env: process.env, isolateEnv: true, requireAuthToken: true,
    toolGateway: gateway, tools: [],
    model: 'sonnet', effort: 'medium',
    timeoutMs: 90_000, maxTurns: 7, maxBudgetUsd: 0.45,
  });

  const diagnostics = gateway.getDiagnostics();
  const readSucceeded = diagnostics.history.some((item) => item.toolName === 'Read' && item.status === 'success');
  const grepSucceeded = diagnostics.history.some((item) => item.toolName === 'Grep' && item.status === 'success');
  if (!outcome.ok) {
    throw new Error(`Claude Provider Adapter failed: ${outcome.errorKind}: ${outcome.error}`);
  }
  if (!readSucceeded || !grepSucceeded) {
    throw new Error(`Missing real MCP tool execution: Read=${readSucceeded} Grep=${grepSucceeded}; total_calls=${diagnostics.callCount}`);
  }
  if (outcome.structured?.marker !== expectedMarker) {
    throw new Error('Model structured output did not match the marker stored only in the on-disk fixture');
  }
  if (typeof outcome.structured?.summary !== 'string' || !outcome.structured.summary.trim()) {
    throw new Error('Model returned an empty Grep summary');
  }
  if (typeof outcome.meta?.total_cost_usd === 'number' && outcome.meta.total_cost_usd > 0.45) {
    throw new Error('SDK cost exceeded the configured $0.45 call budget');
  }
  console.log('PR4_LIVE_MCP_SMOKE_PASS ' + JSON.stringify({
    head: process.env.GITHUB_HEAD_REF || 'local',
    model: outcome.meta?.resolved_model,
    turns: outcome.meta?.num_turns,
    sdk_cost_usd: outcome.meta?.total_cost_usd,
    cost_source: outcome.meta?.cost_source,
    calls: diagnostics.callCount,
    readSucceeded, grepSucceeded, markerMatches: true,
    maxBudgetUsd: 0.45, maxTurns: 7, fullOutputBytes: diagnostics.totalReadBytes,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
