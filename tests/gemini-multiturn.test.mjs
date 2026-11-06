import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProviderAdapter, PROVIDER_KINDS, OUTCOME_KINDS, ERROR_KINDS, validateStructuredReview } from '../scripts/provider-adapter.mjs';
import { ReadOnlyToolGateway } from '../scripts/tool-gateway.mjs';

const [eq, deq, pj] = [assert.equal, assert.deepEqual, path.join];

function createTestFixture() {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(pj(os.tmpdir(), 'gemini-mt-test-')));
  const [s, c, o] = [pj(tmpDir, 'safe-target'), pj(tmpDir, '.review-context'), pj(tmpDir, 'outside')];
  const w = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };

  w(pj(s, 'index.js'), 'console.log("hello world");\nconst secret = "none";\n');
  w(pj(s, 'src/app.js'), 'export function run() { return 42; }\n// target_function_call\n');
  w(pj(s, 'src/util.js'), 'export const helper = true;\n');
  w(pj(c, 'pr.diff'), 'diff --git a/index.js b/index.js\n');
  w(pj(c, 'unauthorized-ctx.txt'), 'secret context\n');
  w(pj(o, 'secret.key'), 'ESCAPE_SECRET');

  w(pj(s, 'CLAUDE.md'), '# Control file');
  w(pj(s, '.git/HEAD'), 'ref: refs/heads/main');

  return {
    tmpDir,
    safeRoot: s,
    contextRoot: c,
    cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
  };
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          body: { type: 'string' },
          path: { type: 'string' },
          line: { type: ['integer', 'null'] },
          failurePath: { type: 'string' },
        },
        required: ['severity', 'title', 'body', 'path', 'line', 'failurePath'],
      },
    },
    coverage: {
      type: 'object',
      properties: {
        complete: { type: 'boolean' },
        reviewedPaths: { type: 'array', items: { type: 'string' } },
        unreviewedPaths: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['complete', 'reviewedPaths', 'unreviewedPaths', 'note'],
    },
  },
  required: ['summary', 'findings', 'coverage'],
};

test('E1: Single Read -> functionResponse -> Final Review', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;
    const recordedRequests = [];

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      recordedRequests.push(body);

      if (turn === 1) {
        // Model requests Read tool
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'src/app.js') },
                      id: 'call_read_1',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
          modelVersion: 'gemini-flash-latest',
        });
      }

      if (turn === 2) {
        // Model receives Read output, finishes exploration
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'I have examined the code and will now output the review.' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 },
          modelVersion: 'gemini-flash-latest',
        });
      }

      if (turn === 3) {
        // Structured review output phase
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Review of app.js complete',
                      findings: [],
                      coverage: {
                        complete: true,
                        reviewedPaths: ['src/app.js'],
                        unreviewedPaths: [],
                        note: 'Explored via Read tool',
                      },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 },
          modelVersion: 'gemini-flash-latest',
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review the changes',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.structured.summary, 'Review of app.js complete');
    eq(outcome.structured.coverage.complete, true);
    eq(outcome.meta.num_turns, 3);
    eq(outcome.meta.tool_calls, 1);
    eq(outcome.meta.usage.input_tokens, 450);
    eq(outcome.meta.usage.output_tokens, 100);

    // Verify turn 2 request sent the functionResponse
    const turn2Contents = recordedRequests[1].contents;
    eq(turn2Contents.length, 3); // turn 0: user, turn 1: model, turn 2: user (functionResponse)
    const fnResponsePart = turn2Contents[2].parts[0].functionResponse;
    eq(fnResponsePart.name, 'Read');
    eq(fnResponsePart.id, 'call_read_1');
    assert.match(fnResponsePart.response.output, /target_function_call/);

    // Verify turn 3 request had NO tools and requested APPLICATION_JSON schema
    eq(recordedRequests[2].tools, undefined);
    eq(recordedRequests[2].generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  } finally {
    f.cleanup();
  }
});

