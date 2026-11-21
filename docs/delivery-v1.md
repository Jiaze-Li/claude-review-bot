# Delivery v1: two-run review with a single result contract

An **opt-in** review mode for personal projects. The first review runs once; the author then fixes everything in
one batch and pushes once; a second review verifies those fixes. After that the bot stops. PRs that do not opt in
keep the existing review path unchanged.

## How a PR enters and moves through the mode

1. Open the PR as a **Draft** (no model is spent on a Draft).
2. Add the `delivery-v1` label and confirm it is there.
3. Mark the PR **Ready**. The first review starts. (Adding the label to an already-Ready PR also starts it.)
4. Result `CHANGES_REQUESTED`: fix all P0/P1/P2 items together, run your local checks, push **once**. The push asks
   for the second (final) review of the new HEAD.
5. Result `READY` (no unresolved P0/P1/P2 and full coverage) or `STOPPED` (anything else, or both runs used).

The mode is **fixed** once the bot has written its state comment. Removing the label, `reset review`, `override`,
`dismiss`, thread resolve/reopen, reopening, a different provider command, or re-running a workflow cannot return
the PR to the legacy path or reset its budget. Commands such as `@claude review` still work as "make sure the
current HEAD has a result"; they are treated exactly like a push.

A PR that already has a legacy review session is **not migrated**: the bot refuses (commit status `error`, "PR
already has a legacy review session") and writes no delivery state. Remove the label to keep using the legacy
review, or open a new PR.

## The single state: one bot comment

The GitHub App `jiaze-claude-review-bot[bot]` creates one comment and PATCHes that same comment forever. It begins
with `<!-- agent-delivery:v1 -->` followed by a strict JSON code block; the visible text is generated from the JSON.

```json
{
  "schema_version": 1, "mode": "delivery-v1", "repo": "owner/repo", "pr_number": 123,
  "reviewed_head_sha": "<full SHA>", "status": "IN_PROGRESS | CHANGES_REQUESTED | READY | STOPPED",
  "reason": "...", "review_runs_used": 1, "review_runs_limit": 2, "coverage_complete": true,
  "findings": [{ "id": "F001", "severity": "P1", "path": "src/a.js", "failure_path": "...", "verification": "OPEN" }]
}
```

(`status` takes exactly one of the four values.) Optional internal fields: `claimed_at`, `updated_at`, finding `title`.

* Trust comes from the comment's **author identity and type as returned by the GitHub API** (the App, type `Bot`),
  never from what the body claims. Ordinary users' lookalike comments are ignored.
* Comments are read completely (paginated). A failed or incomplete read is an error, never "no state".
* More than one bot state comment, or one that fails schema/repo/PR checks, stops the review; the bot never guesses
  "the last one".
* The commit status `claude-review-bot/review` is only a projection (`READY`=success, `CHANGES_REQUESTED`=failure,
  `IN_PROGRESS`=pending, `STOPPED`=error). Nothing local writes it.

**Known limitation:** an administrator who deletes or edits this comment can reset the budget. There is deliberately
no signature, database or append-only ledger to prevent that.

## Budget rules

* At most **two** model-bearing runs per PR, counted in `review_runs_used` in the state comment and nowhere else.
  All entry points (Ready, push, label, comments, workflow re-run) share it.
* A slot is taken only when a model run is about to start, and the incremented count is **persisted before** the
  model is called. Failure, timeout or a crash never refunds it. If persisting fails, no model is called.
* Reuse is decided first: same HEAD with a result (`READY`, `CHANGES_REQUESTED`, `STOPPED`) is reused with no model
  and no change. A queued event whose HEAD is no longer the PR's HEAD is skipped before the model.
* A request that truly needs a model but has no run left is recorded as `STOPPED` (reason says why). There is no
  automatic extra audit and no manual bypass.
* A run left `IN_PROGRESS` longer than 45 minutes is recognised as interrupted: it becomes `STOPPED`, keeps its slot,
  and is never reset to zero. (No daemon: it is noticed by the next event.)
* If the HEAD changes while a run is in flight, the result is stored against the HEAD it reviewed as `STOPPED`
  ("not a pass for the current commit"); the new HEAD's own event uses the remaining run, if any.

## What the reviewer decides

* Run 1: only P3 / no findings and full coverage -> `READY`; any unresolved P0/P1/P2 -> `CHANGES_REQUESTED`.
  No blockers but incomplete coverage -> `STOPPED`.
* Run 2: every run-1 P0/P1/P2 is verified individually (`FIXED`, `STILL_OPEN`, `UNCERTAIN`) and the fix is checked
  for substantive regressions. An omitted blocker counts as `UNCERTAIN`, never `FIXED`. Any remaining or new
  P0/P1/P2, any `UNCERTAIN`, or incomplete coverage -> `STOPPED`; otherwise `READY`.
* P3 is advice and never blocks. A P0-P2 without a concrete failure path (>= 30 characters) is demoted to P3.
* The reviewer gets the exact-HEAD safe source snapshot with read-only Read/Glob/Grep, plus the PR title and
  description (goal, constraints, observable acceptance, local acceptance notes) as untrusted requirement text.
  It does **not** run tests and the bot never says it did; local testing stays with the author.
* Corrupt model output, uncovered files, provider failure, a crash, or an unsaved result can never produce `READY`.

## What is actually enforced (and what is not)

Per run, with one provider chosen by `DELIVERY_PROVIDER` (default `claude`; a list is rejected: no fallback, no
parallel voting):

| Limit | Default | Variable | Enforced by |
| --- | --- | --- | --- |
| Agent turns | 20 | `DELIVERY_MAX_TURNS` | provider adapter `maxTurns`; tool gateway call cap = 4 x turns |
| Wall clock | 15 min | `DELIVERY_TIMEOUT_MS` | adapter timeout; workflow job timeout 25 min |
| Single-run spend | $2.50 | `DELIVERY_MAX_BUDGET_USD` | Claude adapter `maxBudgetUsd` |
| Tool reads | gateway defaults | n/a | `ReadOnlyToolGateway` byte/call quotas |

Not enforced: an exact token cap, and an exact money cap for the PR. "Two runs" is not "two API requests": one run
is a multi-turn agent session. Cost figures reported by Claude are nominal; with `CLAUDE_CODE_OAUTH_TOKEN`
(a Claude subscription) they are not a cash charge, whereas `GEMINI_API_KEY` is real metered API spend. Do not add
the two together. This repository does not know about AGY or any local subscription of the coding agent that writes
the code.

## Secrets, variables, permissions

No new secrets and no new App permissions. Names only:

* Secrets: `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY` (only if `DELIVERY_PROVIDER=gemini`),
  Cloudflare deploy secrets (unchanged).
* Variables: `APP_ID`, `REQUIRE_STATUS_CHECK` (existing); optional `DELIVERY_PROVIDER`, `DELIVERY_MAX_TURNS`,
  `DELIVERY_MAX_BUDGET_USD`, `DELIVERY_TIMEOUT_MS`.
* App permissions used: contents read, pull requests write, issues read, commit statuses write (as before); the
  legacy gate job uses pull requests read and issues read. The webhook must deliver `pull_request` events including
  `labeled` (already part of the `pull_request` event subscription).

## Pausing the mode while keeping the legacy path

* Stop new opt-ins: do not add the label, and disable the `Delivery v1 Review` workflow in the Actions tab.
  Existing delivery PRs then get no new result (their last comment/status stays) and the legacy path never touches
  them.
* Roll back the code: revert the PR. PRs without the label never depended on it.

## Compatibility with agent-delivery

`npm run delivery:fixtures -- --out /absolute/path/delivery-fixtures.json` writes cases generated by the real
policy and serializer; `npm run test:compat [-- --in file]` evaluates them with the same parser/trust/decision code
the bot uses (`evaluateDeliveryComment`). Missing or only-forged comments evaluate to `trusted:false, WAIT`;
corrupt, foreign-repo/PR or self-contradicting state to `trusted:false, STOPPED`; stale or in-progress to `WAIT`.

## Known limitations

* The state comment can be deleted by an admin (see above).
* Interrupted runs are noticed by the next event, not by a watchdog.
* A very large PR will report incomplete coverage rather than shard (this mode has one bounded run, no sharding).
* The first real model run and the Worker deployment have not been exercised by this change; they happen only after
  merge and deploy.
