// Where a finding can be pinned in a pull request, and how a pinned comment is recognised later.
//
// GitHub only accepts a review comment on a line that is part of the PR's diff (RIGHT side). A
// finding is therefore pinned to its own line when that line is in the diff, otherwise to the
// nearest changed line of the same file, so it is a thread a person can resolve. Only a finding
// whose file is not in the PR at all stays in the review body.

import { createHash } from 'node:crypto';

// One entry per file: { added: sorted line numbers, right: Set of every RIGHT-side line in a hunk }.
export function parsePatch(patch) {
  const added = [];
  const right = new Set();
  let newLine = 0;
  let inHunk = false;
  for (const text of String(patch ?? '').split('\n')) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith('\\ No newline')) continue;
    if (text.startsWith('+')) {
      added.push(newLine);
      right.add(newLine);
      newLine += 1;
    } else if (text.startsWith('-')) {
      // A removed line has no RIGHT-side number.
    } else {
      right.add(newLine);
      newLine += 1;
    }
  }
  return { added, right };
}

export function addPatch(anchorMap, filename, patch) {
  if (typeof filename !== 'string' || typeof patch !== 'string') return;
  anchorMap.set(filename, parsePatch(patch));
}

// -> { line, snapped, reason } | null. `snapped` is false only when the finding's own line is in the diff.
export function chooseAnchor(anchorMap, finding) {
  const file = anchorMap.get(finding.path);
  if (!file || !file.added.length) return null;
  if (Number.isInteger(finding.line) && file.right.has(finding.line)) return { line: finding.line, snapped: false };
  if (!Number.isInteger(finding.line)) return { line: file.added[0], snapped: true, reason: 'file-level finding' };
  const nearest = file.added.reduce((best, line) => (Math.abs(line - finding.line) < Math.abs(best - finding.line) ? line : best));
  return { line: nearest, snapped: true, reason: `line ${finding.line} is outside the changed lines` };
}

export function snapNote(anchor) {
  return anchor.snapped ? `\n\n_Pinned to the nearest changed line: ${anchor.reason}._` : '';
}

// A stable key for "this finding in this file", so a thread can be matched to a session finding later
// even though the session stores a compacted title and the comment carries the full one.
export function findingKey(path, title) {
  const normalized = String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  return createHash('sha1').update(`${path}\0${normalized}`).digest('hex').slice(0, 10);
}

export function findingMarker(path, title) {
  return `<!-- jiaze-finding:${findingKey(path, title)} -->`;
}

export function markerKey(body) {
  const match = typeof body === 'string' ? body.match(/<!-- jiaze-finding:([0-9a-f]{10}) -->/) : null;
  return match ? match[1] : null;
}