test('E2: Grep -> Read -> Final Review multi-turn sequence', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Grep',
                      args: { pattern: 'target_function_call' },
                      id: 'call_grep_1',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 15, totalTokenCount: 65 },
        });
      }

      if (turn === 2) {
        // Model saw Grep result and now calls Read
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'src/app.js') },
                      id: 'call_read_2',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, totalTokenCount: 140 },
        });
      }

      if (turn === 3) {
        // Model finishes tool turns
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Code exploration finished.' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 20, totalTokenCount: 220 },
        });
      }

      if (turn === 4) {
        // Structured review output
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Grep and Read found no issues',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: ['src/app.js'], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 40, totalTokenCount: 290 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review multi-turn',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.meta.num_turns, 4);
    eq(outcome.meta.tool_calls, 2);
    eq(outcome.meta.usage.input_tokens, 620);
    eq(outcome.meta.usage.output_tokens, 95);
  } finally {
    f.cleanup();
  }
});

test('E3: Multiple functionCalls in the same turn', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Glob',
                      args: { pattern: '*.js' },
                      id: 'call_glob_batch',
                    },
                  },
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'index.js') },
                      id: 'call_read_batch',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 30, totalTokenCount: 90 },
        });
      }

      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Batch inspection complete.' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 20, totalTokenCount: 170 },
        });
      }

      if (turn === 3) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Batch test passed',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: ['index.js'], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40, totalTokenCount: 240 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review with batch calls',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.meta.tool_calls, 2);

    // Verify turn 2 request had both function responses in a single user turn
    const lastUserTurn = turn2Contents[2];
    eq(lastUserTurn.role, 'user');
    eq(lastUserTurn.parts.length, 2);
    eq(lastUserTurn.parts[0].functionResponse.name, 'Glob');
    eq(lastUserTurn.parts[0].functionResponse.id, 'call_glob_batch');
    assert.match(lastUserTurn.parts[0].functionResponse.response.output, /index\.js/);
    eq(lastUserTurn.parts[1].functionResponse.name, 'Read');
    eq(lastUserTurn.parts[1].functionResponse.id, 'call_read_batch');
    assert.match(lastUserTurn.parts[1].functionResponse.response.output, /hello world/);
  } finally {
    f.cleanup();
  }
});

test('E4: thoughtSignature and functionCall.id preserved across turns', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    thought: true,
                    thoughtSignature: 'sig_abc_12345',
                    text: 'Thinking about whether to inspect index.js...',
                  },
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'index.js') },
                      id: 'call_unique_777',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40, thoughtsTokenCount: 30, totalTokenCount: 150 },
        });
      }

      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Thought signature preserved ok',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: ['index.js'], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 230 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Check thoughtSignature',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);

    // Verify model turn preserved thoughtSignature and id
    const modelTurn = turn2Contents[1];
    eq(modelTurn.role, 'model');
    eq(modelTurn.parts[0].thoughtSignature, 'sig_abc_12345');
    eq(modelTurn.parts[0].thought, true);
    eq(modelTurn.parts[1].functionCall.id, 'call_unique_777');

    // Verify user turn matched id
    const userTurn = turn2Contents[2];
    eq(userTurn.parts[0].functionResponse.id, 'call_unique_777');
  } finally {
    f.cleanup();
  }
});

test('E5: Unauthorized or unknown tool names are rejected Fail Closed', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'bash',
                      args: { command: 'rm -rf /' },
                      id: 'call_bash_illegal',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
        });
      }

      if (turn === 2) {
        turn2Contents = body.contents;
        // Model receives rejection and finishes
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'I understand bash is not available.' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 },
        });
      }

      if (turn === 3) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Unauthorized tool test passed',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test illegal tool',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    // Verify rejection was returned in functionResponse
    const fnResp = turn2Contents[2].parts[0].functionResponse;
    eq(fnResp.name, 'bash');
    assert.match(fnResp.response.error, /not available|not authorized/i);
  } finally {
    f.cleanup();
  }
});

test('E6: Path escape and sensitive control files rejected by Gateway', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'CLAUDE.md') },
                      id: 'call_escape_1',
                    },
                  },
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, '../outside/secret.key') },
                      id: 'call_escape_2',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }

      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Escape tests properly denied',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test escape paths',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    const responses = turn2Contents[2].parts;
    assert.match(responses[0].functionResponse.response.error, /control path is forbidden/i);
    assert.match(responses[1].functionResponse.response.error, /escapes authorized boundaries/i);
  } finally {
    f.cleanup();
  }
});

