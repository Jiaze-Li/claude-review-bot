// ONE-TIME migration of the retired schema_version 1 state comment to schema_version 2. Delete this file (and
// .github/workflows/migrate-v1.yml) after the cut-over. Dry-run by default.
//
//   TARGET_REPO=owner/repo PR_NUMBER=219 GH_TOKEN=<app token> node scripts/migrate-v1.mjs [--apply]
//
// The comment keeps its identity (same comment id, same bot author); only its document changes. Attempts already
// spent stay spent, no round is invented, findings are kept, and a document that is already v2 is left alone, so
// running it twice changes nothing.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGithubClient, createStateStore } from './review.mjs';
import { BOT_LOGIN, parseComment, readState } from './review-contract.mjs';
import { convertV1 } from './review-engine.mjs';

export async function migrateOne({ github, repo, prNumber, apply = false, botLogin = BOT_LOGIN, now = Date.now(), mergeBaseOf }) {
  const pr = await github.getPr();
  const records = await github.readRecords();
  const read = readState(records, { botLogin, repo, prNumber });
  const botComments = records.filter((r) => r.type === 'Bot' && parseComment(r.body) == null).length;
  const report = { repo, pr: prNumber, head: pr.head_sha, applied: false, botCommentsNotReviewState: botComments };
  if (read.kind === 'ok') return { ...report, result: 'already-v2', note: `no change (rounds ${read.state.completed_rounds}, attempts ${read.state.attempts_used})` };
  if (read.kind === 'none') return { ...report, result: 'nothing-to-migrate' };
  if (read.kind !== 'legacy') return { ...report, result: 'not-convertible', reason: read.reason };

  const mergeBase = await mergeBaseOf(pr);
  const scope = { merge_base_sha: mergeBase, files_sha256: createHash('sha256').update('').digest('hex'), total_files: 0, skipped_files: 0 }; // recomputed from the diff by the next run
  const converted = convertV1(read.legacy, { repo, prNumber, scope, now });
  if (!converted.ok) return { ...report, result: 'not-convertible', reason: converted.reason };
  const { state } = converted;
  const summary = {
    from: { runs_used: read.legacy.review_runs_used, status: read.legacy.status, coverage_complete: read.legacy.coverage_complete },
    to: { status: state.status, completed_rounds: state.completed_rounds, attempts_used: state.attempts_used, findings: state.findings.length, blocking: state.findings.filter((f) => ['P0', 'P1', 'P2'].includes(f.severity) && f.verification !== 'FIXED').map((f) => f.id) },
    head_changed_since_v1: state.head_sha !== pr.head_sha,
  };
  if (!apply) return { ...report, result: 'would-migrate', ...summary };
  const store = createStateStore({ github, botLogin, repo, prNumber, commentId: read.commentId, lastState: read.legacy });
  await store.write(state);
  return { ...report, result: 'migrated', applied: true, ...summary };
}

async function main() {
  const env = process.env;
  const github = createGithubClient({ token: env.GH_TOKEN, target: env.TARGET_REPO, prNumber: env.PR_NUMBER, env });
  const mergeBaseOf = async (pr) => {
    const response = await fetch(`https://api.github.com/repos/${env.TARGET_REPO}/compare/${pr.base_sha}...${pr.head_sha}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`, 'User-Agent': 'jiaze-review-bot' },
    });
    if (!response.ok) throw new Error(`compare failed (HTTP ${response.status})`);
    return (await response.json()).merge_base_commit.sha;
  };
  const report = await migrateOne({
    github, repo: env.TARGET_REPO, prNumber: Number(env.PR_NUMBER), apply: process.argv.includes('--apply'),
    botLogin: env.EXPECTED_REVIEW_AUTHOR || BOT_LOGIN, mergeBaseOf: async (pr) => mergeBaseOf({ ...pr, head_sha: pr.head_sha }),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.result === 'not-convertible') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
