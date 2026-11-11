# CRB-DESIGN-01 — Design Task Architecture Contract v0.3

**Status:** REVISED DRAFT. Independent DESIGN Gate **PENDING** for v0.3. v0.1 was DESIGN REWORK (D01–D03); v0.2 was never independently reviewed. Not approved for implementation.
**Target repository:** `Jiaze-Li/claude-review-bot`
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`
**Code baseline for the facts in §2 (read-only):** `b2ab063c` (`main` after PR #71). v0.2 used `179569d7`; the only change between them is the private-PR merge-base fetch in `review-v2.yml` and its test.
**Risk / gate:** Tier 3 / REQUIRED / PENDING.
**Immutable `design_ref`:** `git:Jiaze-Li/claude-review-bot@<commit-of-this-file>:docs/design-task-architecture-contract-v0.3.md`, assigned in the PR description after commit. A reviewer must verify the bytes at that ref.
**Previous versions:** v0.2 at `b8034c3d3b6de60334c6f567a206723ef7559d0a`, v0.1 at `d424d833de44fddcf1fd804baf5630ff0027ac56`, both under `docs/`.
**Authorship:** v0.1 and v0.2 were drafted in the user's GPT conversation. v0.3 was revised by a coding-agent session at the user's request. Whoever reviews v0.3 must be a separate context from both.

This document proposes a change. It does not approve itself, and it grants no implementation, merge, deployment or spending authority.

## 1. Purpose

Add a `design` task type to the existing review bot so that a task's contract documents can be independently reviewed on GitHub, and so that an agent can drive the revise-and-re-review loop without a person relaying messages. The existing `review` task type keeps its current behavior.

The workflow this serves, stated here so the contract is self-contained:

1. A person and a general AI agree on a short **brief**: goal, non-goals, decisions already made, what counts as done, and how far the work is authorized to go.
2. The AI commits the brief and the contract documents to a task branch and opens a draft PR.
3. `design` reviews the contract documents. An editing agent revises them and requests re-review until the verdict is pass, or the bot stops for a person.
4. Implementation and the existing `review` follow on the same PR.

Two properties follow from this and drive the changes in v0.3:

- **The loop may change the contract documents. It may not change the brief.** The brief records the person's decisions.
- **A stop for a person must mean a decision is needed.** A recoverable technical failure should not stop the loop.

### Non-goals

Free-form prompt commands. Any change to `review` commands, state, findings, threads, budgets or commit status. The reviewer editing contracts or code. A commit status, review threads or a GitHub PR review object for `design`. Contract files outside the target repository. Automatic `design` runs on PR events. Starting or waking the editing agent.

## 2. Verified baseline

Facts read at the baseline above. They describe the repository, not the deployed Cloudflare Worker.

| Fact | Location |
| --- | --- |
| A command is the first non-blank line of a new PR conversation comment. Unrecognized text is ignored. | `worker/src/review-trigger.js:4-35` |
| Automatic review runs on `opened`, `ready_for_review` and `reopened` only. A push does not trigger a review. | `worker/src/review-trigger.js:40-42` |
| A comment command requires the author to have `write`, `maintain` or `admin`. | `worker/src/index.js:119-127` |
| Draft PRs are skipped only for automatic triggers. Comment commands run on drafts. | `worker/src/index.js:131-133` |
| The Worker dispatches one workflow, `review-v2.yml`, with `target_repo`, `pr_number`, `base_sha`, `head_sha`, `trigger_user`, `source_comment_id`, `source_kind`, `requested_mode`. | `worker/src/index.js:145-175` |
| `review-v2.yml` is serialized per PR and does not cancel a running review. | `.github/workflows/review-v2.yml:89-93` |
| The workflow stops if the PR head differs from the dispatched `head_sha`. | `.github/workflows/review-v2.yml:228` |
| The review session is one bot-authored comment. An in-progress state is edited in place. A changed result is posted as a new comment and the old one deleted. | `scripts/session-comment.mjs:1-36` |
| Session state is base64url JSON in `<!-- jiaze-review-state:... -->`. | `scripts/review-session-core.mjs:929-935` |
| Review allows 2 verification rounds before `HUMAN_REQUIRED`. | `scripts/review-session-core.mjs:4` |
| The review commit status context is `claude-review-bot/review`. | `scripts/sync-commit-status.mjs:9` |
| The reviewer's file snapshot contains ordinary blobs only and excludes `CLAUDE.md` and `.claude/`. | `scripts/materialize-safe-tree.mjs:49,110-111` |

Not verified: the deployed Worker revision, and whether the App's installation token can read the private `Jiaze-Li/personal-skills`.

## 3. Commands and routing

| First non-blank line | Effect |
| --- | --- |
| `@gemini design` | Design review, Gemini first, Claude where Gemini cannot |
| `@claude design` | Design review, Claude only |
| `@jiaze-claude-review-bot reset design` | Discard the Design session's brief anchor, round count and findings. Spend is kept. No model call. |

All existing commands keep their current meaning and act on Review only. `reset review`, `override review`, `dismiss` and thread resolution never touch Design state.

The Worker routes the three commands above to a **separate workflow file** (`design.yml`). `review-v2.yml` is not modified, so its status writer and thread reconciler cannot run for a Design event. `design.yml` has its own concurrency group per PR and does not cancel a running Design. Design and Review share no state, so they are not serialized against each other.

The Worker and the provider adapters are shared. Review's session core is not generalized.

## 4. Manifest and input

### 4.1 Location

The manifest is `.reviewbot/tasks/<task_id>.json` at the PR head. `task_id` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and equals the file name.

On the first Design run for a PR, the host takes the files added or modified between the merge base and the head that match `.reviewbot/tasks/*.json`. Exactly one must exist. Later runs use the path recorded in the session.

A fixed single path was rejected: concurrent task PRs would conflict on it, and a merged manifest would remain on the default branch as a stale input for the next PR.

### 4.2 Schema

```json
{
  "schema_version": 1,
  "task_id": "EXAMPLE-01",
  "policy_sha": "<40 hex>",
  "files": [
    {"path": "docs/tasks/EXAMPLE-01/brief.md", "role": "brief"},
    {"path": "docs/tasks/EXAMPLE-01/spec.md", "role": "spec"},
    {"path": "docs/tasks/EXAMPLE-01/design.md", "role": "design"}
  ]
}
```

- `brief`: zero or one. The person's decisions. Frozen under §5.
- `spec`: zero or one. The contract handed to the implementing agent.
- `design`: zero or more. Architecture contracts.
- At least one `spec` or `design` is required. Unknown keys and roles are rejected.

Every path is an ordinary UTF-8 blob in the target repository at the PR head. Symlinks, submodules, paths outside the repository and URLs are rejected. Each file is at most 64 KiB, matching the limit ReviewLoop places on `contractText`, and the set is at most 256 KiB. Oversize input is rejected, never truncated. Both limits are proposed defaults.

The manifest and every listed file are **untrusted data** to the model. They are never placed in a system prompt and cannot widen tool access. The PR description is not an input.

### 4.3 Content identity

The **bundle identity** is the manifest's git blob SHA, each listed file's git blob SHA, and `policy_sha`. A verdict is bound to the bundle identity. The reviewed head SHA is recorded for audit.

A verdict is **current** when the bundle identity at the PR's present head equals the one in the session. A commit that changes no listed file and not the manifest leaves a pass current. This is what allows implementation commits to follow a pass on the same PR, and it makes any later edit to the contract detectable without a model call.

## 5. Brief freeze

When a Design run first passes input validation for a PR, the host records the brief's path and blob SHA in the session as the **brief anchor**. If the manifest has no brief, the anchor records that.

On every later run, a brief whose path or blob differs from the anchor, or a brief that was added or removed, produces `HUMAN_REQUIRED` with reason `BRIEF_CHANGED` before any model call.

`reset design` clears the anchor. The next Design run anchors the brief as it then stands. By workflow policy this command is for a person. The bot cannot distinguish a person from an agent using the same GitHub account.

The anchor proves the brief is unchanged since the first Design run. It does not prove a person read it.

## 6. Session, states and findings

### 6.1 One session comment

One bot-authored PR conversation comment holds the Design session, marked `<!-- jiaze-design-session:v1 -->`, with state in `<!-- jiaze-design-state:<base64url JSON> -->`. Its lifecycle follows the existing review session comment (§2).

A comment is a Design session only if its author is the App identity **and** it carries the Design marker. Design code reads, edits and deletes only such comments. Review code is unchanged and continues to match only its own marker.

**The session comment is the only Design decision.** A workflow result, a log or model output is not a verdict.

### 6.2 State

| Field | Meaning |
| --- | --- |
| `status` | One of the five values below |
| `reason` | Machine code for `DESIGN_BLOCKED` and `HUMAN_REQUIRED` |
| `taskId`, `manifestPath`, `policySha` | From the manifest |
| `bundle` | Manifest blob SHA and `{path, role, blob}` for each file |
| `reviewedHead` | PR head when the bundle was read |
| `briefAnchor` | `{path, blob}`, or a marker that the manifest has no brief |
| `round`, `maxRounds` | Completed evaluations and the limit |
| `findings` | `{id, severity, status, file, location, title}` |
| `spend` | Design-only Claude ledger in USD, and the cap |
| `inFlight` | `{sourceCommentId, reservedUsd, startedAt}` while a paid call is outstanding, else null |
| `processedSourceComments` | Comment IDs already handled |

| `status` | Meaning | What the editing agent does |
| --- | --- | --- |
| `DESIGN_IN_PROGRESS` | A run is active | Wait |
| `DESIGN_PASS` | No open blocking finding. Valid only while current (§4.3) | Continue |
| `DESIGN_REWORK` | Open blocking findings | Revise the contract documents, push, request review again |
| `DESIGN_BLOCKED` | No evaluation happened or none could be published. `reason` says why | Fix a mechanical cause such as a malformed manifest, or retry. Otherwise report |
| `HUMAN_REQUIRED` | A person must decide. Reasons: `BRIEF_CHANGED`, `ROUNDS_EXHAUSTED`, `BUDGET_EXHAUSTED` | Stop and report |

A missing, unreadable or non-current session is not a pass.

`USER WAIVED` remains a human record under the engineering policy. It is not a bot state, and `design` has no override or dismiss command in this version.

### 6.3 Rounds

A round is one evaluation that ends in `DESIGN_PASS` or `DESIGN_REWORK`. `maxRounds` is 3 (proposed). When the third evaluation ends with open blocking findings, the status is `HUMAN_REQUIRED` with `ROUNDS_EXHAUSTED` and the findings stay listed. `DESIGN_BLOCKED` does not consume a round.

`reset design` sets `round` to 0.

### 6.4 Findings

Severity follows the bot: P0, P1 and P2 block; P3 does not. At most 8 P3 items are listed.

A blocking finding must name the file and location, what it contradicts (a brief item, a stated invariant, another part of the contract, or a cited code fact), and the correction required. A finding that cannot do this is recorded as P3.

Every evaluation reads the whole current bundle and also rules on each previously open finding as fixed or still open. A pass requires all listed files read in full, no open blocking finding, and every earlier blocking finding ruled fixed.

Findings are listed in the session comment. There are no inline threads.

## 7. Run protocol

1. **Validate, no model call.**
   - Re-fetch the source comment by ID. It must exist on this PR, its current first non-blank line must be a Design command, and its author must have write access now.
   - The PR must be open and its head must equal the dispatched `head_sha`.
   - Locate and validate the manifest and files (§4). Compute the bundle identity.
   - Check the brief anchor (§5).
   - Read `engineering-reviewer/skill.md` at `policy_sha` (§9).
   - If the source comment is in `processedSourceComments`, stop without change.
   - If the session holds a pass or rework for this exact bundle identity, re-surface it and stop.
   - If `inFlight` is set, apply CRB-DEC-01 (§8).
   - Check `round` and remaining spend.

   Workflow inputs other than `target_repo`, `pr_number`, `source_comment_id` and `head_sha` carry no authority, and those four are checked against GitHub as above. A manually dispatched run can therefore only replay a real, authorized, unprocessed command.

2. **Reserve.** Write the session as `DESIGN_IN_PROGRESS` with `inFlight` set and the brief anchor recorded. If this write fails, stop before any model call.

3. **Evaluate.** Shared read-only provider execution. The model receives the full bytes of every listed file, the reviewer policy text, prior findings, and the existing sanitized read-only tools over the PR head snapshot. It receives no GitHub write token.

4. **Publish.** Recompute the bundle identity at the PR's present head.
   - Unchanged: write the verdict, findings, incremented `round`, settled spend and `inFlight: null`.
   - Changed: write `DESIGN_BLOCKED` with `INPUT_CHANGED`, settled spend and `inFlight: null`.

   Spend is settled with the provider-reported cost when available, otherwise with the full reservation.

## 8. Recorded decision CRB-DEC-01: an interrupted run is re-run automatically

**Decided by the user on 2026-11-11.** It replaces v0.2 §5A, the five-stage PREPARE / EVALUATE / VALIDATE / FINALIZE / MIRROR protocol, and changes how v0.1 finding D02 is resolved.

**Behavior.** A Design run that starts and finds `inFlight` set treats the earlier run as dead, because Design runs are serialized per PR. It adds the full `reservedUsd` to `spend`, clears `inFlight`, and continues planning normally. If budget remains, the bundle is evaluated again. No person is involved.

**What is accepted.** One interrupted run may pay for an evaluation whose result is lost and then pay again. The loss is at most one reservation, proposed at USD 2, per interruption, and total Claude spend per PR stays under the Design cap.

**What is not weakened.** A pass exists only as a session comment written in step 4 after the bundle identity is re-checked. An interruption at any point leaves either the previous state or `DESIGN_IN_PROGRESS`, never a pass.

**Why.** The v0.2 protocol avoided repeating a paid call by stopping for a person whenever a result might have been paid for but not stored. That turns a recoverable technical failure into a human stop, which defeats the purpose in §1, to save an amount the cap already bounds. It also added staging comments, a second validation pass and seven fault-injection points to build and maintain.

**This is intended behavior, not a defect.** The following must not be reported or "fixed" as bugs without a new decision from the user:

- A second paid evaluation of the same bundle after an interrupted run.
- Charging the full reservation for an interrupted run whose true cost is unknown.
- The absence of a stored intermediate result that would allow finishing without another model call.
- The absence of a human stop after an interrupted paid call.

**Implementation obligations.** The recovery branch carries a code comment citing `CRB-DEC-01` and this section. A test named for `CRB-DEC-01` asserts the behavior in AC8. The repository README section on Design states the trade-off in one sentence.

**Revisit when** the per-invocation reservation is raised above USD 5, an interrupted run is observed more than once in ten Design runs, or Design is offered to accounts other than the owner's.

## 9. Budget and policy access

**Budget.** Design has its own Claude ledger in the Design session, separate from Review's. Proposed limits: USD 2 reserved per evaluation, USD 6 per PR across all rounds, commands and resets. Both commands draw on it. A command does not raise the cap. Below the reservation amount, the status is `HUMAN_REQUIRED` with `BUDGET_EXHAUSTED`. Gemini uses the existing provider budget controls and is not charged to this ledger. Review's allowance and manual-call ceiling are unchanged.

These figures are proposals. They are not authority to spend.

**Policy access.** The reviewer policy is read from `Jiaze-Li/personal-skills` at the manifest's `policy_sha`, never from a branch. That repository is private and this one is public, so:

- The read uses a token scoped to contents-read on that one repository, separate from the target-repository token.
- Policy text and the contents of private target repositories are never written to Actions logs, job summaries or public comments.
- If the policy cannot be read, the status is `DESIGN_BLOCKED` with `POLICY_UNREADABLE`.

## 10. What the reviewer checks

1. **Fidelity to the brief**, when one exists. Nothing in the spec or design contradicts a decision or crosses a non-goal. Each item under "what counts as done" maps to an acceptance criterion. Nothing exceeds the stated authorization. Without a brief, the session comment says fidelity was not assessed.
2. **Soundness against the code.** Claims about existing behavior are checked in the snapshot. Authority, failure, retry and compatibility rules are coherent. Facts, proposals and unknowns are kept apart.
3. **Executability of the spec.** Acceptance criteria are observable and verifiable, and authorizations are explicit.

The reviewer does not rewrite the contract and does not decide product questions. A pass says nothing about whether code exists, passes tests, is merged or is deployed.

## 11. Acceptance criteria

| ID | Requirement | Minimum evidence |
| --- | --- | --- |
| AC1 | Review is unchanged | Existing suite passes with `review-v2.yml` and Review scripts byte-identical except shared helpers proven equivalent; one live Review PR lifecycle |
| AC2 | Task isolation | On one PR with both task types in both orders, Design writes no Review session, thread, PR review or commit status, and Review commands change no Design state |
| AC3 | Authorization | Non-writer author, comment edited so the command is gone, comment on another PR, manual dispatch with invented inputs, and head mismatch each produce no model call |
| AC4 | Manifest validation | Zero or several manifests in the diff, malformed schema, unknown role, missing file, symlink, submodule and oversize input each produce `DESIGN_BLOCKED` and no model call |
| AC5 | Brief freeze | Changing, adding or removing the brief after the anchor gives `HUMAN_REQUIRED / BRIEF_CHANGED` with no model call. `reset design` re-anchors, zeroes `round` and keeps `spend` |
| AC6 | Verdict binding | After a pass, a commit touching no listed file leaves it current. A commit changing a listed file or the manifest makes it non-current. A new command on an unchanged bundle makes no model call |
| AC7 | Loop | Seeded contradiction gives rework. A fix gives a full re-review that rules the old finding fixed and passes. Three reworks give `HUMAN_REQUIRED / ROUNDS_EXHAUSTED` |
| AC8 | CRB-DEC-01 | Kill a run after the reservation write. The next command charges the full reservation, clears `inFlight`, evaluates and publishes without a person. No pass is visible in between. At the cap the status is `HUMAN_REQUIRED / BUDGET_EXHAUSTED`. Review's ledger is unchanged throughout |
| AC9 | Machine-readable result | A script decodes the state and selects the action in §6.2 for every status without reading prose |
| AC10 | Privacy | With a private policy repository and a private target, no policy text or file content appears in logs, summaries or comments on public surfaces |

Evidence must separate tests run, CI logs, model claims and observations on a real PR. A live test must confirm the deployed Worker revision.

## 12. Stages

- **S1 Gate.** Independent review of this document at its `design_ref`. No implementation before a pass, or a valid explicit waiver with no unresolved substantive blocker.
- **S2 Routing and validation, no model call.** Commands, `design.yml`, manifest discovery and validation, brief anchor, session comment with `DESIGN_BLOCKED` and `HUMAN_REQUIRED` paths. AC1 to AC5.
- **S3 Evaluation.** Provider call, findings, rounds, spend, CRB-DEC-01 recovery. AC6 to AC10 with providers stubbed.
- **S4 Live.** Only with separate authorization to deploy and to spend. One rework-to-pass loop and one Review lifecycle on real PRs.

## 13. Changes from v0.2

| v0.2 | v0.3 | Reason |
| --- | --- | --- |
| Manifest at the fixed path `.reviewbot/design-task.json` | One file per task under `.reviewbot/tasks/` | Concurrent PRs; stale manifest after merge |
| All contract files treated alike | `brief`, `spec`, `design` roles; brief frozen | The loop must not change the person's decisions |
| Architecture contracts only | The spec is reviewed too | Nobody else reads the spec before it is executed |
| Verdict bound to the PR head | Verdict bound to bundle content | Implementation commits follow on the same PR |
| Prose lifecycle, no round limit | Five states, reason codes, three rounds | An agent must be able to act on the result |
| §5A five-stage publication | Reserve, evaluate, publish; CRB-DEC-01 | User decision, §8 |
| Webhook envelope with comment body hash, validated twice | Source comment and head re-fetched once before the model call; bundle identity re-checked at publish | Same protection against forged dispatch and moved input with less state |
| Optional `claude-review-bot/design` commit status | None | The session comment is the single decision |
| Either a separate workflow or gates inside `review-v2.yml` | Separate workflow | Review's finalizers cannot run |
| External contract and evidence refs | Target repository only | Removes cross-repository reads other than the policy |

### Response to v0.1 findings

- **D01, invocation authority (P1).** Kept in substance: the manifest is read from the PR head, the PR description has no authority, and a run re-derives its authority from the source comment on GitHub (§7 step 1).
- **D02, failure-atomic publication (P1).** Resolved differently, under CRB-DEC-01. The safety property is kept: no pass without a published, re-checked session comment. The cost property is relaxed by decision: a repeat paid call is allowed within the cap.
- **D03, cost and retry (P2).** Kept: separate ledger, reservation before the call, conservative settlement, replay and same-bundle short circuits (§7, §9).

The v0.1 review text was not available when v0.3 was written. The reviewer should check these responses against the original findings.

## 14. Open items

- **Policy access.** Whether the App can mint a contents-read token for `personal-skills`, and whether the user authorizes it.
- **Proposed numbers.** Three rounds, USD 2 and USD 6, 64 KiB and 256 KiB need the user's confirmation before S3.
- **Agent identity.** While the editing agent uses the user's GitHub account, `reset design` is restricted to a person by policy text only.
- **Deployment parity.** The deployed Worker revision is unverified.
- **Authorization for this PR.** The user authorized documentation-only changes to this contract PR. Not authorized: implementation, merge, deployment, paid Design runs, credential or App permission changes, branch protection changes.
