import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MERGED_FINDINGS, filePriority, mergeShardResults, planShards, reconcileCoverage, splitDiffByFile } from '../scripts/review-shards.mjs';

const diff = (path, body = 'x'.repeat(10)) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${body}\n`;
const finding = (severity, path = 'a.swift', title = 'bug') => ({ severity, title, body: 'b', path, line: 1 });
const ok = (structured) => ({ ok: true, structured });

test('splitDiffByFile yields one chunk per file with exact byte sizes', () => {
  const text = diff('Sources/A.swift') + diff('Sources/B.swift', 'y'.repeat(50));
  const chunks = splitDiffByFile(text);
  assert.deepEqual(chunks.map((c) => c.path), ['Sources/A.swift', 'Sources/B.swift']);
  assert.equal(chunks.reduce((n, c) => n + c.bytes, 0), Buffer.byteLength(text));
});

test('planShards groups by directory order, keeps every changed file, and files without a diff block still get a shard', () => {
  const chunks = splitDiffByFile(diff('a/1.swift', 'x'.repeat(60)) + diff('a/2.swift', 'x'.repeat(60)) + diff('b/3.swift', 'x'.repeat(60)));
  const { shards, deferred } = planShards({ files: ['a/1.swift', 'a/2.swift', 'b/3.swift', 'img/logo.png'], chunks, targetBytes: 200, maxShards: 6 });
  assert.deepEqual(deferred, []);
  assert.deepEqual(shards.flatMap((s) => s.files).sort(), ['a/1.swift', 'a/2.swift', 'b/3.swift', 'img/logo.png']);
  assert.ok(shards.every((s) => s.bytes <= 200 || s.files.length === 1));
});

test('source shards are scheduled before tests/docs/lockfiles and overflow shards are deferred, not dropped', () => {
  assert.equal(filePriority('package-lock.json'), 0);
  assert.equal(filePriority('Tests/FooTests.swift'), 0);
  assert.equal(filePriority('Sources/Foo.swift'), 1);
  const files = ['Sources/A.swift', 'Sources/B.swift', 'docs/c.md'];
  const chunks = files.map((f) => ({ path: f, bytes: 100, text: diff(f) }));
  const { shards, deferred } = planShards({ files, chunks, targetBytes: 100, maxShards: 2 });
  assert.equal(shards.length, 2);
  assert.deepEqual(deferred, ['docs/c.md']);
  assert.ok(shards.every((s) => s.files[0].startsWith('Sources/')));
});

test('a file the model does not credit as reviewed counts as unreviewed, and claims outside the shard are ignored', () => {
  const c = reconcileCoverage({ complete: true, reviewedPaths: ['a', 'zzz'], unreviewedPaths: [], note: '' }, ['a', 'b']);
  assert.deepEqual(c.reviewedPaths, ['a']);
  assert.deepEqual(c.unreviewedPaths, ['b']);
  assert.equal(c.complete, false);
});

test('merge: all shards complete gives a complete review with deduped, severity-ordered findings', () => {
  const shards = [{ files: ['a'] }, { files: ['b'] }];
  const merged = mergeShardResults({
    shards, allFiles: ['a', 'b'],
    results: [
      ok({ summary: 's1', findings: [finding('P3', 'a', 'Dup'), finding('P2', 'a', 'Real')], coverage: { complete: true, reviewedPaths: ['a'], unreviewedPaths: [], note: '' } }),
      ok({ summary: 's2', findings: [finding('P3', 'a', 'dup')], coverage: { complete: true, reviewedPaths: ['b'], unreviewedPaths: [], note: '' } }),
    ],
  });
  assert.equal(merged.coverage.complete, true);
  assert.deepEqual(merged.findings.map((f) => f.severity), ['P2', 'P3']);
  assert.match(merged.summary, /Reviewed 2 of 2 changed file\(s\) in 2 shard\(s\)\./);
});

test('merge: a failed, unrun or deferred shard makes the review PARTIAL and names the files', () => {
  const shards = [{ files: ['a'] }, { files: ['b'] }, { files: ['c'] }];
  const merged = mergeShardResults({
    shards, deferred: ['d'], allFiles: ['a', 'b', 'c', 'd'],
    results: [ok({ summary: 's', findings: [], coverage: { complete: true, reviewedPaths: ['a'], unreviewedPaths: [], note: '' } }), { ok: false, error: 'timed out' }],
  });
  assert.equal(merged.coverage.complete, false);
  assert.deepEqual(merged.coverage.unreviewedPaths, ['b', 'c', 'd']);
  assert.match(merged.summary, /PARTIAL/);
  assert.match(merged.summary, /Not reviewed: b, c, d/);
  assert.match(merged.coverage.note, /shard 2\/3 failed/);
  assert.match(merged.coverage.note, /shard 3\/3 did not run/);
});

test('merge never records more findings than the session allows and says when material ones were omitted', () => {
  const many = Array.from({ length: 9 }, (_, i) => finding('P2', 'a', `bug ${i}`));
  const merged = mergeShardResults({
    shards: [{ files: ['a'] }], allFiles: ['a'],
    results: [ok({ summary: 's', findings: many, coverage: { complete: true, reviewedPaths: ['a'], unreviewedPaths: [], note: '' } })],
  });
  assert.equal(merged.findings.length, MAX_MERGED_FINDINGS);
  assert.match(merged.summary, /3 more material finding\(s\) were omitted/);
});
