import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGeminiRequest, runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { verifyAcceptanceWithModel, verifyDismissalWithModel } from '../scripts/dismiss-verifier.mjs';
import { validateMaterialFindings } from '../scripts/validate-gemini-findings.mjs';
import { claudeToolOptions } from '../scripts/claude-fallback.mjs';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

function makeTempWorkspace({ mode = 'incremental' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-paths-'));
  const safeRepo = path.join(root, 'safe-target');
  const ctxDir = path.join(root, 'ctx');
  fs.mkdirSync(path.join(safeRepo, 'src'), { recursive: true });
  fs.mkdirSync(ctxDir, { recursive: true });

  fs.writeFileSync(
    path.join(safeRepo, 'src', 'helper.mjs'),
    [
      'export function sanitizeInput(value) {',
      '  if (typeof value !== "string") return "";',
      '  return value.replace(/[^a-zA-Z0-9_-]/g, "");',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(safeRepo, 'src', 'handler.mjs'),
    [
      'import { sanitizeInput } from "./helper.mjs";',
      'export function handleUser(raw) {',
      '  return sanitizeInput(raw);',
      '}',
      '',
    ].join('\n'),
  );

  const diff = [
    'diff --git a/src/handler.mjs b/src/handler.mjs',
    '--- a/src/handler.mjs',
    '+++ b/src/handler.mjs',
    '@@ -1,3 +1,4 @@',
    '+import { sanitizeInput } from "./helper.mjs";',
    ' export function handleUser(raw) {',
    '-  return raw;',
    '+  return sanitizeInput(raw);',
    ' }',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 104, title: 'test' }));
  fs.writeFileSync(path.join(ctxDir, 'pr.diff'), diff);
  fs.writeFileSync(path.join(ctxDir, 'repair.diff'), diff);
  fs.writeFileSync(
    path.join(ctxDir, 'session-plan.json'),
    JSON.stringify({
      decision: { mode },
      session: mode === 'verification'
        ? {
          version: 1,
          baseSha: BASE_SHA,
          lastReviewedHead: BASE_SHA,
          status: 'REWORK',
          findings: [
            {
              id: 'F001',
              severity: 'P1',
              status: 'OPEN',
              title: 'Unsanitized input',
              body: 'handleUser returns raw input without sanitization',
              path: 'src/handler.mjs',
              line: 2,
              riskClass: 'security',
            },
          ],
          deepSpendUsd: 0,
        }
        : null,
    }),
  );

  return { root, safeRepo, ctxDir };
}

test('buildGeminiRequest includes read-only tool and reused-function verification guidance when hasTools is true', () => {
  const session = {
    version: 1,
    baseSha: BASE_SHA,
    lastReviewedHead: BASE_SHA,
    status: 'REWORK',
    findings: [{ id: 'F001', severity: 'P1', status: 'OPEN', title: 't', body: 'b', path: 'a', line: 1, riskClass: 'bug' }],
  };
  const withoutTools = buildGeminiRequest({
    mode: 'verification',
    repo: 'o/r',
    prNumber: 1,
    headSha: HEAD_SHA,
    prJson: '{}',
    diff: 'diff --git a/a b/a',
    session,
    hasTools: false,
  });
  assert.doesNotMatch(withoutTools.prompt, /MANDATORY REUSED-FUNCTION CHECK/);

  const withTools = buildGeminiRequest({
    mode: 'verification',
    repo: 'o/r',
    prNumber: 1,
    headSha: HEAD_SHA,
    prJson: '{}',
    diff: 'diff --git a/a b/a',
    session,
    hasTools: true,
  });
  assert.match(withTools.prompt, /READ-ONLY REPOSITORY TOOLS/);
  assert.match(withTools.prompt, /MANDATORY REUSED-FUNCTION CHECK/);
  assert.match(withTools.prompt, /Read.*Grep|Grep.*Read/);
});

