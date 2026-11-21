// test:compat — runs the formal consumer-side evaluation (evaluateDeliveryComment, the same parser/trust/decision
// code the bot uses) over a fixtures file. The expected values come from the file, never from the comment body.
//
//   npm run test:compat -- --in /absolute/path/delivery-fixtures.json     (no --in: generate fresh and check)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateDeliveryComment } from './delivery-protocol.mjs';
import { buildFixtures } from './delivery-fixtures.mjs';

export function checkFixtures(fixtures) {
  const failures = [];
  if (fixtures?.schema_version !== 1 || !Array.isArray(fixtures.cases)) return ['fixtures file has the wrong shape'];
  for (const c of fixtures.cases) {
    const actual = evaluateDeliveryComment({
      repo: c.repo, prNumber: c.pr_number, localHead: c.local_head_sha, currentHead: c.current_head_sha,
      authorLogin: c.comment_author_login, authorType: c.comment_author_type, body: c.comment_body,
    });
    if (actual.trusted !== c.expected.trusted || actual.decision !== c.expected.decision) {
      failures.push(`${c.name}: expected ${JSON.stringify(c.expected)} but got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--in');
  const fixtures = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) : buildFixtures();
  const failures = checkFixtures(fixtures);
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; return; }
  console.log(`delivery-v1 compat: ${fixtures.cases.length} case(s) ok`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
