import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/review-v2.yml', import.meta.url), 'utf8');

function step(name) {
  const startMarker = `      - name: ${name}\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - name: ', start + startMarker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

// Both fetches operate on an actions/checkout worktree with persist-credentials:false.
// The GitHub App's read token must be passed only to the individual fetch, not
// persisted to Git config or passed on the command line.
function assertScopedAuthenticatedFetch(section, commitRef) {
  assert.match(section, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  const lines = section.split(/\r?\n/).map((line) => line.trim());
  const fetchLine = `git -C target fetch --no-tags --depth=1 origin "${commitRef}"`;
  const at = lines.indexOf(fetchLine);
  assert.ok(at >= 3, `missing authenticated fetch of ${commitRef}`);
  assert.equal(lines[at - 3], 'auth="$(printf \'x-access-token:%s\' "$GH_TOKEN" | base64 -w0)"');
  assert.equal(lines[at - 2], 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \\');
  assert.equal(lines[at - 1], 'GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \\');
  assert.equal(lines.filter((line) => line.startsWith('git -C target fetch ')).length, 1);
}

test('missing private PR merge-base uses command-scoped App authentication', () => {
  const checkout = step('Checkout exact PR head temporarily');
  assert.match(checkout, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(checkout, /persist-credentials: false/);

  const context = step('Build exact PR review context');
  assert.match(context, /merge_base="\$\(gh api /);
  assert.match(context, /git -C target cat-file -e "\$\{merge_base\}\^\{commit\}"/);
  assertScopedAuthenticatedFetch(context, '$merge_base');
});

test('verification/incremental prior-HEAD fetch keeps the same credential boundary', () => {
  const delta = step('Build repair / incremental delta diff');
  assert.match(delta, /git -C target cat-file -e "\$\{PREVIOUS_HEAD\}\^\{commit\}"/);
  assertScopedAuthenticatedFetch(delta, '$PREVIOUS_HEAD');
});
