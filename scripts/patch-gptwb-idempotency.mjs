#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXPECTED_HEAD = 'c09fff8104bc242af5e2dcc12bd48814eb587e8c';
const repoDir = path.resolve(process.argv[2] || path.join(os.homedir(), 'gpt-web-bridge'));
const filePath = path.join(repoDir, 'gptwb.js');
const backupPath = path.join(repoDir, 'gptwb.js.before-idempotency');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

if (!fs.existsSync(filePath)) fail(`not found: ${filePath}`);
const head = git('rev-parse', 'HEAD');
if (head !== EXPECTED_HEAD) {
  fail(`expected gpt-web-bridge ${EXPECTED_HEAD}, found ${head}. Refusing a blind patch; re-audit the new revision first.`);
}
const dirty = git('status', '--porcelain', '--', 'gptwb.js');
if (dirty) fail('gptwb.js already has local changes. Refusing to overwrite them.');

let source = fs.readFileSync(filePath, 'utf8');

function replaceOnce(label, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0) fail(`patch anchor not found: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) fail(`patch anchor is not unique: ${label}`);
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

replaceOnce(
  'crypto import',
  "const path = require('path');\nconst readline = require('readline');",
  "const path = require('path');\nconst crypto = require('crypto');\nconst readline = require('readline');",
);

replaceOnce(
  'API comment',
  ' * continue, "new_session": true to force fresh), GET /v1/sessions,\n * DELETE /v1/sessions/<id>.',
  ' * continue, "new_session": true to force fresh; optional X-Operation-Id or\n * body "operation_id" makes non-stream requests idempotent), GET /v1/sessions,\n * GET /v1/operations/<id>, DELETE /v1/sessions/<id>.',
);

const opsStore = String.raw`
// --- durable operation store for unattended callers ---
// A caller-supplied operation id makes a non-stream request exactly-once from
// the bridge's point of view: completed results are cached, in-flight duplicate
// submissions are never sent twice, and a process restart converts any leftover
// pending operation to "ambiguous" rather than guessing whether ChatGPT saw it.
const OPS_PATH = path.join(path.dirname(PROFILE_DIR), 'operations.json');
let operations = {};
try { operations = JSON.parse(fs.readFileSync(OPS_PATH, 'utf8')); } catch { operations = {}; }
if (!operations || typeof operations !== 'object' || Array.isArray(operations)) operations = {};

function saveOperations() {
  fs.mkdirSync(path.dirname(OPS_PATH), { recursive: true });
  const tmp = OPS_PATH + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(operations, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, OPS_PATH);
}

let recoveredPending = 0;
for (const op of Object.values(operations)) {
  if (!op || typeof op !== 'object') continue;
  if (op.status === 'pending') {
    op.status = 'ambiguous';
    op.updatedAt = new Date().toISOString();
    op.error = 'bridge restarted while operation was pending; request will not be retried automatically';
    recoveredPending += 1;
  }
}
if (recoveredPending) saveOperations();

function operationFingerprint(sid, body, messages) {
  const normalized = {
    session: sid,
    new_session: Boolean(body.new_session),
    model: String(body.model || ''),
    messages: messages.map((m) => ({ role: String((m && m.role) || ''), content: contentText(m) })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function operationView(id, op) {
  const out = {
    operation_id: id,
    status: op.status,
    session_id: op.sessionId || '',
    created_at: op.createdAt || '',
    updated_at: op.updatedAt || '',
  };
  if (op.status === 'completed') out.result = op.result;
  if (op.error) out.error = op.error;
  return out;
}
`;

replaceOnce(
  'operation store insertion',
  '\n// status line sink: the chat REPL overrides this so async browser-work messages',
  `${opsStore}\n// status line sink: the chat REPL overrides this so async browser-work messages`,
);

const operationGet = String.raw`
    const om = url.match(/^\/v1\/operations\/([A-Za-z0-9._:-]{1,200})$/);
    if (om && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: { message: 'bad token' } });
      const op = operations[om[1]];
      if (!op) return json(res, 404, { error: { message: 'no such operation' } });
      return json(res, 200, operationView(om[1], op));
    }

`;
replaceOnce(
  'operation GET endpoint',
  "    if (url === '/v1/chat/completions' && req.method === 'POST') {",
  `${operationGet}    if (url === '/v1/chat/completions' && req.method === 'POST') {`,
);

const opRequest = String.raw`      const sid = String(req.headers['x-session-id'] || body.session || '').trim();
      const operationId = String(req.headers['x-operation-id'] || body.operation_id || '').trim();
      if (operationId && !/^[A-Za-z0-9._:-]{1,200}$/.test(operationId)) {
        return json(res, 400, { error: { message: 'operation_id must match [A-Za-z0-9._:-]{1,200}' } });
      }
      if (operationId && body.stream) {
        return json(res, 400, { error: { message: 'operation_id is supported only for non-stream requests' } });
      }
      const operationHash = operationId ? operationFingerprint(sid, body, messages) : '';
      if (operationId && operations[operationId]) {
        const prior = operations[operationId];
        if (prior.requestHash !== operationHash) {
          return json(res, 409, { error: { message: 'operation_id was already used for a different request' }, operation: operationView(operationId, prior) });
        }
        if (prior.status === 'completed') {
          return json(res, 200, prior.result, { 'X-Session-Id': prior.sessionId || sid, 'X-Operation-Id': operationId });
        }
        if (prior.status === 'pending') {
          return json(res, 202, operationView(operationId, prior), { 'X-Operation-Id': operationId });
        }
        return json(res, 409, { error: { message: 'operation result is ambiguous; inspect it instead of retrying blindly' }, operation: operationView(operationId, prior) }, { 'X-Operation-Id': operationId });
      }

      // resolve session: continue known, else fresh`;
replaceOnce(
  'operation request handling',
  "      const sid = String(req.headers['x-session-id'] || body.session || '').trim();\n\n      // resolve session: continue known, else fresh",
  opRequest,
);

const beforeTry = String.raw`      if (!prompt.trim()) return json(res, 400, { error: { message: 'empty messages' } });

      if (operationId) {
        const now = new Date().toISOString();
        operations[operationId] = {
          status: 'pending',
          requestHash: operationHash,
          sessionId: sess.id,
          createdAt: now,
          updatedAt: now,
        };
        saveOperations();
      }

      try {`;
replaceOnce(
  'persist pending before send',
  "      if (!prompt.trim()) return json(res, 400, { error: { message: 'empty messages' } });\n\n      try {",
  beforeTry,
);

const completedBlock = String.raw`        const payload = completionPayload(r.content);
        const hdr = { 'X-Session-Id': sess.id };
        if (operationId) {
          operations[operationId] = {
            ...operations[operationId],
            status: 'completed',
            sessionId: sess.id,
            updatedAt: new Date().toISOString(),
            result: payload,
          };
          saveOperations();
          hdr['X-Operation-Id'] = operationId;
        }
        if (body.stream) {`;
replaceOnce(
  'persist completed result',
  "        const payload = completionPayload(r.content);\n        const hdr = { 'X-Session-Id': sess.id };\n        if (body.stream) {",
  completedBlock,
);

const catchBlock = String.raw`      } catch (e) {
        if (operationId && operations[operationId] && operations[operationId].status === 'pending') {
          operations[operationId] = {
            ...operations[operationId],
            status: 'ambiguous',
            updatedAt: new Date().toISOString(),
            error: String((e && e.message) || e || 'unknown failure'),
          };
          try { saveOperations(); } catch {}
        }
        return json(res, 502, { error: { message: e.message }, ...(operationId ? { operation_id: operationId } : {}) });
      }`;
replaceOnce(
  'ambiguous catch',
  "      } catch (e) {\n        return json(res, 502, { error: { message: e.message } });\n      }",
  catchBlock,
);

if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
fs.writeFileSync(filePath, source, { mode: 0o755 });

console.log(`PATCHED ${filePath}`);
console.log(`BACKUP  ${backupPath}`);
console.log('Added: X-Operation-Id/body operation_id, durable operations.json, GET /v1/operations/<id>, cached duplicate results, and fail-closed ambiguous recovery.');
console.log('Run: node --check ~/gpt-web-bridge/gptwb.js');
