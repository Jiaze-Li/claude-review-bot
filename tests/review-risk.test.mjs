import test from 'node:test';
import assert from 'node:assert/strict';
import { addedDiffText, detectReviewRisk } from '../scripts/detect-review-risk.mjs';

test('DocFlow-style locked durable state changes trigger state-integrity risk', () => {
  const diff = [
    'diff --git a/src/core.js b/src/core.js',
    '--- a/src/core.js',
    '+++ b/src/core.js',
    '@@ -1,2 +1,9 @@',
    '+const state = loadState(repoRoot);',
    '+const task = findTask(state, id);',
    '+writeTaskUnit(repoRoot, task);',
    'diff --git a/src/state-store.js b/src/state-store.js',
    '--- a/src/state-store.js',
    '+++ b/src/state-store.js',
    '@@ -1,2 +1,9 @@',
    '+return withStateLock(repoRoot, homeDir, exec, () => {',
    '+  atomicWrite(statePath, content);',
    '+  const parent = ensureLocalStateRef(repoRoot, exec);',
    '+  git(repoRoot, [\'update-ref\', STATE_REF, commit, parent], exec);',
    '+});',
    '+// worktree checkpoints share durable history',
  ].join('\n');

  const risk = detectReviewRisk({ diff });
  assert.equal(risk.stateIntegrity, true);
  assert.ok(risk.signals.synchronization.includes('lock'));
  assert.ok(risk.signals.synchronization.includes('atomic'));
  assert.ok(risk.signals.synchronization.includes('git-ref-update'));
  assert.ok(risk.signals.durableState.includes('state'));
  assert.ok(risk.signals.multiActor.includes('worktree'));
});

test('ordinary UI/refactor changes stay on the low-cost audit path', () => {
  const diff = [
    'diff --git a/src/view.js b/src/view.js',
    '--- a/src/view.js',
    '+++ b/src/view.js',
    '@@ -1,2 +1,4 @@',
    '+const title = "Review results";',
    '+renderPanel(title);',
  ].join('\n');

  const risk = detectReviewRisk({ diff });
  assert.equal(risk.stateIntegrity, false);
});

test('risk classifier only inspects added lines, not unchanged context', () => {
  const diff = [
    'diff --git a/src/view.js b/src/view.js',
    '--- a/src/view.js',
    '+++ b/src/view.js',
    '@@ -1,4 +1,4 @@',
    ' const durableState = loadState();',
    ' return withLock(() => writeStore(durableState));',
    '-const label = "old";',
    '+const label = "new";',
  ].join('\n');

  assert.equal(addedDiffText(diff).includes('withLock'), false);
  assert.equal(detectReviewRisk({ diff }).stateIntegrity, false);
});
