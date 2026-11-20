// Minimal, sanitized diff fixtures derived from Jiaze-Li/reviewloop PR #60.
// Used for L1 offline classifier tests (AC4).

// Source: Jiaze-Li/reviewloop @ 6374db210278565d3e816e1d74e596ddbb05c891
// Path: bin/install-plugin.js, lines 159-165 & 347-360 (boolean MCP query + rollback remove)
export const PR60_BOOLEAN_MCP_ROLLBACK_DIFF = [
  'diff --git a/bin/install-plugin.js b/bin/install-plugin.js',
  '--- a/bin/install-plugin.js',
  '+++ b/bin/install-plugin.js',
  '@@ -158,6 +158,15 @@',
  '+function hasClaudeMcp(execFileSync, name = MCP_NAME) {',
  '+  return runCli(execFileSync, \'claude\', [\'mcp\', \'get\', name], { allowFailure: true }) !== null;',
  '+}',
  '+// Rollback any newly added MCP registration when install fails.',
  '+function reconcileMcp({ execFileSync, present, mcpBefore }) {',
  '+  if (!before[name] && after) {',
  '+    runCli(execFileSync, remove, [\'mcp\', \'remove\', name], { allowFailure: true });',
  '+  }',
  '+}',
].join('\n');

// Source: Jiaze-Li/reviewloop @ 35279dd9ef71d7be0e509f3e31a52c956a4b6e52
// Path: bin/install-plugin.js, lines 159-174 (tri-state MCP query + rollback)
export const PR60_TRISTATE_MCP_ROLLBACK_DIFF = [
  'diff --git a/bin/install-plugin.js b/bin/install-plugin.js',
  '--- a/bin/install-plugin.js',
  '+++ b/bin/install-plugin.js',
  '@@ -158,6 +158,15 @@',
  '+// Tri-state registration query: present | absent | unknown; rollback never removes unknown.',
  '+const NOT_REGISTERED_RE = /not\\s+found|not\\s+configured/i;',
  '+function mcpState(execFileSync, command, name) {',
  '+  try {',
  '+    execFileSync(command, [\'mcp\', \'get\', name], { encoding: \'utf8\' });',
  '+    return \'present\';',
  '+  } catch (err) {',
  '+    const text = `${err?.stderr ?? \'\'} ${err?.message ?? \'\'}`;',
  '+    return NOT_REGISTERED_RE.test(text) ? \'absent\' : \'unknown\';',
  '+  }',
  '+}',
].join('\n');

// Source: Jiaze-Li/reviewloop @ 6374db210278565d3e816e1d74e596ddbb05c891
// Path: tests/cliLink.test.js, lines 141-152 (chmod permission-bit fault injection without root guard)
export const PR60_CHMOD_TEST_DIFF = [
  'diff --git a/tests/cliLink.test.js b/tests/cliLink.test.js',
  '--- a/tests/cliLink.test.js',
  '+++ b/tests/cliLink.test.js',
  '@@ -141,6 +141,12 @@',
  '+test(\'permission denied: reports, leaves the old link\', async () => {',
  '+  const parent = path.dirname(libPkg);',
  '+  try {',
  '+    await chmod(parent, 0o555);',
  '+    const results = applyCliRepair(planCliRepair(inspect(prefix)));',
  '+    await chmod(parent, 0o755);',
  '+  } finally { await chmod(parent, 0o755).catch(() => {}); }',
  '+});',
].join('\n');

export const NEGATIVE_CONTROL_DIFFS = {
  docsOnly: [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,2 +1,4 @@',
    '+This documentation describes read-only review mode.',
    '+No executable code or recovery logic is changed.',
  ].join('\n'),
  uiRefactor: [
    'diff --git a/src/panel.js b/src/panel.js',
    '--- a/src/panel.js',
    '+++ b/src/panel.js',
    '@@ -1,2 +1,4 @@',
    '+export function renderBadge(status) {',
    '+  return `<span class="badge">${status}</span>`;',
    '+}',
  ].join('\n'),
  restoreInCommentOnly: [
    'diff --git a/src/ui-copy.js b/src/ui-copy.js',
    '--- a/src/ui-copy.js',
    '+++ b/src/ui-copy.js',
    '@@ -1,2 +1,4 @@',
    '+// Restore previous label formatting after refactor',
    '+export const BUTTON_LABEL = "Restore defaults";',
  ].join('\n'),
  fetchWithoutRecovery: [
    'diff --git a/src/client.js b/src/client.js',
    '--- a/src/client.js',
    '+++ b/src/client.js',
    '@@ -1,2 +1,4 @@',
    '+export async function fetchStatus(url) {',
    '+  return fetch(url).then((r) => r.json());',
    '+}',
  ].join('\n'),
};
