import test from 'node:test';
import assert from 'node:assert/strict';
import { addPatch, chooseAnchor, findingKey, findingMarker, markerKey, parsePatch, snapNote } from '../scripts/review-anchors.mjs';

const PATCH = [
  '@@ -10,4 +10,6 @@ func a()',
  ' context ten',
  '-removed',
  '+added eleven',
  '+added twelve',
  ' context thirteen',
  '\\ No newline at end of file',
  '@@ -40,2 +42,3 @@',
  ' context forty-two',
  '+added forty-three',
  ' context forty-four',
].join('\n');

test('parsePatch numbers RIGHT-side lines: added and context count, removed do not', () => {
  const { added, right } = parsePatch(PATCH);
  assert.deepEqual(added, [11, 12, 43]);
  assert.deepEqual([...right].sort((a, b) => a - b), [10, 11, 12, 13, 42, 43, 44]);
});

test('a finding is pinned to its own line when that line is in the diff, context lines included', () => {
  const map = new Map();
  addPatch(map, 'a.swift', PATCH);
  assert.deepEqual(chooseAnchor(map, { path: 'a.swift', line: 12 }), { line: 12, snapped: false });
  assert.deepEqual(chooseAnchor(map, { path: 'a.swift', line: 13 }), { line: 13, snapped: false }); // an unchanged line inside a hunk
});

test('a line outside the diff is pinned to the nearest changed line, and a finding with no line to the first one', () => {
  const map = new Map();
  addPatch(map, 'a.swift', PATCH);
  const far = chooseAnchor(map, { path: 'a.swift', line: 534 });
  assert.equal(far.line, 43);
  assert.equal(far.snapped, true);
  assert.match(snapNote(far), /nearest changed line: line 534 is outside the changed lines/);
  assert.equal(chooseAnchor(map, { path: 'a.swift', line: 20 }).line, 12);
  const none = chooseAnchor(map, { path: 'a.swift', line: null });
  assert.equal(none.line, 11);
  assert.match(snapNote(none), /file-level finding/);
  assert.equal(snapNote({ line: 12, snapped: false }), '');
});

test('a file that is not in the PR, or has nothing added, cannot be pinned', () => {
  const map = new Map();
  addPatch(map, 'a.swift', PATCH);
  addPatch(map, 'gone.swift', '@@ -1,2 +0,0 @@\n-one\n-two');
  addPatch(map, 'huge.swift', undefined); // GitHub omits the patch of very large files
  assert.equal(chooseAnchor(map, { path: 'other.swift', line: 3 }), null);
  assert.equal(chooseAnchor(map, { path: 'gone.swift', line: 1 }), null);
  assert.equal(chooseAnchor(map, { path: 'huge.swift', line: 1 }), null);
});

test('the finding key survives the session\'s compaction of the title and ignores case and spacing', () => {
  const full = 'AHE autoPackLabel  still binds to the first search result, not the rendered sample, so a pack gets the wrong label';
  const compacted = full.replace(/\s+/g, ' ').slice(0, 40) + full.replace(/\s+/g, ' ').slice(40, 140);
  assert.equal(findingKey('a.swift', full), findingKey('a.swift', compacted.toUpperCase()));
  // a title longer than the session keeps (140 chars), with irregular spacing inside the part that is cut:
  const long = `Missing validation   of the user-supplied value in the handler\n${'x'.repeat(200)} tail`;
  const asStored = long.replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
  assert.equal(findingKey('a.swift', long), findingKey('a.swift', asStored));
  assert.notEqual(findingKey('a.swift', full), findingKey('b.swift', full));
  assert.notEqual(findingKey('a.swift', full), findingKey('a.swift', 'a different problem entirely'));
  assert.match(findingKey('a.swift', full), /^[0-9a-f]{10}$/);
});

test('a marker round-trips and is invisible in rendered markdown', () => {
  const marker = findingMarker('a.swift', 'Some bug');
  assert.match(marker, /^<!-- jiaze-finding:[0-9a-f]{10} -->$/);
  assert.equal(markerKey(`**[P2] Some bug**\n\nbody\n\n${marker}`), findingKey('a.swift', 'Some bug'));
  assert.equal(markerKey('no marker here'), null);
  assert.equal(markerKey(undefined), null);
});

test('two findings in one file that share a long title opening do not share a key', () => {
  const opening = 'Missing validation of the user-supplied value in handler';
  assert.ok(opening.length >= 56);
  const a = `${opening} createUser allows an empty name`;
  const b = `${opening} deleteUser allows a negative id`;
  assert.notEqual(findingKey('api.swift', a), findingKey('api.swift', b));
  assert.notEqual(findingMarker('api.swift', a), findingMarker('api.swift', b));
});