test('E7: maxTurns exhausted fails closed and does not claim complete', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;

    const mockFetch = async () => {
      turn += 1;
      // Model never stops calling Read
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'Read',
                    args: { file_path: pj(f.safeRoot, 'index.js') },
                    id: `call_${turn}`,
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Neverending tool calls',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
      maxTurns: 3,
    });

    eq(outcome.ok, false);
    eq(outcome.subtype, 'error_max_turns');
    assert.match(outcome.error, /turn limit of 3 turns/i);
    eq(outcome.meta.num_turns, 3);
  } finally {
    f.cleanup();
  }
});

test('E7b: maxToolCalls exhausted fails closed', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });

    const mockFetch = async () => {
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: '1' } },
                { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: '2' } },
                { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: '3' } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Too many tool calls',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
      maxToolCalls: 2,
    });

    eq(outcome.ok, false);
    eq(outcome.subtype, 'error_max_tool_calls');
    assert.match(outcome.error, /Tool invocation limit exceeded/i);
  } finally {
    f.cleanup();
  }
});

test('E8: Output truncation and cumulative byte quota enforcement', async () => {
  const f = createTestFixture();
  try {
    fs.writeFileSync(pj(f.safeRoot, 'huge.txt'), 'y'.repeat(600));
    const gw = new ReadOnlyToolGateway({
      safeRoot: f.safeRoot,
      cwd: f.tmpDir,
      maxCallReadBytes: 80,
      maxTotalReadBytes: 90,
    });

    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);

      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'huge.txt') },
                      id: 'call_huge',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, totalTokenCount: 45 },
        });
      }

      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: pj(f.safeRoot, 'huge.txt') },
                      id: 'call_huge_second',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 15, totalTokenCount: 65 },
        });
      }

      if (turn === 3) {
        const lastResp = body.contents[body.contents.length - 1].parts[0].functionResponse;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: `Observed quota behavior: ${lastResp.response.error || 'ok'}`,
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 30, totalTokenCount: 110 },
        });
      }

      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test quota limits',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    // First call was truncated within 80 bytes
    const firstOutput = turn2Contents[2].parts[0].functionResponse.response.output;
    assert.ok(Buffer.byteLength(firstOutput, 'utf8') <= 80);
    // Second call hit quota
    assert.match(outcome.structured.summary, /quota exceeded|budget too small/i);
  } finally {
    f.cleanup();
  }
});

test('E9: JSON Schema format invalid fails closed', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;

    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        return Response.json({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Exploration done.' }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
        });
      }
      // Return invalid structured JSON missing required 'summary' and invalid 'findings'
      return Response.json({
        candidates: [{ content: { role: 'model', parts: [{ text: '{"not_a_summary": 123}' }] } }],
        usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 15, totalTokenCount: 85 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test invalid schema',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.errorKind, ERROR_KINDS.MALFORMED);
    assert.match(outcome.error, /Missing required field: summary/i);
  } finally {
    f.cleanup();
  }
});

test('E10: Gemini 402/429 correctly returns UNAVAILABLE to trigger Claude fallback', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });

    const mockFetch = async () => {
      return new Response('Your credits are depleted', { status: 402, statusText: 'Payment Required' });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Check 402 error',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.kind, OUTCOME_KINDS.UNAVAILABLE);
    eq(outcome.errorKind, ERROR_KINDS.UNAVAILABLE);
    eq(outcome.status, 402);
  } finally {
    f.cleanup();
  }
});

test('E11: Multi-turn token usage accurately accumulated across turns', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;

    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'Glob', args: { pattern: '*.js' } } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 130 },
        });
      }
      if (turn === 2) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Exploration complete.' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 25, thoughtsTokenCount: 15, totalTokenCount: 190 },
        });
      }
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: JSON.stringify({
                    summary: 'Usage test complete',
                    findings: [],
                    coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 55, thoughtsTokenCount: 25, totalTokenCount: 280 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Accumulate usage',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.meta.num_turns, 3);
    eq(outcome.meta.usage.input_tokens, 100 + 150 + 200); // 450
    eq(outcome.meta.usage.output_tokens, 20 + 25 + 55); // 100
    eq(outcome.meta.usage.thoughts_tokens, 10 + 15 + 25); // 50
    eq(outcome.meta.usage.total_tokens, 130 + 190 + 280); // 600
  } finally {
    f.cleanup();
  }
});

