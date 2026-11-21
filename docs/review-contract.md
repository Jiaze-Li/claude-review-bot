# Review result contract (schema_version 2)

Owner: pr-bot. Consumers (agent-delivery) pin this file and `tests/fixtures/review-contract.json` by commit SHA. Code: `scripts/review-contract.mjs` (parse, validate, render, consumer decision) and `scripts/review-engine.mjs` (state transitions). Regenerate fixtures with `npm run review:fixtures`; check any fixtures file with `npm run test:compat -- --in <file>`.

## The one record

One conversation comment per PR, authored by the review App (`jiaze-claude-review-bot[bot]`, type `Bot`). It starts with the locator `<!-- agent-delivery:v1 -->` (a locator only, not a version), then a ```json block, then text generated from the JSON. Only the JSON is authoritative. The commit status `claude-review-bot/review` is its projection.

```jsonc
{
  "schema_version": 2,
  "repo": "owner/repo", "pr_number": 123,
  "head_sha": "<40 hex>",            // the HEAD this state describes
  "status": "IN_PROGRESS | CHANGES_REQUESTED | READY | STOPPED",
  "reason": "human readable",
  "completed_rounds": 0,             // 0..2 complete review conclusions published for this PR
  "completed_head_sha": null,        // HEAD of the latest completed round, else null
  "attempts_used": 1,                // 0..10 model executions started (recorded BEFORE the call; failures are not refunded)
  "stalled_attempts": 0,             // consecutive attempts on this HEAD that credited no new file
  "scope": { "merge_base_sha": "...", "files_sha256": "...", "total_files": 26, "skipped_files": 0 },
  "reviewed_files": [],              // files credited so far in the current scope; empty once a round completes
  "findings": [ { "id": "F001", "severity": "P0|P1|P2|P3", "title": "", "path": "", "failure_path": "", "verification": "OPEN|FIXED|STILL_OPEN|UNCERTAIN", "checked_head_sha": "<sha>" } ],
  "updated_at": "ISO", "claimed_at": "ISO (IN_PROGRESS only)"
}
```

A blocking finding is `severity in P0..P2` and `verification != FIXED`. P3 never blocks. `skipped_files` counts files outside the review scope (ignore rules, binary content); the comment says so.

## Consumer rules (`evaluateComment`)

Decision is one of `READY | CHANGES_REQUESTED | STOPPED | WAIT`. `WAIT` is a display result ("no usable final state yet"), never a remote status.

1. The comment must be by the bot identity with type `Bot`, carry the marker and a parseable, valid `schema_version: 2` JSON for this repo and PR. Otherwise: not trusted, `WAIT`. A `schema_version: 1` document is never a pass.
2. `head_sha` must equal both the consumer's local HEAD and the remote's current HEAD. Otherwise `WAIT`.
3. `IN_PROGRESS` is `WAIT`. Otherwise the decision is the status.
4. A `READY` that contradicts its own JSON (blocking finding, or `completed_head_sha != head_sha`) is invalid, hence `WAIT`.

`STOPPED` on the current HEAD means automatic execution cannot continue; `reason` says why and what is unreviewed. If `completed_head_sha != head_sha` and budget remains, asking for a review again (`@jiaze-claude-review-bot review`) resumes it on the same PR.

## Rules the bot enforces

- Non-draft PRs only. First Ready, push, review command and workflow rerun all enter the same decision (`planRun`).
- Round = one complete review conclusion for one HEAD. Coverage is built from sequential batches (bounded by file count and diff size) and credited by the program: only files assigned to the batch, reported reviewed, not reported unreviewed; `complete=false` without naming what is missing earns no credit; a file whose diff was cut at the inline cap is credited only if the gateway's own `Read` log shows every line of it was delivered whole (segments may be combined; a line cut at the budget does not count). A file still at HEAD is read from the snapshot; a file the PR deletes is read from its block of the full diff (`.review-context/pr.diff`), and the prompt lists every deleted path so references left behind can be found with `Grep`. Batches are bounded by the Read calls they need against the attempt's turn budget; a file no single attempt can read through stops the PR before any model call.
- Round 1 complete: no blocker -> `READY`; blocker -> `CHANGES_REQUESTED`. Round 2 complete: no blocker -> `READY`; blocker or `UNCERTAIN` -> `STOPPED`. There is no third round; later HEADs are `STOPPED` unreviewed. Incomplete coverage never publishes `CHANGES_REQUESTED`, even with a P2 in hand.
- Earlier blockers are re-verified on the new HEAD (`FIXED` needs evidence). A blocker nobody verified is `UNCERTAIN`, never fixed. Findings are only added or escalated: IDs are stable, a repeated issue never loses to an old P3/FIXED, nothing is truncated to reach `READY`. More than 40 findings is `STOPPED`.
- The round count and its conclusion are written in the same single comment PATCH. Before every write the comment must still be what the run last wrote; a write whose response is lost is verified by re-reading.
- Same HEAD, complete, same merge-base: reuse (no call, no count); a different merge-base is a different diff and is reviewed (and counted) again. Same HEAD, incomplete: resume while budget remains. New HEAD while incomplete: coverage restarts, attempts and findings carry over. HEAD change during an attempt: the attempt stays spent and its result is discarded.
- Budget per PR (never reset by rerun, HEAD change or tooling): 10 model executions, each at most 14 turns, 8 minutes and USD 0.50 (SDK nominal estimate, not a bill) -> worst case 140 turns, 80 minutes, USD 5.00 nominal (the previous delivery-v1 worst case was 2 x USD 2.50 = USD 5.00, 40 turns). One workflow run also stops after 6 attempts or 30 minutes; 4 consecutive attempts on one HEAD without progress stop that HEAD.

## One-time migration from schema_version 1

`scripts/migrate-v1.mjs` (workflow `migrate-v1.yml`, dry-run by default) rewrites the same comment in place: `completed_rounds` is `review_runs_used` only if v1 recorded complete coverage, else 0 (a case that cannot be determined is reported, not guessed); `attempts_used = review_runs_used`; findings are kept; progress starts empty. A document that is already v2 is left untouched. Before migration the runner refuses to treat a v1 document as state.
