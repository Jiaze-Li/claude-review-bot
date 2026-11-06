// Claude fallback for the Gemini bounded review path.
// Used only when Gemini is out of credits/quota or the service is down; the
// caller keeps the same prompt, schema and output shape so nothing downstream changes.

import { getProviderAdapter, PROVIDER_KINDS, ERROR_KINDS } from './provider-adapter.mjs';

// Charged when the SDK reports no cost, so unknown never means free.
export const FALLBACK_UNKNOWN_COST_USD = 0.5;
export const CLAUDE_FALLBACK_MODEL = 'sonnet';
export const CLAUDE_FALLBACK_EFFORT = 'medium';
const CLAUDE_FALLBACK_MAX_TURNS = 3;

export class GeminiUnavailableError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiUnavailableError';
    this.status = status;
  }
}

// 402 = credits depleted, 429 = rate/quota limit, 5xx = provider outage.
// Timeouts and malformed output are deliberately not fallback triggers.
export function isGeminiUnavailableStatus(status) {
  return status === 402 || status === 429 || (status >= 500 && status <= 599);
}

export async function runClaudeStructured({
  prompt,
  schema,
  timeoutMs,
  maxBudgetUsd,
  env = process.env,
  queryImpl = null,
  logImpl = console.log,
}) {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('Claude fallback unavailable: CLAUDE_CODE_OAUTH_TOKEN is not set');
  }
  const adapter = getProviderAdapter(PROVIDER_KINDS.CLAUDE, {
    defaultModel: CLAUDE_FALLBACK_MODEL,
    defaultEffort: CLAUDE_FALLBACK_EFFORT,
  });
  const outcome = await adapter.execute({
    prompt,
    schema,
    timeoutMs,
    maxBudgetUsd,
    env,
    queryImpl,
    logImpl,
    model: CLAUDE_FALLBACK_MODEL,
    effort: CLAUDE_FALLBACK_EFFORT,
    maxTurns: CLAUDE_FALLBACK_MAX_TURNS,
    allowZeroCost: false,
    fallbackUnknownCostUsd: FALLBACK_UNKNOWN_COST_USD,
    isolateEnv: true,
    requireAuthToken: true,
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available in fallback review.' }),
  });

  if (!outcome.ok) {
    if (outcome.errorKind === ERROR_KINDS.TIMEOUT) {
      throw new Error(`Claude fallback timed out after ${timeoutMs}ms`);
    }
    if (outcome.error === 'Claude produced no result') {
      throw new Error('Claude fallback produced no result');
    }
    if (outcome.error === 'Claude completed without structured output') {
      throw new Error('Claude fallback completed without structured output');
    }
    if (outcome.subtype && outcome.subtype !== 'success') {
      throw new Error(`Claude fallback failed with result subtype: ${outcome.subtype}`);
    }
    throw new Error(`Claude fallback failed: ${outcome.error}`);
  }

  logImpl(`Claude fallback complete: model=${outcome.meta.resolved_model || CLAUDE_FALLBACK_MODEL} effort=${CLAUDE_FALLBACK_EFFORT}`);
  return {
    structured: outcome.structured,
    meta: {
      provider: 'claude',
      requested_model: CLAUDE_FALLBACK_MODEL,
      resolved_model: outcome.meta.resolved_model || CLAUDE_FALLBACK_MODEL,
      effort: CLAUDE_FALLBACK_EFFORT,
      total_cost_usd: outcome.meta.total_cost_usd,
      cost_source: outcome.meta.cost_source,
      usage: {
        input_tokens: outcome.meta.usage.input_tokens,
        output_tokens: outcome.meta.usage.output_tokens,
        thoughts_tokens: null,
        total_tokens: null,
      },
    },
  };
}
