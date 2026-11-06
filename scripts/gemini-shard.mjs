// Gemini as a provider for one review shard: same prompt contract, schema and result shape as
// the Claude shard runner in run-review.mjs, so the two can be mixed within one review.
// Gemini has no tools here, so the shard's diff is sent inline.

import { isGeminiUnavailableStatus } from './claude-fallback.mjs';
import { geminiBaseUrl } from './gemini-config.mjs';
import { GEMINI_MODEL, toGeminiJsonSchema } from './run-gemini-review.mjs';
import { getProviderAdapter, PROVIDER_KINDS } from './provider-adapter.mjs';

export const GEMINI_SHARD_THINKING = 'medium';
export const GEMINI_SHARD_TIMEOUT_MS = 480_000;
// A single huge file can make a shard far bigger than the usual ~100 KB; leave those to Claude.
export const GEMINI_SHARD_MAX_BYTES = 600_000;
export { geminiBaseUrl };

// kind: 'ok' | 'unavailable' (402/429/5xx: stop using Gemini) | 'config' (400/401/403/404: the key or
// model is wrong, stop using Gemini) | 'failed' (timeout, network, malformed output: this shard only).
export async function runGeminiShard({
  prompt,
  schema,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = GEMINI_SHARD_TIMEOUT_MS,
  toolGateway = null,
  maxTurns = 10,
  maxToolCalls = 40,
}) {
  const model = env?.GEMINI_MODEL || GEMINI_MODEL;
  const adapter = getProviderAdapter(PROVIDER_KINDS.GEMINI, { defaultModel: model, defaultEffort: GEMINI_SHARD_THINKING });
  const outcome = await adapter.execute({
    prompt,
    schema,
    model,
    env,
    fetchImpl,
    timeoutMs,
    effort: GEMINI_SHARD_THINKING,
    toolGateway,
    maxTurns,
    maxToolCalls,
  });
  if (outcome.ok) {
    return {
      kind: 'ok',
      structured: outcome.structured,
      meta: outcome.meta,
    };
  }
  return {
    kind: outcome.kind,
    ...(outcome.status ? { status: outcome.status } : {}),
    error: outcome.error,
  };
}