test('runGeminiReview mounts ReadOnlyToolGateway with maxTurns=8 on Claude fallback when SAFE_REPO_DIR exists', async () => {
  const { safeRepo, ctxDir } = makeTempWorkspace({ mode: 'incremental' });
  const claudeCalls = [];
  const result = await runGeminiReview({
    env: {
      GEMINI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      TARGET_REPO: 'o/r',
      PR_NUMBER: '104',
      HEAD_SHA,
      REVIEW_CONTEXT_DIR: ctxDir,
      SAFE_REPO_DIR: safeRepo,
    },
    logImpl: () => {},
    fetchImpl: async () => new Response('credits depleted', { status: 402 }),
    queryImpl: async function* (args) {
      claudeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { summary: 'ok with tools', findings: [] },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  });

  assert.equal(result._meta.provider, 'claude');
  assert.equal(claudeCalls.length, 1);
  const opts = claudeCalls[0].options;
  assert.equal(opts.maxTurns, 8);
  assert.deepEqual(opts.tools, []);
  assert.ok(opts.mcpServers?.gateway, 'Claude fallback must receive ReadOnlyToolGateway MCP server');
  assert.deepEqual(opts.allowedTools, ['mcp__gateway__Read', 'mcp__gateway__Glob', 'mcp__gateway__Grep']);
  assert.match(claudeCalls[0].prompt, /READ-ONLY REPOSITORY TOOLS/);
});

test('verification mode: Gemini reads reused helper via Read tool before returning FIXED', async () => {
  const { safeRepo, ctxDir } = makeTempWorkspace({ mode: 'verification' });
  let turn = 0;
  const result = await runGeminiReview({
    env: {
      GEMINI_API_KEY: 'k',
      TARGET_REPO: 'o/r',
      PR_NUMBER: '104',
      HEAD_SHA,
      REVIEW_CONTEXT_DIR: ctxDir,
      SAFE_REPO_DIR: safeRepo,
    },
    logImpl: () => {},
    fetchImpl: async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      if (turn === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'Read', args: { file_path: 'src/helper.mjs' } } }],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }), { status: 200 });
      }
      const fnResp = body.contents.at(-1)?.parts?.[0]?.functionResponse?.response?.output || '';
      assert.match(fnResp, /sanitizeInput/);
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              text: JSON.stringify({
                summary: 'Verified via helper.mjs',
                verifications: [{ findingId: 'F001', status: 'FIXED', reason: 'sanitizeInput strips unsafe chars' }],
                findings: [],
              }),
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
      }), { status: 200 });
    },
  });

  assert.equal(turn, 2);
  assert.equal(result.verifications[0].status, 'FIXED');
});