test('Phase 2: Shared Host Gateway executes directly without MCP Server and protects concurrency', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({
      safeRoot: f.safeRoot,
      contextRoot: f.contextRoot,
      cwd: f.tmpDir,
      maxCalls: 2,
    });

    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: 'c1' } },
                  { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'src/app.js') }, id: 'c2' } },
                  { functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'src/util.js') }, id: 'c3' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }
      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Direct execution test ok',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test direct Host execution',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    // First two calls succeeded, third failed due to maxCalls
    const responses = turn2Contents[2].parts.map((p) => p.functionResponse);
    eq(responses.length, 3);
    assert.ok(responses[0].response.output, 'c1 should succeed');
    assert.ok(responses[1].response.output, 'c2 should succeed');
    assert.match(responses[2].response.error, /Tool invocation limit exceeded/i);
    eq(gw.getDiagnostics().callCount, 2);
  } finally {
    f.cleanup();
  }
});

test('Phase 2: Grep unsupported options throw explicit errors to Gemini', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'Grep', args: { pattern: 'test', '-A': 3 }, id: 'grep_opt_1' } },
                  { functionCall: { name: 'Grep', args: { pattern: 'test', output_mode: 'count' }, id: 'grep_opt_2' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }
      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Unsupported options rejected ok',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test grep options',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    const responses = turn2Contents[2].parts.map((p) => p.functionResponse);
    assert.match(responses[0].response.error, /Grep options not supported by Host Gateway: -A/i);
    assert.match(responses[1].response.error, /count or stats mode is forbidden/i);
  } finally {
    f.cleanup();
  }
});

test('Phase 2: Context file access restricted to allowedContextFiles whitelist', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({
      safeRoot: f.safeRoot,
      contextRoot: f.contextRoot,
      cwd: f.tmpDir,
      allowedContextFiles: ['pr.diff'],
    });

    let turn = 0;
    let turn2Contents = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'Read', args: { file_path: pj(f.contextRoot, 'pr.diff') }, id: 'allowed_ctx' } },
                  { functionCall: { name: 'Read', args: { file_path: pj(f.contextRoot, 'unauthorized-ctx.txt') }, id: 'unauthorized_ctx' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }
      if (turn === 2) {
        turn2Contents = body.contents;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Context whitelist tested',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test context file permissions',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    const responses = turn2Contents[2].parts.map((p) => p.functionResponse);
    assert.match(responses[0].response.output, /diff --git/);
    assert.match(responses[1].response.error, /unauthorized context file/i);
  } finally {
    f.cleanup();
  }
});

test('Phase 3: Context limit exceeded fails closed and preserves usage & diagnostics', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return Response.json({});
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const hugePrompt = 'x'.repeat(1_600_000); // Exceeds 1.5MB context cap
    const outcome = await adapter.execute({
      prompt: hugePrompt,
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(fetchCalled, false, 'Fetch must not be initiated when context limit is exceeded');
    assert.match(outcome.error, /context exceeds.*bytes/i);
    eq(outcome.meta.num_turns, 1);
    assert.ok(outcome.meta.tool_diagnostics !== null);
  } finally {
    f.cleanup();
  }
});

