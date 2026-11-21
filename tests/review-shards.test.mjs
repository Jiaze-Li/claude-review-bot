import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IGNORE, assertDiffCoverage, decodeGitPath, filePriority, matchesIgnore, parseIgnorePatterns, splitDiffByFile } from '../scripts/review-shards.mjs';

const diff = (path, body = 'x'.repeat(10)) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${body}\n`;
const finding = (severity, path = 'a.swift', title = 'bug') => ({ severity, title, body: 'b', path, line: 1 });
const ok = (structured) => ({ ok: true, structured });

test('splitDiffByFile yields one chunk per file with exact byte sizes', () => {
  const text = diff('Sources/A.swift') + diff('Sources/B.swift', 'y'.repeat(50));
  const chunks = splitDiffByFile(text);
  assert.deepEqual(chunks.map((c) => c.path), ['Sources/A.swift', 'Sources/B.swift']);
  assert.equal(chunks.reduce((n, c) => n + c.bytes, 0), Buffer.byteLength(text));
});

test('Git C-quoted paths match between --name-only and diff shards', () => {
  // Git's default core.quotePath=true emits quoted UTF-8 octal bytes, not Unicode text.
  const cases = [
    { path: 'docs/测试.md', name: String.raw`"docs/\346\265\213\350\257\225.md"`, header: String.raw`diff --git "a/docs/\346\265\213\350\257\225.md" "b/docs/\346\265\213\350\257\225.md"` },
    { path: 'docs/back\\file.md', name: String.raw`"docs/back\\file.md"`, header: String.raw`diff --git "a/docs/back\\file.md" "b/docs/back\\file.md"` },
    { path: 'docs/quote"name.md', name: String.raw`"docs/quote\"name.md"`, header: String.raw`diff --git "a/docs/quote\"name.md" "b/docs/quote\"name.md"` },
    { path: 'docs/tab\tfile.md', name: String.raw`"docs/tab\tfile.md"`, header: String.raw`diff --git "a/docs/tab\tfile.md" "b/docs/tab\tfile.md"` },
    { path: 'docs/with space.md', name: 'docs/with space.md', header: 'diff --git a/docs/with space.md b/docs/with space.md' },
    { path: 'docs/renamed.md', name: 'docs/renamed.md', header: 'diff --git a/docs/original.md b/docs/renamed.md' },
  ];
  const diffText = cases.map((c) => `${c.header}\n--- a/old\n+++ b/new\n@@ -0,0 +1 @@\n+content\n`).join('');
  const chunks = splitDiffByFile(diffText);
  const listed = cases.map((c) => decodeGitPath(c.name));
  assert.deepEqual(listed, cases.map((c) => c.path));
  assert.deepEqual(chunks.map((c) => c.path), listed);
  assertDiffCoverage(listed, chunks);
});

test('plain UTF-8 Git paths and mixed quoting are parsed', () => {
  assert.deepEqual(splitDiffByFile(diff('docs/测试.md')).map((c) => c.path), ['docs/测试.md']);
  const mixed = String.raw`diff --git "a/docs/old\ttab.md" b/docs/new.md`;
  assert.equal(splitDiffByFile(mixed)[0].path, 'docs/new.md');
});

test('unquoted Git diff headers containing a literal b/ path segment are not truncated', () => {
  // These headers are emitted without quotes by Git core.quotePath=true.
  const paths = ['docs/a b/c.md', 'docs/a b/dir b/c.md', 'docs/name b/sub b/file.md'];
  const chunks = splitDiffByFile(paths.map((path) => diff(path)).join(''));
  assert.deepEqual(chunks.map((chunk) => chunk.path), paths);
  assertDiffCoverage(paths, chunks);
  assert.ok(chunks.every((chunk) => chunk.text.includes('diff --git a/')));
});

test('unquoted rename and copy paths containing b/ use Git destination metadata', () => {
  const rename = 'diff --git a/docs/a b/c.md b/docs/new b/name.md\n'
    + 'similarity index 100%\n'
    + 'rename from docs/a b/c.md\n'
    + 'rename to docs/new b/name.md\n';
  const copy = 'diff --git a/docs/a b/c.md b/docs/new b/copy.md\n'
    + 'similarity index 100%\n'
    + 'copy from docs/a b/c.md\n'
    + 'copy to docs/new b/copy.md\n';
  const chunks = splitDiffByFile(rename + copy);
  const expected = ['docs/new b/name.md', 'docs/new b/copy.md'];
  assert.deepEqual(chunks.map((chunk) => chunk.path), expected);
  assertDiffCoverage(expected, chunks);
  // Without destination metadata there is no safe way to choose among b/ separators.
  assert.throws(() => splitDiffByFile('diff --git a/docs/a b/c.md b/docs/new b/name.md\n'),
    /Cannot disambiguate Git diff header/);
});

test('unparseable Git paths and missing diff blocks fail closed', () => {
  assert.throws(() => decodeGitPath(String.raw`"docs/\xFF.md"`), /unknown escape/);
  assert.throws(() => decodeGitPath(String.raw`"docs/\34.md"`), /invalid octal escape/);
  assert.throws(() => decodeGitPath(String.raw`"docs/\377.md"`), /encoded data was not valid|not valid|invalid/i);
  assert.throws(() => splitDiffByFile('diff --git invalid-header\n'), /Cannot parse Git diff header/);
  assert.throws(() => assertDiffCoverage(['docs/测试.md'], splitDiffByFile(diff('docs/other.md'))), /Missing Git diff block/);
});

test('ignore rules: gitignore-like patterns, comments, case-insensitive, and binary assets are skipped by default', () => {
  const patterns = parseIgnorePatterns('# generated\n*.lock\nbuild/\n/docs/gen/**\nSources/**/Generated/*.swift\n');
  const hit = ['a.lock', 'x/y/a.lock', 'build/o.js', 'src/build/o.js', 'docs/gen/a/b.md', 'Sources/A/B/Generated/x.swift'];
  const miss = ['docs/other.md', 'Sources/A.swift', 'src/lock.txt'];
  assert.ok(hit.every((f) => matchesIgnore(f, patterns)), 'should match');
  assert.ok(miss.every((f) => !matchesIgnore(f, patterns)), 'should not match');
  assert.ok(matchesIgnore('img/Logo.PNG', DEFAULT_IGNORE));
  // Lockfiles are NOT skipped unless a repository opts in.
  assert.ok(!matchesIgnore('package-lock.json', DEFAULT_IGNORE));
  assert.deepEqual(parseIgnorePatterns('x'.repeat(300) + '\nok'), ['ok']);
});