test('dismiss-verifier uses ReadOnlyToolGateway (maxTurns=6) on both Gemini and Claude fallback', async () => {
  const { safeRepo } = makeTempWorkspace();
  const finding = {
    id: 'F001',
    severity: 'P1',
    title: 'Unsanitized input',
    body: 'handleUser does not sanitize raw',
    path: 'src/handler.mjs',
    line: 2,
  };

  // 1. Gemini multi-turn tool read -> DISMISSED
  let geminiTurns = 0;
  const geminiRes = await verifyDismissalWithModel({
    repo: 'o/r',
    prNumber: 104,
    headSha: HEAD_SHA,
    finding,
    reason: 'sanitizeInput in src/helper.mjs already strips non-alphanumeric characters',
    evidence: [],
    session: { deepSpendUsd: 0 },
    repoRoot: safeRepo,
    prDiff: '',
    env: { GEMINI_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
    fetchImpl: async () => {
      geminiTurns += 1;
      if (geminiTurns === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'Read', args: { file_path: 'src/helper.mjs' } } }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              text: JSON.stringify({
                verdict: 'DISMISSED',
                reason: 'sanitizeInput strips all characters outside [a-zA-Z0-9_-].',
                nextStep: '',
                sourceAnchors: [{ path: 'src/handler.mjs', line: 3, quote: 'return sanitizeInput(raw);' }],
              }),
            }],
          },
        }],
      }), { status: 200 });
    },
  });
  assert.equal(geminiTurns, 2);
  assert.equal(geminiRes.verdict, 'DISMISSED');
  assert.equal(geminiRes.provider, 'gemini');

  // 2. Claude fallback on Gemini 429 -> mounts gateway + maxTurns=6
  const claudeCalls = [];
  const claudeRes = await verifyDismissalWithModel({
    repo: 'o/r',
    prNumber: 104,
    headSha: HEAD_SHA,
    finding,
    reason: 'sanitizeInput in src/helper.mjs already strips non-alphanumeric characters',
    evidence: [],
    session: { deepSpendUsd: 0 },
    repoRoot: safeRepo,
    prDiff: '',
    env: { GEMINI_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
    fetchImpl: async () => new Response('rate limit', { status: 429 }),
    queryImpl: async function* (args) {
      claudeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: {
          verdict: 'DISMISSED',
          reason: 'sanitizeInput strips all characters outside [a-zA-Z0-9_-].',
          nextStep: '',
          sourceAnchors: [{ path: 'src/handler.mjs', line: 3, quote: 'return sanitizeInput(raw);' }],
        },
      };
    },
  });
  assert.equal(claudeRes.verdict, 'DISMISSED');
  assert.equal(claudeRes.provider, 'claude');
  assert.equal(claudeCalls[0].options.maxTurns, 6);
  assert.ok(claudeCalls[0].options.mcpServers?.gateway);
  assert.deepEqual(claudeCalls[0].options.allowedTools, ['mcp__gateway__Read', 'mcp__gateway__Glob', 'mcp__gateway__Grep']);

  // 3. Non-unavailable Gemini HTTP 400 fails closed without calling Claude
  const badStatusClaudeCalls = [];
  const badStatusRes = await verifyDismissalWithModel({
    repo: 'o/r',
    prNumber: 104,
    headSha: HEAD_SHA,
    finding,
    reason: 'false positive',
    evidence: [],
    session: { deepSpendUsd: 0 },
    repoRoot: safeRepo,
    prDiff: '',
    env: { GEMINI_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
    fetchImpl: async () => new Response('bad request', { status: 400 }),
    queryImpl: async function* (args) {
      badStatusClaudeCalls.push(args);
      yield { type: 'result', subtype: 'success', structured_output: {} };
    },
  });
  assert.equal(badStatusRes.verdict, 'INCONCLUSIVE');
  assert.equal(badStatusClaudeCalls.length, 0);
});