test('Phase 4: Two-stage separation and Host-side Schema validation', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    const recordedRequests = [];

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      recordedRequests.push(body);
      if (turn === 1) {
        // Stage A turn 1: tools provided, no responseFormat
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'No tools needed, but here is my thoughts' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
        });
      }
      if (turn === 2) {
        // Stage B turn 2: no tools, responseFormat provided
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Strict schema test',
                      findings: [
                        {
                          severity: 'P1',
                          title: 'Null pointer dereference',
                          body: 'Unchecked access in app.js',
                          path: 'src/app.js',
                          line: 2,
                          failurePath: 'Calling run() with null options causes TypeError',
                        },
                      ],
                      coverage: {
                        complete: true,
                        reviewedPaths: ['src/app.js'],
                        unreviewedPaths: [],
                        note: 'Verified with Host-side schema validator',
                      },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 40, totalTokenCount: 100 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test two-stage schema separation',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(recordedRequests.length, 2);

    // Verify Stage A request had tools and NO responseFormat
    assert.ok(recordedRequests[0].tools && recordedRequests[0].tools.length > 0);
    eq(recordedRequests[0].generationConfig.responseFormat, undefined);

    // Verify Stage B request had responseFormat and NO tools
    eq(recordedRequests[1].tools, undefined);
    assert.ok(recordedRequests[1].generationConfig.responseFormat);
    eq(recordedRequests[1].generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');

    // Test Host-side schema rejection of invalid severities
    const invalidSeverityReview = {
      summary: 'Bad',
      findings: [{ severity: 'INVALID', title: 'T', body: 'B', path: 'P', line: 1, failurePath: 'F' }],
      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
    };
    const res1 = validateStructuredReview(invalidSeverityReview, REVIEW_SCHEMA);
    eq(res1.ok, false);
    assert.match(res1.error, /Invalid finding severity/i);

    // Test Host-side schema rejection of missing failurePath
    const missingCoverageReview = {
      summary: 'Missing coverage',
      findings: [],
    };
    const res2 = validateStructuredReview(missingCoverageReview, REVIEW_SCHEMA);
    eq(res2.ok, false);
    assert.match(res2.error, /Missing required field: coverage/i);
  } finally {
    f.cleanup();
  }
});

test('E12: Shard Coverage, Session and Budget with Gemini tool loop without regressions', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, contextRoot: f.contextRoot, cwd: f.tmpDir });
    let turn = 0;

    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'src/app.js') }, id: 'c1' } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }
      if (turn === 2) {
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Done reading' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 15, totalTokenCount: 95 },
        });
      }
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: JSON.stringify({
                    summary: 'Partial coverage test',
                    findings: [
                      {
                        severity: 'P2',
                        title: 'Test issue',
                        body: 'Issue description',
                        path: 'src/app.js',
                        line: 1,
                        failurePath: 'Calling run() fails in edge case trigger',
                      },
                    ],
                    coverage: {
                      complete: false,
                      reviewedPaths: ['src/app.js'],
                      unreviewedPaths: ['src/util.js'],
                      note: 'Ran out of shard turns before reviewing util.js',
                    },
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 50, totalTokenCount: 170 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review shard files',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.structured.coverage.complete, false);
    deq(outcome.structured.coverage.reviewedPaths, ['src/app.js']);
    deq(outcome.structured.coverage.unreviewedPaths, ['src/util.js']);
    eq(outcome.meta.num_turns, 3);
    eq(outcome.meta.usage.total_tokens, 70 + 95 + 170);
    // Ensure Claude dollar cost is untouched (0 / null for Gemini)
    eq(outcome.meta.total_cost_usd, 0);
  } finally {
    f.cleanup();
  }
});

test('Regression F003: Empty parts candidate does not produce empty parts array or invalid history', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    let turn2Body = null;

    const mockFetch = async (_url, init) => {
      turn += 1;
      const body = JSON.parse(init.body);
      if (turn === 1) {
        // Model returns candidate with empty parts (e.g. SAFETY or empty turn)
        return Response.json({
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [] },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0, totalTokenCount: 50 },
        });
      }
      if (turn === 2) {
        turn2Body = body;
        return Response.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Clean review after empty turn',
                      findings: [],
                      coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Test empty parts resilience',
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(outcome.structured.summary, 'Clean review after empty turn');
    // Ensure no entry in turn 2 contents has empty parts
    for (const c of turn2Body.contents) {
      assert.ok(Array.isArray(c.parts) && c.parts.length > 0, 'Every content entry must have non-empty parts');
    }
  } finally {
    f.cleanup();
  }
});

