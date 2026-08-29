#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.GPTWB_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const token = process.env.GPTWB_TOKEN || '';
const rounds = Number(process.env.GPTWB_SPIKE_ROUNDS || 18);
const timeoutMs = Number(process.env.GPTWB_SPIKE_TIMEOUT_MS || 360000);

if (!Number.isInteger(rounds) || rounds < 6) {
  throw new Error('GPTWB_SPIKE_ROUNDS must be an integer >= 6');
}

const runId = randomUUID().slice(0, 8);
const sessions = [
  { id: `spike-${runId}-a`, secret: `ALPHA-${randomUUID().slice(0, 8)}` },
  { id: `spike-${runId}-b`, secret: `BRAVO-${randomUUID().slice(0, 8)}` },
  { id: `spike-${runId}-c`, secret: `CHARLIE-${randomUUID().slice(0, 8)}` },
];

const stats = { total: 0, passed: 0, failed: 0, failures: [] };

function headers() {
  const out = { 'content-type': 'application/json' };
  if (token) out.authorization = `Bearer ${token}`;
  return out;
}

async function call(sessionId, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        model: 'chatgpt-web',
        session_id: sessionId,
        messages: [{ role: 'user', content }],
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    let envelope;
    try { envelope = JSON.parse(text); }
    catch { throw new Error(`non-JSON API envelope: ${text.slice(0, 500)}`); }
    const answer = envelope?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error(`missing choices[0].message.content: ${text.slice(0, 500)}`);
    }
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

function parseStrictJson(text) {
  try { return JSON.parse(text); }
  catch {
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) return JSON.parse(fenced[1]);
    throw new Error(`assistant did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function check(label, fn) {
  stats.total += 1;
  const started = Date.now();
  try {
    await fn();
    stats.passed += 1;
    console.log(`PASS ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    stats.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    stats.failures.push({ label, message });
    console.error(`FAIL ${label}: ${message}`);
  }
}

console.log(`GPT web fixer spike ${runId}`);
console.log(`Endpoint: ${baseUrl}`);
console.log(`Sessions: ${sessions.map((s) => s.id).join(', ')}`);
console.log('Do not interact with the ChatGPT browser window while this test runs.');

for (const session of sessions) {
  await check(`init ${session.id}`, async () => {
    const nonce = randomUUID().slice(0, 10);
    const answer = await call(session.id, [
      'You are participating in an automation reliability test.',
      `For this conversation only, remember this exact secret: ${session.secret}`,
      'Treat all future test messages in this conversation independently from other conversations.',
      'Return ONLY valid JSON, with no prose and no markdown.',
      `Return exactly these fields: {"ok":true,"nonce":"${nonce}","secret":"${session.secret}"}`,
    ].join('\n'));
    const obj = parseStrictJson(answer);
    if (obj?.ok !== true || obj?.nonce !== nonce || obj?.secret !== session.secret) {
      throw new Error(`wrong init payload: ${answer.slice(0, 500)}`);
    }
  });
}

for (let i = 0; i < rounds; i += 1) {
  const session = sessions[i % sessions.length];
  const nonce = `${i + 1}-${randomUUID().slice(0, 10)}`;
  await check(`round ${String(i + 1).padStart(2, '0')} ${session.id}`, async () => {
    const answer = await call(session.id, [
      'Automation reliability probe.',
      'Do not infer or copy a secret from this message; recall the secret stored earlier in THIS conversation.',
      'Return ONLY valid JSON, with no prose and no markdown.',
      `Return exactly these fields: {"ok":true,"nonce":"${nonce}","secret":"<the secret stored earlier in this conversation>"}`,
    ].join('\n'));
    const obj = parseStrictJson(answer);
    if (obj?.ok !== true) throw new Error(`ok was not true: ${answer.slice(0, 500)}`);
    if (obj?.nonce !== nonce) throw new Error(`reply-capture mismatch: expected nonce ${nonce}, got ${obj?.nonce}`);
    if (obj?.secret !== session.secret) {
      const owner = sessions.find((s) => s.secret === obj?.secret)?.id;
      if (owner) throw new Error(`SESSION CROSSOVER: expected ${session.secret}, got secret from ${owner}`);
      throw new Error(`memory mismatch: expected ${session.secret}, got ${obj?.secret}`);
    }
  });
}

const successRate = stats.total ? stats.passed / stats.total : 0;
console.log('\n=== RESULT ===');
console.log(JSON.stringify({ ...stats, successRate }, null, 2));

// Stage-1 gate: no ambiguity/crossover failures tolerated; >= 95% overall.
const dangerous = stats.failures.some(({ message }) => /CROSSOVER|reply-capture mismatch/i.test(message));
if (dangerous || successRate < 0.95) {
  console.error('\nVERDICT: FAIL — do not use gpt-web-bridge as an unattended fixer yet.');
  process.exit(1);
}

console.log('\nVERDICT: PASS — proceed to restart/recovery and long-context Stage 2.');