test('validate-gemini-findings uses ReadOnlyToolGateway (maxTurns=6) on Gemini and Claude fallback', async () => {
  const { safeRepo, ctxDir } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(ctxDir, 'review.json'),
    JSON.stringify({
      summary: 'raw',
      findings: [
        {
          severity: 'P1',
          title: 'Missing sanitization',
          body: 'handleUser does not sanitize',
          path: 'src/handler.mjs',
          line: 2,
          riskClass: 'security',
          failurePath: 'raw passes through',
        },
      ],
      _meta: { mode: 'full', provider: 'gemini' },
    }),
  );

  // 1. Gemini multi-turn tool call -> CONFIRMED
  let geminiTurns = 0;
  const geminiOut = await validateMaterialFindings({
    env: {
      GEMINI_API_KEY: 'k',
      TARGET_REPO: 'o/r',
      PR_NUMBER: '104',
      HEAD_SHA,
      TARGET_REPO_DIR: safeRepo,
      SAFE_REPO_DIR: safeRepo,
      REVIEW_CONTEXT_DIR: ctxDir,
    },
    fetchImpl: async () => {
      geminiTurns += 1;
      if (geminiTurns === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'Read', args: { file_path: 'src/helper.mjs' } } }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              text: JSON.stringify({
                summary: 'Validated with tools',
                validations: [{
                  candidateId: 'D001',
                  verdict: 'CONFIRMED',
                  reason: 'Checked helper.mjs and confirmed.',
                  evidence: ['src/helper.mjs'],
                  sourceAnchors: [{ path: 'src/handler.mjs', line: 3, quote: 'return sanitizeInput(raw);' }],
                }],
              }),
            }],
          },
        }],
      }), { status: 200 });
    },
  });
  assert.equal(geminiTurns, 2);
  assert.equal(geminiOut.findings.length, 1);

  // 2. Claude fallback on Gemini 402 -> mounts gateway + maxTurns=6
  const claudeCalls = [];
  const claudeOut = await validateMaterialFindings({
    env: {
      GEMINI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      TARGET_REPO: 'o/r',
      PR_NUMBER: '104',
      HEAD_SHA,
      TARGET_REPO_DIR: safeRepo,
      SAFE_REPO_DIR: safeRepo,
      REVIEW_CONTEXT_DIR: ctxDir,
    },
    fetchImpl: async () => new Response('quota exceeded', { status: 402 }),
    queryImpl: async function* (args) {
      claudeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: {
          summary: 'Validated by Claude with tools',
          validations: [{
            candidateId: 'D001',
            verdict: 'CONFIRMED',
            reason: 'Checked helper.mjs and confirmed.',
            evidence: ['src/helper.mjs'],
            sourceAnchors: [{ path: 'src/handler.mjs', line: 3, quote: 'return sanitizeInput(raw);' }],
          }],
        },
      };
    },
  });
  assert.equal(claudeOut.findings.length, 1);
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].options.maxTurns, 6);
  assert.ok(claudeCalls[0].options.mcpServers?.gateway);
  assert.deepEqual(claudeCalls[0].options.allowedTools, ['mcp__gateway__Read', 'mcp__gateway__Glob', 'mcp__gateway__Grep']);

  // 3. When SAFE_REPO_DIR is unset (and no safe-target exists), validator must NOT mount tools on TARGET_REPO_DIR
  const noSafeCalls = [];
  await validateMaterialFindings({
    env: {
      GEMINI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      TARGET_REPO: 'o/r',
      PR_NUMBER: '104',
      HEAD_SHA,
      TARGET_REPO_DIR: safeRepo,
      REVIEW_CONTEXT_DIR: ctxDir,
    },
    fetchImpl: async () => new Response('quota exceeded', { status: 402 }),
    queryImpl: async function* (args) {
      noSafeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: {
          summary: 'Validated without tools',
          validations: [{
            candidateId: 'D001',
            verdict: 'CONFIRMED',
            reason: 'Confirmed from inline context.',
            evidence: ['src/handler.mjs'],
            sourceAnchors: [{ path: 'src/handler.mjs', line: 3, quote: 'return sanitizeInput(raw);' }],
          }],
        },
      };
    },
  });
  assert.equal(noSafeCalls.length, 1);
  assert.equal(noSafeCalls[0].options.mcpServers?.gateway, undefined);
  assert.doesNotMatch(noSafeCalls[0].prompt, /READ-ONLY REPOSITORY TOOLS/);
});

test('claudeToolOptions(null) denies all tools when safeRoot is absent, and verifyAcceptanceWithModel mounts gateway when repoRoot is present', async () => {
  const denied = claudeToolOptions(null);
  assert.deepEqual(denied.tools, []);
  const perm = await denied.canUseTool('Read', { file_path: '/etc/passwd' });
  assert.equal(perm.behavior, 'deny');

  const { safeRepo } = makeTempWorkspace();
  const claudeCalls = [];
  const acceptRes = await verifyAcceptanceWithModel({
    repo: 'o/r',
    prNumber: 104,
    headSha: HEAD_SHA,
    finding: { id: 'F001', severity: 'P3', title: 'Minor', body: 'Minor issue', path: 'src/handler.mjs', line: 2 },
    statement: 'We accept this minor risk and will monitor logs if it occurs.',
    session: { deepSpendUsd: 0 },
    repoRoot: safeRepo,
    env: { GEMINI_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
    fetchImpl: async () => new Response('quota exceeded', { status: 429 }),
    queryImpl: async function* (args) {
      claudeCalls.push(args);
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-x' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { verdict: 'ACCEPTED', reason: 'Matches risk and consequence.', nextStep: '' },
      };
    },
  });
  assert.equal(acceptRes.verdict, 'ACCEPTED');
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].options.maxTurns, 6);
  assert.ok(claudeCalls[0].options.mcpServers?.gateway);
  assert.match(claudeCalls[0].prompt, /READ-ONLY REPOSITORY TOOLS/);
});