test('Regression F004: Context limit classifies as unavailable for fallback and tool result is bounded', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);

    // Initial prompt exceeding context limit returns kind: failed (not unavailable) so Gemini is not switched off
    const hugePrompt = 'x'.repeat(1_600_000);
    const outcome = await adapter.execute({
      prompt: hugePrompt,
      schema: REVIEW_SCHEMA,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () => Response.json({}),
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.kind, OUTCOME_KINDS.UNAVAILABLE);
    assert.match(outcome.error, /context exceeds.*bytes/i);
  } finally {
    f.cleanup();
  }
});

test('F1: maxTurns=1 fails closed when tool call requested, preserving usage', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return Response.json({
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: 'c1' } }],
          },
        }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review index.js',
      schema: REVIEW_SCHEMA,
      maxTurns: 1,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.subtype, 'error_max_turns');
    eq(fetchCount, 1, 'Only 1 request must be made when maxTurns=1');
    eq(outcome.meta.num_turns, 1);
    eq(outcome.meta.max_turns, 1);
    eq(outcome.meta.usage.total_tokens, 120);
  } finally {
    f.cleanup();
  }
});

test('F1: maxTurns=1 fails closed when Stage A returns non-structured text and Stage B is blocked', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return Response.json({
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: 'I examined the code but this is not JSON.' }],
          },
        }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 15, totalTokenCount: 95 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review index.js',
      schema: REVIEW_SCHEMA,
      maxTurns: 1,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.subtype, 'error_max_turns');
    assert.match(outcome.error, /exceeded total turn limit of 1 turns/i);
    eq(fetchCount, 1, 'Stage B must NOT be called when maxTurns=1 is exhausted');
    eq(outcome.meta.num_turns, 1);
    eq(outcome.meta.usage.total_tokens, 95);
  } finally {
    f.cleanup();
  }
});

test('F1: maxTurns=1 succeeds when model produces valid structured review directly on turn 1', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount += 1;
      return Response.json({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              text: JSON.stringify({
                summary: 'Single turn ok',
                findings: [],
                coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
              }),
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25, totalTokenCount: 75 },
      });
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review index.js',
      schema: REVIEW_SCHEMA,
      maxTurns: 1,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(fetchCount, 1);
    eq(outcome.meta.num_turns, 1);
    eq(outcome.meta.usage.total_tokens, 75);
    eq(outcome.structured.summary, 'Single turn ok');
  } finally {
    f.cleanup();
  }
});

test('F1: maxTurns=2 fails closed when Stage A uses 2 turns and Stage B is blocked from extra turn', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'Read', args: { file_path: pj(f.safeRoot, 'index.js') }, id: 'c1' } }],
            },
          }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
        });
      }
      if (turn === 2) {
        // Model receives tool output and returns conversational non-JSON text
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'I finished reading index.js. Ready to review.' }],
            },
          }],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 },
        });
      }
      throw new Error(`Turn ${turn} should never be reached under maxTurns=2`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review index.js',
      schema: REVIEW_SCHEMA,
      maxTurns: 2,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, false);
    eq(outcome.subtype, 'error_max_turns');
    assert.match(outcome.error, /exceeded total turn limit of 2 turns/i);
    eq(turn, 2, 'Total API requests must be capped at maxTurns=2');
    eq(outcome.meta.num_turns, 2);
    eq(outcome.meta.max_turns, 2);
    eq(outcome.meta.usage.total_tokens, 120 + 180);
  } finally {
    f.cleanup();
  }
});

test('F1: maxTurns=2 succeeds when Stage A takes 1 turn and Stage B takes turn 2', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        // Model returns non-structured text on turn 1
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'No tools needed, exploring in mind.' }],
            },
          }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
        });
      }
      if (turn === 2) {
        // Stage B returns structured review on turn 2
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                text: JSON.stringify({
                  summary: 'Turn 2 structured ok',
                  findings: [],
                  coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                }),
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 30, totalTokenCount: 100 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review index.js',
      schema: REVIEW_SCHEMA,
      maxTurns: 2,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(turn, 2);
    eq(outcome.meta.num_turns, 2);
    eq(outcome.meta.max_turns, 2);
    eq(outcome.meta.usage.total_tokens, 60 + 100);
    eq(outcome.structured.summary, 'Turn 2 structured ok');
  } finally {
    f.cleanup();
  }
});

