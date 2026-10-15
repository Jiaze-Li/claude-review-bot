import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGroundedSourceAnchor,
  requireGroundedSourceEvidence,
} from '../scripts/local-source-evidence.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-evidence-'));
  fs.mkdirSync(path.join(root, 'src'));
  const code = [
    'export function closeAccount(session) {',
    '  session.active = false;',
    '  saveAccount(session);',
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'src', 'account.js'), code);
  return {
    root,
    context: '## Primary file: src/account.js\n'
      + code.split('\n').map((s, i) => `${i + 1}: ${s}`).join('\n'),
    valid: { path: 'src/account.js', line: 2, quote: 'session.active = false;' },
  };
}

function candidate(sourceAnchors) {
  return {
    candidateId: 'D001',
    verdict: 'CONFIRMED',
    reason: 'The logout path leaves persistent authorization state.',
    evidence: ['Model-provided prose is not a verified source citation.'],
    sourceAnchors,
  };
}

test('real exact-HEAD citation supports blocking a local code finding', () => {
  const { root, context, valid } = fixture();
  const out = requireGroundedSourceEvidence(candidate([valid]), { repoRoot: root, context });
  assert.equal(out.verdict, 'CONFIRMED');
  assert.deepEqual(out.sourceAnchors, [valid]);
});

test('model prose without any source quote cannot block', () => {
  const { root, context } = fixture();
  const out = requireGroundedSourceEvidence(candidate([]), { repoRoot: root, context });
  assert.equal(out.verdict, 'UNCERTAIN');
  assert.match(out.reason, /no verifiable source quote/i);
});

test('invented source text and wrong source line cannot block', () => {
  const { root, context, valid } = fixture();
  for (const anchor of [
    { ...valid, quote: 'session.token = null;' },
    { ...valid, line: 3 },
    { ...valid, path: 'src/missing.js' },
    { ...valid, quote: 'session' },
  ]) {
    assert.equal(isGroundedSourceAnchor(anchor, { repoRoot: root, context }), false);
  }
});

test('citation must have been included in the supplied targeted context', () => {
  const { root, valid } = fixture();
  assert.equal(isGroundedSourceAnchor(valid, { repoRoot: root, context: '## PR diff\n+different code' }), false);
});

test('path traversal, absolute paths and symlink escape cannot pass source validation', () => {
  const { root, context, valid } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'source-evidence-outside-'));
  fs.writeFileSync(path.join(outside, 'outside.js'), '  session.active = false;\n');
  fs.symlinkSync(path.join(outside, 'outside.js'), path.join(root, 'src', 'escape.js'));
  for (const bad of [
    '../outside.js', '/tmp/outside.js', 'src/../../outside.js',
    'src/escape.js', 'src\\account.js',
  ]) {
    assert.equal(isGroundedSourceAnchor({ ...valid, path: bad }, { repoRoot: root, context }), false);
  }
});

test('one real citation is enough even if other model citations are fabricated', () => {
  const { root, context, valid } = fixture();
  const bad = { ...valid, quote: 'session.token = null;' };
  const out = requireGroundedSourceEvidence(candidate([bad, valid]), { repoRoot: root, context });
  assert.equal(out.verdict, 'CONFIRMED');
  assert.deepEqual(out.sourceAnchors, [valid]);
});

test('REJECTED and UNCERTAIN verdicts are unchanged by the blocking gate', () => {
  const { root, context } = fixture();
  for (const verdict of ['REJECTED', 'UNCERTAIN']) {
    const finding = { ...candidate([]), verdict };
    assert.deepEqual(requireGroundedSourceEvidence(finding, { repoRoot: root, context }), finding);
  }
});
