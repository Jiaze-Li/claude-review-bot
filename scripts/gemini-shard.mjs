// Gemini as a provider for one review shard: same prompt contract, schema and result shape as
// the Claude shard runner in run-review.mjs, so the two can be mixed within one review.
// Gemini has no tools here, so the shard's diff is sent inline.

import { isGeminiUnavailableStatus } from './claude-fallback.mjs';
import { geminiBaseUrl } from './gemini-config.mjs';
import { GEMINI_MODEL, toGeminiJsonSchema } from './run-gemini-review.mjs';

export const GEMINI_SHARD_THINKING = 'medium';
export const GEMINI_SHARD_TIMEOUT_MS = 480_000;
// A single huge file can make a shard far bigger than the usual ~100 KB; leave those to Claude.
export const GEMINI_SHARD_MAX_BYTES = 600_000;
export { geminiBaseUrl };

// kind: 'ok' | 'unavailable' (402/429/5xx: stop using Gemini) | 'config' (400/401/403/404: the key or
// model is wrong, stop using Gemini) | 'failed' (timeout, network, malformed output: this shard only).
export async function runGeminiShard({ prompt, schema, env = process.env, fetchImpl = fetch, timeoutMs = GEMINI_SHARD_TIMEOUT_MS }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { kind: 'config', error: 'GEMINI_API_KEY is not set' };
  const model = env.GEMINI_MODEL || GEMINI_MODEL;
  const requestBody = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: GEMINI_SHARD_THINKING },
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: toGeminiJsonSchema(schema) } },
      maxOutputTokens: 16384,
    },
  });
  const usage = { input_tokens: 0, output_tokens: 0 };
  let servedModel = null;
  let lastError = 'no structured output';
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let payload;
    try {
      const response = await fetchImpl(`${geminiBaseUrl(env)}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        const error = `Gemini HTTP ${response.status}: ${body}`;
        if (isGeminiUnavailableStatus(response.status)) return { kind: 'unavailable', status: response.status, error };
        if ([400, 401, 403, 404].includes(response.status)) return { kind: 'config', status: response.status, error };
        return { kind: 'failed', status: response.status, error };
      }
      payload = await response.json();
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      return { kind: 'failed', error: timedOut ? `Gemini request timed out after ${timeoutMs}ms` : `Gemini request failed: ${error?.message ?? error}` };
    }
    if (typeof payload.modelVersion === 'string' && payload.modelVersion) servedModel = payload.modelVersion;
    const input = payload.usageMetadata?.promptTokenCount;
    const output = payload.usageMetadata?.candidatesTokenCount;
    if (Number.isFinite(input)) usage.input_tokens += input;
    if (Number.isFinite(output)) usage.output_tokens += output;
    const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
    try {
      if (!text) throw new Error('returned no structured text');
      const structured = JSON.parse(text);
      return {
        kind: 'ok',
        structured,
        meta: {
          provider: 'gemini',
          requested_model: model,
          resolved_model: servedModel || model,
          effort: GEMINI_SHARD_THINKING,
          num_turns: 1,
          max_turns: 1,
          duration_ms: Date.now() - startedAt,
          duration_api_ms: Date.now() - startedAt,
          // Gemini is billed to the API key, not to the Claude ledger.
          total_cost_usd: 0,
          usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          model_usage: {},
        },
      };
    } catch (error) {
      lastError = `Gemini returned malformed structured output: ${error.message}`;
    }
  }
  return { kind: 'failed', error: lastError };
}
