# Plan: Drop all old-format compatibility from the review workflow

Stage: Plan (no code yet). Owner decision: Jack, 2026-11-19.

## Goal
One rule: anything from the old review logic is ignored. A pull request with old review records (old hidden-state
comments, or records from an earlier import) is treated as a brand-new pull request and reviewed from scratch with
the current logic. Its old findings and resolved states are discarded, not carried over.

## Scope
- Remove the import path, the old-format reader, the "import" stage, and the tests that only covered them.
- Old hidden-state comments are ignored in every case: readable, unreadable, or without state. None of them stops a run.
- Records from an earlier import are ignored the same way.
- The commit-status sync and the stale-review sweep stop reading old sessions; with no readable records they see
  "no session yet".
- The bot does not go out of its way to delete old comments.

## Must hold
- Pull requests that already carry current readable records behave exactly as before: edited or collapsed records stop
  the run, an incomplete read stops the run, the Seq/Prev chain is enforced. Old-format content is the only thing
  that is ignored; damaged current-format records are still refused.
- The test that guards "every review step that reads the ledger names the bot account" stays.
- Budget, model, permissions and interface are untouched.

## Acceptance
1. A PR holding only old-format content (readable, unreadable, or stateless old comment; or earlier import records)
   is treated as new: no error, no stall, a full review runs.
2. Commit-status sync and the stale sweep on such a PR report "no session" instead of failing or reading old state.
3. A PR with damaged current-format records still stops the run.
4. All existing tests pass; only tests that covered the import or old format are removed.
5. The workflow-configuration guard test is kept and passes.
6. Real check on SpinLab #220 after merge: NOT RUN until Jack triggers a review there.

## Out of scope
Merging and deploying (separate authorization), changing budgets, permissions or the interface.

## Risks
- Every open PR with old-format records is reviewed again from scratch once (one review's spend each).
- Old findings and their resolved states are lost, so a previously handled issue may be reported again.
