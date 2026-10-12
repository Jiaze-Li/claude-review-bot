import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// run-review.mjs executes on import, so assert on its source instead.
const source = fs.readFileSync(new URL('../scripts/run-review.mjs', import.meta.url), 'utf8');

test('Claude deep review follows the moving sonnet alias at medium effort', () => {
  assert.match(source, /const REVIEW_MODEL = 'sonnet';/);
  assert.match(source, /const REVIEW_EFFORT = 'medium';/);
});

test('Dependabot keeps the Claude Agent SDK current so the sonnet alias tracks the newest Sonnet', () => {
  const yml = fs.readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(yml, /package-ecosystem: npm/);
  assert.match(yml, /dependency-name: "@anthropic-ai\/claude-agent-sdk"/);
});
