# Plan: Drop the old-format compatibility from the review workflow

Stage: Plan (no code yet). Owner decision: Jack, 2026-11-19.

## Goal
A pull request that only has the old hidden review state and no readable review records is treated as a brand-new
pull request and reviewed from scratch. The path that converted old hidden state into readable records is removed.

## Scope
- Remove the import path, the old-format reader that only it used, and the tests that only covered it.
- The old comment may be replaced or lost; the history of the one remaining old PR (SpinLab #220) may be discarded.
  The bot does not go out of its way to delete anything.

## Must hold
- Pull requests that already use the readable records behave exactly as before: edited or collapsed records stop the
  run, an incomplete read stops the run, the Seq/Prev chain is enforced.
- The test that guards "every review step that reads the ledger names the bot account" stays.
- Budget, model, permissions and interface are untouched.

## Acceptance
1. A PR holding only an old hidden-state comment is treated as new: no error, no stall, a full review runs.
2. All existing tests pass; only tests that covered the import itself are removed.
3. The workflow-configuration guard test is kept and passes.
4. Real check on SpinLab #220 after merge: NOT RUN until Jack triggers a review there.

## Out of scope
Merging and deploying (separate authorization), changing budgets, permissions or the interface.

## Risks
Any other repository with an open old-format PR is reviewed again from scratch once (one review's spend).
