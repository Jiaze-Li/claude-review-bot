import test from 'node:test';
import assert from 'node:assert/strict';
import { foldedDetails, splitSummary } from '../scripts/github-review-api.mjs';

test('a short one-paragraph summary stays fully visible with nothing folded', () => {
  assert.deepEqual(splitSummary('Reviewed 3 of 3 changed file(s).'), { visible: 'Reviewed 3 of 3 changed file(s).', detail: '' });
});

test('a long multi-paragraph summary shows only its first line and folds the full text', () => {
  const summary = 'Reviewed 16 of 16 changed file(s) in 4 shard(s) — PARTIAL.\n\nShards: 1: ok\n\nShard 1 review. ' + 'x'.repeat(3000);
  const { visible, detail } = splitSummary(summary);
  assert.equal(visible, 'Reviewed 16 of 16 changed file(s) in 4 shard(s) — PARTIAL.');
  assert.equal(detail, summary);
});

test('an overlong first paragraph is cut for display but kept whole in the fold', () => {
  const summary = 'a'.repeat(500);
  const { visible, detail } = splitSummary(summary);
  assert.ok(visible.length <= 240 && visible.endsWith('…'));
  assert.equal(detail, summary);
});

test('folded details wrap text in a collapsed block and vanish when empty', () => {
  assert.equal(foldedDetails('More', ''), '');
  assert.match(foldedDetails('More', 'body'), /^<details><summary>More<\/summary>\n\nbody\n\n<\/details>$/);
});
