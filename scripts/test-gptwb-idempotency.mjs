#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.GPTWB_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const token = process.env.GPTWB_TOKEN || '';
const statePath = process.env.GPTWB_IDEMPOTENCY_STATE || '/tmp/gptwb-idempotency-state.json';
const mode = process.argv[2] || 'prepare';

function headers(extra = {}) {
  const out = { 'content-type': 'application/json', ...extra };
  if (token) out.authorization = `Bearer ${token}`;
  return out;
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: headers() });
  const text = await response.text();
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error(`non-JSON GET ${pathname}: ${text.slice(0, 500)}`); }
  return { response, obj, text };
}

async function post(body) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error(`non-JSON POST: ${text.slice(0, 500)}`); }
  return { response, obj, text, elapsedMs: Date.now() - started };
}

function completionContent(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing completion content');
  return text.trim();
}

function parseAssistantJson(payload) {
  const text = completionContent(payload);
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) return JSON.parse(m[1]);
    throw new Error(`assistant reply was not JSON: ${text.slice(0, 500)}`);
  }
}

async function sessionTurns(sessionId) {
  const { response, obj, text } = await getJson('/v1/sessions');
  if (!response.ok) throw new Error(`sessions HTTP ${response.status}: ${text.slice(0, 500)}`);
  const row = obj?.data?.find((x) => x.id === sessionId);
  return row ? Number(row.turns) : null;
}

function fireAndDisconnect(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/v1/chat/completions`);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { ...headers(), 'content-length': data.length },
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.on('response', (res) => {
      res.resume();
      done();
    });
    req.on('error', (error) => {
      if (settled || ['ECONNRESET', 'ECONNABORTED'].includes(error?.code)) return done();
      reject(error);
    });
    req.on('finish', () => {
      setTimeout(() => {
        req.destroy();
        done();
      }, 300);
    });
    req.end(data);
  });
}

async function waitForOperation(operationId, timeoutMs = 360000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { response, obj, text } = await getJson(`/v1/operations/${encodeURIComponent(operationId)}`);
    if (response.status === 404) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (!response.ok) throw new Error(`operation GET HTTP ${response.status}: ${text.slice(0, 500)}`);
    if (obj.status === 'completed' || obj.status === 'ambiguous') return obj;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('timed out waiting for operation result');
}

function assertAssistant(payload, nonce) {
  const obj = parseAssistantJson(payload);
  if (obj?.ok !== true || obj?.nonce !== nonce || obj?.status !== 'processed') {
    throw new Error(`wrong assistant payload: ${completionContent(payload).slice(0, 500)}`);
  }
}

async function prepare() {
  const sessionId = `idem-${randomUUID().slice(0, 8)}`;
  const operationId = `op-${randomUUID().slice(0, 12)}`;
  const nonce = randomUUID().slice(0, 12);
  const prompt = [
    'Ambiguous-delivery reliability probe.',
    `Operation id: ${operationId}`,
    'Return ONLY valid JSON, no markdown.',
    `Return exactly: {"ok":true,"nonce":"${nonce}","status":"processed"}`,
  ].join('\n');
  const body = {
    model: 'chatgpt-web',
    session: sessionId,
    operation_id: operationId,
    messages: [{ role: 'user', content: prompt }],
  };

  console.log(`Session: ${sessionId}`);
  console.log(`Operation: ${operationId}`);
  console.log('Forcing client disconnect after request upload...');
  await fireAndDisconnect(body);

  const op = await waitForOperation(operationId);
  if (op.status !== 'completed') throw new Error(`operation became ${op.status}: ${op.error || ''}`);
  assertAssistant(op.result, nonce);
  console.log('PASS disconnected client recovered completed result');

  const turns1 = await sessionTurns(sessionId);
  if (turns1 !== 1) throw new Error(`expected one GPT turn after ambiguous delivery, got ${turns1}`);

  const retry = await post(body);
  if (!retry.response.ok) throw new Error(`cached retry HTTP ${retry.response.status}: ${retry.text.slice(0, 500)}`);
  assertAssistant(retry.obj, nonce);
  if (retry.elapsedMs > 3000) throw new Error(`same operation_id did not look cached (${retry.elapsedMs}ms)`);
  const turns2 = await sessionTurns(sessionId);
  if (turns2 !== turns1) throw new Error(`duplicate operation was sent to GPT again: turns ${turns1} -> ${turns2}`);
  console.log(`PASS duplicate POST returned cached result (${retry.elapsedMs}ms, turns stayed ${turns2})`);

  const conflictBody = structuredClone(body);
  conflictBody.messages = [{ role: 'user', content: prompt + '\nDIFFERENT REQUEST' }];
  const conflict = await post(conflictBody);
  if (conflict.response.status !== 409) throw new Error(`expected 409 for reused operation_id with different request, got ${conflict.response.status}`);
  const turns3 = await sessionTurns(sessionId);
  if (turns3 !== turns2) throw new Error(`conflicting operation_id reached GPT: turns ${turns2} -> ${turns3}`);
  console.log('PASS operation_id reuse with different request rejected');

  fs.writeFileSync(statePath, JSON.stringify({ sessionId, operationId, nonce, body, turns: turns3 }, null, 2), { mode: 0o600 });
  console.log(`STATE ${statePath}`);
  console.log('PHASE A PASS');
  console.log('Restart gptwb serve, then run this script with `resume`.');
}

async function resume() {
  if (!fs.existsSync(statePath)) throw new Error(`state not found: ${statePath}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const { response, obj, text } = await getJson(`/v1/operations/${encodeURIComponent(state.operationId)}`);
  if (!response.ok) throw new Error(`operation missing after restart: HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (obj.status !== 'completed') throw new Error(`operation status after restart is ${obj.status}`);
  assertAssistant(obj.result, state.nonce);
  console.log('PASS completed operation result survived bridge restart');

  const turnsBefore = await sessionTurns(state.sessionId);
  if (turnsBefore !== state.turns) throw new Error(`session turn count changed across restart: ${state.turns} -> ${turnsBefore}`);
  const retry = await post(state.body);
  if (!retry.response.ok) throw new Error(`post-restart cached retry HTTP ${retry.response.status}: ${retry.text.slice(0, 500)}`);
  assertAssistant(retry.obj, state.nonce);
  const turnsAfter = await sessionTurns(state.sessionId);
  if (turnsAfter !== turnsBefore) throw new Error(`post-restart duplicate reached GPT: turns ${turnsBefore} -> ${turnsAfter}`);
  console.log(`PASS post-restart duplicate stayed cached (turns=${turnsAfter})`);

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    disconnectedResultRecovery: 'PASS',
    duplicateSuppression: 'PASS',
    operationConflictProtection: 'PASS',
    restartPersistence: 'PASS',
    browserRouteViable: true,
    unattendedFixerTransportReady: true,
  }, null, 2));
  console.log('\nVERDICT: PASS — gpt-web-bridge transport is ready for the autonomous Fixer controller spike.');
}

try {
  if (mode === 'prepare') await prepare();
  else if (mode === 'resume') await resume();
  else throw new Error('usage: node test-gptwb-idempotency.mjs [prepare|resume]');
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
