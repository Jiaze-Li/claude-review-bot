import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Every script that reads or writes the review ledger needs to know which account is the bot. A workflow step that
// forgets to pass it fails the whole review at its first record, so the gap is caught here instead of on a live PR.
const LEDGER_SCRIPTS = ['apply-stale', 'apply-override', 'recover-review-session', 'stop-unavailable-review',
  'publish-gemini-review', 'publish-review', 'review-status', 'deep-review', 'apply-dismissal', 'plan-review-session',
  'sync-commit-status', 'sweep-stale-deep-reviews'];

for (const file of ['review-v2.yml', 'sweep-stale-deep-reviews.yml']) {
  test(`${file}: every step that touches the review ledger names the bot account`, () => {
    const text = fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const steps = text.split(/\n {6}- /).slice(1);
    const missing = [];
    let checked = 0;
    for (const step of steps) {
      const script = /node scripts\/([\w-]+)\.mjs/.exec(step)?.[1];
      if (!script || !LEDGER_SCRIPTS.includes(script)) continue;
      checked += 1;
      if (!/EXPECTED_REVIEW_AUTHOR:/.test(step)) missing.push(`${step.split('\n')[0]} (${script})`);
    }
    assert.ok(checked > 0, 'no ledger steps found: the check is not looking at anything');
    assert.deepEqual(missing, []);
  });
}