test('F2: validateStructuredReview strictly enforces nested required fields', () => {
  // Missing line in finding
  const missingLine = {
    summary: 'Test',
    findings: [{ severity: 'P1', title: 'T', body: 'B', path: 'src/app.js', failurePath: 'fp' }],
    coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
  };
  const resLine = validateStructuredReview(missingLine, REVIEW_SCHEMA);
  eq(resLine.ok, false);
  assert.match(resLine.error, /finding missing required field: line/i);

  // Missing failurePath in finding
  const missingFailurePath = {
    summary: 'Test',
    findings: [{ severity: 'P1', title: 'T', body: 'B', path: 'src/app.js', line: 10 }],
    coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
  };
  const resFp = validateStructuredReview(missingFailurePath, REVIEW_SCHEMA);
  eq(resFp.ok, false);
  assert.match(resFp.error, /finding missing required field: failurePath/i);

  // Invalid line (string or negative)
  const invalidLine = {
    summary: 'Test',
    findings: [{ severity: 'P1', title: 'T', body: 'B', path: 'src/app.js', line: '10', failurePath: 'fp' }],
    coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
  };
  const resInvLine = validateStructuredReview(invalidLine, REVIEW_SCHEMA);
  eq(resInvLine.ok, false);
  assert.match(resInvLine.error, /finding line must be a positive integer or null/i);

  // Missing coverage subfield note
  const missingNote = {
    summary: 'Test',
    findings: [],
    coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [] },
  };
  const resNote = validateStructuredReview(missingNote, REVIEW_SCHEMA);
  eq(resNote.ok, false);
  assert.match(resNote.error, /coverage missing required field: note/i);

  // Missing coverage subfield complete
  const missingComplete = {
    summary: 'Test',
    findings: [],
    coverage: { reviewedPaths: [], unreviewedPaths: [], note: '' },
  };
  const resComplete = validateStructuredReview(missingComplete, REVIEW_SCHEMA);
  eq(resComplete.ok, false);
  assert.match(resComplete.error, /coverage missing required field: complete/i);

  // Valid review passes
  const valid = {
    summary: 'Test',
    findings: [{ severity: 'P2', title: 'T', body: 'B', path: 'src/app.js', line: null, failurePath: 'fp' }],
    coverage: { complete: true, reviewedPaths: ['src/app.js'], unreviewedPaths: [], note: 'all done' },
  };
  const resValid = validateStructuredReview(valid, REVIEW_SCHEMA);
  eq(resValid.ok, true);
});

test('F2: Stage A shallow JSON missing required fields cannot bypass Stage B', async () => {
  const f = createTestFixture();
  try {
    const gw = new ReadOnlyToolGateway({ safeRoot: f.safeRoot, cwd: f.tmpDir });
    let turn = 0;
    const mockFetch = async () => {
      turn += 1;
      if (turn === 1) {
        // Stage A returns JSON missing line and failurePath
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                text: JSON.stringify({
                  summary: 'Shallow json attempt',
                  findings: [{ severity: 'P1', title: 'T', body: 'B', path: 'x.js' }], // missing line & failurePath
                  coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                }),
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        });
      }
      if (turn === 2) {
        // Stage B is called and produces fully valid review
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                text: JSON.stringify({
                  summary: 'Strict Stage B output',
                  findings: [{ severity: 'P1', title: 'T', body: 'B', path: 'x.js', line: 5, failurePath: 'Valid failure path' }],
                  coverage: { complete: true, reviewedPaths: [], unreviewedPaths: [], note: '' },
                }),
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 30, totalTokenCount: 110 },
        });
      }
      throw new Error(`Unexpected turn ${turn}`);
    };

    const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI);
    const outcome = await adapter.execute({
      prompt: 'Review code',
      schema: REVIEW_SCHEMA,
      maxTurns: 3,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: mockFetch,
      toolGateway: gw,
    });

    eq(outcome.ok, true);
    eq(turn, 2, 'Stage B must be invoked because Stage A output lacked required fields');
    eq(outcome.structured.summary, 'Strict Stage B output');
    eq(outcome.structured.findings[0].line, 5);
  } finally {
    f.cleanup();
  }
});
