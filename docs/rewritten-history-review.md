# Review after a PR's history is rewritten

A *verification* normally diffs the last reviewed HEAD against the new HEAD. After a rebase, force-push, a merge of the
target branch into the PR branch, or a changed base, that diff contains unrelated history (it can exceed the staged
limit even for a small PR).

The planner (`scripts/plan-review-session.mjs`, `resolveVerificationScope`) therefore classifies each verification with
read-only GitHub `compare` calls:

| Situation | Result |
|---|---|
| old HEAD is an ancestor **and** the PR's merge base is unchanged | ordinary fix: unchanged two-point diff |
| diverged / behind, old commit unreachable (404/422), or merge base changed | history rewritten |
| any other API error, or a missing merge base | the planning step fails (no model cost, safe to retry); it never falls back to the ordinary diff |

When rewritten:

* **Whole current PR fits one staged review** (same rule as the staged runner, `stagedReviewCapacity`): the verification
  runs on `.review-context/pr.diff` (PR vs. its target branch). Findings close only on an explicit `FIXED`; the usual
  2-round verification budget applies.
* **Too large**: a sharded full review runs instead and the old blocking OPEN findings are carried as `UNCERTAIN`
  (`origin: CARRIED_OPEN`, `carriedFromId`). The result is `HUMAN_REQUIRED` until a person dismisses them. More than 8
  blocking findings stops at `human_required` without a model call (nothing is truncated). `dismiss` is not available
  there (the session still points at the old HEAD); a writer uses `reset review` (review from scratch, old findings
  are not kept) or `override review` (accept the risk).
