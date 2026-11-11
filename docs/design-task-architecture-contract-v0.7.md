# CRB-DESIGN-01 — Design Task Architecture Contract v0.7

**Status:** v0.6 received an independent **DESIGN PASS** on 2026-11-11, bound to blob `40b9823aa2d00282cf78d43b69fb45a55560dc0c`. v0.7 is v0.6 plus one correction to the decision function and one wording fix, both listed in §14. That pass does not cover the changed text. v0.7 has had no full independent review; whether to require one or to waive it is the user's decision and is recorded in the description of PR #70. Not approved for implementation by this document.
**Target repository:** `Jiaze-Li/claude-review-bot`
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`
**Code baseline for the facts in §3 (read-only):** `b2ab0631ac0ef4192c2b6956ea100a8e3ca17047`, the merge of PR #71 on `main`.
**Risk / gate:** Tier 3 / REQUIRED / PENDING, as classified by the Engineering Lead for v0.1. v0.5 narrowed the scope (§2); re-classification is the Lead's decision, not this document's.
**Immutable `design_ref`:** `git:Jiaze-Li/claude-review-bot@<commit-of-this-file>:docs/design-task-architecture-contract-v0.7.md`, assigned in the PR description after commit.
**Previous versions:** v0.6 at `62a15fab1c23c6b3f49bf2cda90bc529c2550300`, v0.5 at `5402aeca88697a94cf9ded791f1ba00ef61b4722`, v0.4 at `7c6b8c80e752f1f8e34e710cbf68b442baeda587`, v0.3 at `99682892968a76e0b47a9b44afcd97af377cabb7`, v0.2 at `b8034c3d3b6de60334c6f567a206723ef7559d0a`, v0.1 at `d424d833de44fddcf1fd804baf5630ff0027ac56`, all under `docs/`.
**Authorship:** v0.1 and v0.2 were drafted in the user's GPT conversation. v0.3 to v0.7 were revised by a coding-agent session at the user's request. Whoever reviews v0.7 must be a separate context from both.

This document proposes a change. It does not approve itself, and it grants no implementation, merge, deployment, credential or spending authority.

## 1. Purpose

Add a `design` task type to the review bot so that a task's contract documents can be independently reviewed on GitHub, and so that an agent can drive the revise-and-re-review loop without a person relaying messages. The existing `review` task type keeps its current behavior.

The workflow this serves:

1. A person and a general AI agree on a short **brief**: goal, non-goals, decisions already made, what counts as done, and how far the work is authorized to go.
2. The AI commits the brief and the contract documents to a task branch and opens a draft PR.
3. `design` reviews the contract documents. An editing agent revises them and requests re-review until the verdict is pass, or the bot stops for a person.
4. Implementation and the existing `review` follow on the same PR.

### Non-goals

Free-form prompt commands. Any change to `review` commands, state, findings, threads, budgets or commit status. The reviewer editing contracts or code. A commit status, review threads or a PR review object for `design`. Contract files outside the target repository. `design` runs triggered by PR events. A `workflow_call` entry point for `design`. Starting or waking the editing agent. Use by anyone other than the owner (§2).

## 2. Scope and trust: recorded decision CRB-DEC-04

**Decided by the user on 2026-11-11.** v0.1 to v0.4 never stated who the design defends against, and each review round therefore assumed the strongest adversary. v0.5 states it.

**Scope.** One owner, using the bot on the owner's own repositories.

**Trusted.**
- The owner, and any account with write access to this control repository or its secrets.
- Any account with write access to a target repository. Today that is the owner only.
- An editing agent that acts through the owner's GitHub account. The bot cannot tell it from the owner.

**Not trusted.**
- Accounts without write access to the target repository. They cannot start a run (§3 row 2).
- Model output.
- The content of contract files, as instructions. They are data to the model (§5.2).

**Nothing is confidential.** The control repository is public. The policy repository is public. Contract files have the visibility of their own repository.

**Consequently, intended and not defects.** These must not be reported or "fixed" as bugs without a new decision from the user:
- Dispatch inputs are unsigned, as they are for Review today. A manual dispatch by an account with write access to the control repository is accepted.
- `policy_sha` is taken from the manifest with no further authority check.
- There is no confidentiality control on the reviewer policy or on model output.
- `reset design`, and deleting the session comment, are available to any account with write access, including an agent on the owner's account.

**What the design still defends against** is accident, not attack: Review mistaking a Design comment for its own (§6.1), an old pass being read as current (§6.3), the loop editing the brief unnoticed (§7), and runaway model spend (§9).

**Revisit when** another person gains write access to the control repository or to a target repository where Design is used, the bot is offered to other accounts, or the policy repository becomes private again. The v0.4 contract holds a design for the stronger model: signed dispatch envelope, policy authority, output confidentiality.

## 3. Verified baseline

Facts read at the baseline SHA above. They are source facts, not evidence about the deployed Cloudflare Worker.

| # | Fact | Location |
| --- | --- | --- |
| 1 | Only a newly created PR conversation comment is considered, and a command is its first non-blank line. | `worker/src/index.js:58-60`, `worker/src/review-trigger.js:4-35` |
| 2 | A comment command requires the author to have `write`, `maintain` or `admin`. | `worker/src/index.js:119-127` |
| 3 | Comment commands run on draft PRs. Triggers with `sourceKind: pull_request` do not. | `worker/src/review-trigger.js:59-66`, `worker/src/index.js:131-133` |
| 4 | The Worker dispatches one workflow, by default `review-v2.yml`, with `target_repo`, `pr_number`, `base_sha`, `head_sha`, `trigger_user`, `source_comment_id`, `source_kind`, `requested_mode`. The inputs are not signed. | `worker/src/index.js:145-175` |
| 5 | `review-v2.yml` is serialized per PR, does not cancel a running review, and keeps pending runs rather than replacing them (`queue: max`). Its job has a 30-minute timeout. | `.github/workflows/review-v2.yml:89-95,104` |
| 6 | The workflow stops if the PR base or head differs from the dispatched SHAs. | `.github/workflows/review-v2.yml:224-228` |
| 7 | The review session writer edits an in-progress state in place, posts a changed result as a new comment and deletes the old one on a best-effort basis. It mutates by the supplied comment ID without re-checking ownership. | `scripts/session-comment.mjs:20-36` |
| 8 | Review selects its session as the newest comment whose author is the App identity and whose body **contains** `<!-- jiaze-review-session:v1 -->` anywhere. The planner treats an unreadable match as a hard error; the status sync returns nothing for it. | `scripts/plan-review-session.mjs:24-36`, `scripts/sync-commit-status.mjs:65-82` |
| 9 | Session state is base64url JSON in `<!-- jiaze-review-state:... -->`. | `scripts/review-session-core.mjs:898-943` |
| 10 | The reviewer's file snapshot contains ordinary blobs only and excludes `CLAUDE.md` and `.claude/`. | `scripts/materialize-safe-tree.mjs:44-53,107-113` |
| 11 | The shared budget manager settles a call at the provider-reported cost with no upper bound; otherwise at a caller-supplied fallback cost; otherwise at the reservation. | `scripts/review-orchestrator.mjs:161-175` |
| 12 | The Claude adapter passes `maxBudgetUsd` and a turn limit to the SDK. Claude runs on a subscription OAuth token. | `scripts/provider-adapter.mjs:1173,1285-1286`, `README.md:79` |

Not verified: the deployed Worker revision; how strictly the SDK enforces `maxBudgetUsd`.

## 4. Commands and routing

| First non-blank line | Effect |
| --- | --- |
| `@gemini design` | Design review, Gemini first, Claude where Gemini cannot |
| `@claude design` | Design review, Claude only |
| `@jiaze-claude-review-bot reset design` | Clear the brief anchor, round count and findings. Spend and processed-command history are kept. No model call. |

All existing commands keep their current meaning and act on Review only.

The Worker routes the three commands to a **separate workflow file**, `design.yml`, with the same kind of inputs Review receives (§3 row 4) and a `workflow_dispatch` trigger only. `review-v2.yml` is not modified.

**All Design runs share one concurrency group.** `design.yml` uses a single group for every target repository and PR, does not cancel a running Design, and keeps pending runs with `queue: max`, as Review does per PR (§3 row 5). GitHub keeps at most 100 pending runs in a group; a run cancelled while pending has written nothing and is not an evaluation. At most one Design run executes at a time, anywhere. Its job has a 20-minute timeout (proposed). With one owner, Design runs are rare and waiting behind another PR's run is acceptable; in exchange, per-PR ordering and the daily lock (§9) need no further coordination.

The token `design.yml` uses on the target repository has contents-read and pull-requests-write. It has no statuses permission. Pull-requests-write would also allow review objects and threads; Design not touching them rests on `design.yml` invoking none of that code (§6.1), not on the token.

## 5. Manifest and input

### 5.1 Location

The manifest is `.reviewbot/tasks/<task_id>.json` at the dispatched head. `task_id` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and equals the file name.

On the first Design run for a PR, the host takes the files added or modified between the merge base and the head that match `.reviewbot/tasks/*.json`. Exactly one must exist. Later runs use the path recorded in the session.

### 5.2 Schema

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

- `brief`: zero or one. The person's decisions.
- `spec`: zero or one. The contract handed to the implementing agent.
- `design`: zero or more. Architecture contracts.
- At least one `spec` or `design` is required. Unknown keys and roles are rejected.

Every path is an ordinary UTF-8 blob in the target repository at the head. Symlinks, submodules, paths outside the repository and URLs are rejected. Each file is at most 64 KiB, matching the limit ReviewLoop places on `contractText`, and the set is at most 256 KiB. Oversize input is rejected, never truncated. Both limits are proposed.

The manifest and listed files are data to the model. They are never placed in a system prompt and cannot widen tool access. The PR description is not an input.

### 5.3 Reviewer policy

The host reads `engineering-reviewer/skill.md` from the configured policy repository, `Jiaze-Li/personal-skills`, at the manifest's `policy_sha`. If it cannot be read, the status is `DESIGN_BLOCKED / POLICY_UNREADABLE`.

### 5.4 Bundle identity

The **bundle identity** is the manifest's git blob SHA, each listed file's git blob SHA, and `policy_sha`. A verdict is bound to the bundle identity. The reviewed head is recorded for audit.

A verdict is **current at a commit** when the bundle identity computed at that commit equals the one in the session. A commit that changes no listed file and not the manifest leaves a pass current. A Design pass approves the documents. It says nothing about code committed afterwards.

## 6. Session, states and findings

### 6.1 Isolation from Review

Review selects its session by author plus a marker substring anywhere in the body (§3 row 8), and Design comments have the same author. Three rules keep them apart. The v0.4 review judged these rules sufficient at design level.

**ISO-1, body construction.** The host builds every Design comment body. It starts with `<!-- jiaze-design-session:v1 -->` and contains one `<!-- jiaze-design-state:<base64url JSON> -->`. Every string that originates from the model, the manifest, a path, file content or an error is HTML-escaped. Before any write the host asserts that each Design marker occurs exactly once and that `jiaze-review-session` and `jiaze-review-state` occur nowhere in the body, including inside the encoded state. On a failed assertion nothing from that body is published and the status is `DESIGN_BLOCKED / OUTPUT_REJECTED`, written from fixed text.

**ISO-2, discovery.** A comment is the Design session only if its author is the App identity, its body starts with the Design marker, it contains no Review marker, its state decodes, and the decoded repository and PR match. The newest such comment is used. If the newest comment by author and Design marker fails the remaining checks, the run stops without a model call and without mutating it.

**ISO-3, mutation.** Design has its own comment writer. Immediately before every PATCH or DELETE it re-fetches the comment by ID and verifies the ISO-2 conditions plus the `taskId` and `revision` loaded at the start of the run. On a mismatch it does not mutate and stops. `design.yml` invokes no Review session writer, thread reconciler, PR-review publisher or status writer.

**The Design session comment is the only Design decision.**

### 6.2 State

| Field | Meaning |
| --- | --- |
| `status`, `reason` | A status below and a machine reason code |
| `repo`, `pr`, `taskId`, `manifestPath`, `revision` | Identity; `revision` increments on every write |
| `bundle`, `reviewedHead` | Bundle identity of the verdict, and the PR head the run that wrote this state was looking at. `reviewedHead` is set on every write, including `DESIGN_BLOCKED` |
| `briefAnchor` | Set at the first validated run; cleared by `reset design` |
| `round`, `maxRounds` | Completed evaluations and the limit |
| `findings` | `{id, severity, status, file, location, title, detail}` |
| `spend` | Design-only Claude ledger: recorded USD, cap, last call's cost |
| `runStartedAt` | Set when a run writes `DESIGN_IN_PROGRESS` |
| `inFlight` | `{sourceCommentId, chargedUsd}` while the run's one Claude call is outstanding, else null |
| `processedSourceComments` | Comment IDs already handled; kept across `reset design` |

| `status` | Meaning | Reason codes |
| --- | --- | --- |
| `DESIGN_IN_PROGRESS` | A run is active | — |
| `DESIGN_PASS` | No open blocking finding for the recorded bundle | — |
| `DESIGN_REWORK` | Open blocking findings for the recorded bundle | — |
| `DESIGN_BLOCKED` | No evaluation happened or none could be published | `MANIFEST_INVALID`, `INPUT_INVALID`, `POLICY_UNREADABLE`, `PROVIDER_UNAVAILABLE`, `INPUT_CHANGED`, `OUTPUT_REJECTED` |
| `HUMAN_REQUIRED` | A person must decide | `BRIEF_CHANGED`, `ROUNDS_EXHAUSTED`, `BUDGET_EXHAUSTED`, `DAILY_LIMIT` |

`USER WAIVED` remains a human record under the engineering policy. It is not a bot state.

### 6.3 Consuming the result

**A status alone never authorizes continuing.** An earlier `DESIGN_PASS` can stay visible after the documents change.

The only sanctioned way to act on a Design result is the decision function, shipped as `scripts/design-status.mjs`:

1. Read the PR head, `H`.
2. Select the session by ISO-2. Where the table below needs it, compute the bundle identity at `H` from the session's `manifestPath`.
3. Read the PR head again. If it is no longer `H`, start over, at most three times, then return `stop`.
4. Return `{action, head: H, bundle}`.

| Condition | `action` |
| --- | --- |
| Reading the PR or its comments fails, or the newest Design comment fails ISO-2 | `stop` |
| No Design session exists | `request_review` |
| Status is `DESIGN_IN_PROGRESS` and `runStartedAt` is less than 30 minutes ago | `wait` |
| Status is `DESIGN_IN_PROGRESS` and `runStartedAt` is 30 minutes ago or more | `request_review` |
| Status is `HUMAN_REQUIRED` | `stop` |
| Status is `DESIGN_BLOCKED` and `H` differs from the session's `reviewedHead` | `request_review` |
| Status is `DESIGN_BLOCKED` at `H`, reason `MANIFEST_INVALID` or `INPUT_INVALID` | `fix_input` |
| Status is `DESIGN_BLOCKED` at `H`, any other reason | `retry` |
| Status is `DESIGN_REWORK` or `DESIGN_PASS`, and the bundle identity at `H` differs from the session's or cannot be computed | `request_review` |
| Status is `DESIGN_REWORK`, identity equal | `revise` |
| Status is `DESIGN_PASS`, identity equal | `continue` |

The rows are evaluated in order. What each action asks of the consumer:

- `wait`: call again later.
- `request_review`: post the Design command.
- `fix_input`: correct the manifest or the listed files, push, then post the Design command.
- `retry`: nothing in the repository needs to change. Post the Design command again, at most twice for the same head and with a pause between attempts; if the result is still `retry`, stop and report.
- `revise`: change the contract documents to address the open findings, push, then post the Design command.
- `stop`: report to the person.
- `continue`: see below.

**What `continue` authorizes.** Exactly this: the listed documents as they are at commit `H` passed. The result is a statement about `H`, not about the branch. A consumer bases its work on `H`, and calls the function again before relying on the pass at any later commit, in particular before it hands the task on.

**Abandoned runs.** A run that is killed after writing `DESIGN_IN_PROGRESS` leaves that status behind, and nothing dispatches a successor by itself. The job timeout is 20 minutes, so a status still in progress after 30 minutes belongs to a dead run. The decision function then returns `request_review`. The consumer, which is the editing agent in the automated loop, posts the Design command again. That run settles the abandoned charge first and evaluates (§8, CRB-DEC-01). No person relays anything. Two evaluations cannot overlap, because Design runs execute one at a time (§4).

A PR head can change at any time, so no check can promise the branch will not move afterwards. Binding the answer to `H` makes that harmless: an answer about `H` stays true, and it does not cover a later commit.

### 6.4 Rounds and findings

A round is one evaluation ending in `DESIGN_PASS` or `DESIGN_REWORK`. `maxRounds` is 3 (proposed). A third evaluation with open blocking findings gives `HUMAN_REQUIRED / ROUNDS_EXHAUSTED`. `DESIGN_BLOCKED` consumes no round. `reset design` sets `round` to 0.

P0, P1 and P2 block; P3 does not, and at most 8 are listed. A blocking finding must name the file and location, what it contradicts (a brief item, a stated invariant, another part of the contract, or a cited code fact) and the correction required; otherwise it is recorded as P3.

Every evaluation reads the whole current bundle and rules on each previously open finding. A pass requires all listed files read in full, no open blocking finding, and every earlier blocking finding ruled fixed. Model output must validate against a JSON schema with bounded field lengths. Findings are listed in the session comment.

## 7. Brief tripwire

When a Design run first passes validation for a PR, the host records the brief's path and blob SHA as the **brief anchor**, or records that there is no brief. On a later run, a brief that differs from the anchor, or was added or removed, gives `HUMAN_REQUIRED / BRIEF_CHANGED` before any model call. `reset design` clears the anchor.

This is a tripwire for the case the workflow must catch: an agent editing the brief while fixing findings. It is not a security boundary (CRB-DEC-03).

## 8. Run protocol

1. **Load.** Check that the live PR is open and that its base and head equal the dispatched SHAs. If they do not, the run ends here and **writes nothing**: a run that was queued for an earlier head must not replace the session, which may hold a valid verdict. The consumer learns what to do from the decision function at the present head (§6.3). Otherwise select the session (ISO-2), or start an empty one.
2. **Settle first.** If `inFlight` is set, add `chargedUsd` to `spend` and clear it. This happens before anything else in every run that loads a session, including `reset` and runs that then stop for any reason (CRB-DEC-01).
3. **Validate, no model call.**
   - If the source comment is in `processedSourceComments`, write the settlement if step 2 made one, and stop.
   - For `reset`: apply §4, write the session, stop.
   - Validate the manifest and files (§5), compute the bundle identity, read the policy, check the brief anchor.
   - If the session holds a pass or rework for this exact bundle identity, record the command as processed, re-surface the result and stop.
   - Check `round`.
4. **Admit and charge.** Decide now whether this run may use Claude, by applying the three locks in §9. Write the session as `DESIGN_IN_PROGRESS` with `runStartedAt`, the brief anchor and, if Claude was admitted, `inFlight` set. If this write fails, stop before any model call.
5. **Evaluate.** **A Design run makes at most one Claude SDK invocation.** There are no shards, no retries and no second fallback. `@gemini design` tries Gemini and, only if Gemini cannot complete and Claude was admitted in step 4, makes the one Claude invocation. `@claude design` makes the one Claude invocation. If that invocation fails, the run publishes `DESIGN_BLOCKED / PROVIDER_UNAVAILABLE`. Shared read-only provider execution. The model receives the listed files, the reviewer policy, prior findings, and the existing sanitized read-only tools over the snapshot at the head. It receives no GitHub token.
6. **Publish.** Recompute the bundle identity at the PR's present head. If unchanged, write the verdict, findings, incremented `round`, the call's cost in place of the charge, `inFlight: null`, and the processed command. If changed, write `DESIGN_BLOCKED / INPUT_CHANGED` with the same spend settlement.

`design.yml` does not print file contents, policy text or model output to logs or the job summary. Target repositories can be private while this repository's logs are public.

## 9. Spend locks

The requirement is the user's: a Claude call that misbehaves must not be able to burn tokens without limit, and a crash must not be a way around the limit. Three locks apply to Claude. Gemini keeps the existing provider budget controls.

| Lock | Rule | Proposed value |
| --- | --- | --- |
| Per call | `maxBudgetUsd` and the adapter's turn limit are passed to the SDK; the job timeout ends a run that does not return. A run makes at most one Claude call | USD 2, 20 minutes |
| Per PR | Claude is admitted for a run only if `cap − spend ≥ per-call amount`. The full per-call amount is recorded as `inFlight` **before** the call (§8 step 4) | USD 6 cap |
| Daily, all PRs | Before admitting Claude, the host counts the `design.yml` runs created in this repository in the last 24 hours, in any state and including the present run. Above the limit, or if the count cannot be read, the status is `HUMAN_REQUIRED / DAILY_LIMIT` | 20 runs |

**One run, one call, one charge.** Admission happens once per run and covers exactly the one Claude invocation the run may make (§8 step 5). `inFlight` therefore never stands for more than one paid call, and no call starts without its own recorded charge.

**Why the daily count needs no reservation.** The count is of runs created, not of calls admitted, so it also counts resets and blocked runs; that errs toward refusing. Design runs execute one at a time (§4). When a run reads the count, every Design run that executed before it has ended and is in the listing, and runs still pending can only raise the count. Two commands arriving together on different PRs therefore cannot both be admitted past the limit: whichever executes second sees the first. This rests on one assumption, to be confirmed in S3: a completed run appears in the Actions run listing by the time the next run in the group starts.

**Settlement.** On publish, the call's provider-reported cost replaces the charge, including any amount above the per-call value. With no reported cost, the full charge stands. If the run completed without invoking Claude, because Gemini finished the evaluation, the charge is released and nothing is recorded. Design supplies no smaller fallback cost to the shared budget manager (§3 row 11).

**Why a crash cannot bypass the per-PR lock.** The charge is written before the call, and every later run settles it first (§8 step 2). A killed run therefore costs the full per-call amount on the ledger whether or not it actually spent it.

**Why the daily lock exists.** The per-PR ledger lives in a comment that can be deleted, and `reset design` restarts the round count. The daily count is kept by GitHub Actions, outside the PR, and bounds the total across PRs, resets and deleted sessions.

**Visibility.** The session comment shows recorded spend, the cap, the last call's cost and the round count. The job summary shows the same numbers.

When Claude is not admitted, `@gemini design` still runs on Gemini alone. If Gemini cannot complete, or the command is `@claude design`, the status is `HUMAN_REQUIRED / BUDGET_EXHAUSTED`.

The three lock values were confirmed by the user on 2026-11-11. They limit usage; they are not authority to enable paid Design runs, which S4 requires separately.

What the locks are: admission accounting plus per-call limits passed to the SDK. What they are not: a verified hard ceiling on actual subscription token use, because SDK enforcement of `maxBudgetUsd` is unverified (§3).

## 10. Recorded decisions

Decisions of the user, all dated 2026-11-11. The behaviors listed are **intended, not defects**, and must not be reported or "fixed" as bugs without a new decision. The implementation cites each ID in a code comment at the relevant branch, in a test named for it, and in one README sentence. CRB-DEC-04 is in §2.

### CRB-DEC-01: an interrupted run is re-run automatically

A run that finds `inFlight` set adds the full charge to `spend`, clears it and carries on. If the locks allow, the bundle is evaluated again with no person involved. The run that does this is started by the next Design command; in the automated loop the editing agent posts it after the decision function reports the abandoned run (§6.3).

Intended, not defects: a second paid evaluation of the same bundle after an interruption; charging the full per-call amount when the true cost is unknown; no stored intermediate result; no human stop after an interrupted call.

Not weakened: an interruption cannot create a pass or extend one to new content. A pass is written only in §8 step 6 and is usable only through §6.3.

### CRB-DEC-02: the per-PR cap is an admission cap

Guaranteed: no Claude call starts unless a full per-call amount fits under the cap, so recorded spend never exceeds `cap − per-call amount` plus the reported cost of the last admitted call.

Not guaranteed: that recorded spend stays under the cap. The figures are SDK-reported estimates on a subscription token, used as a usage limit.

Intended, not defects: recorded spend above the cap by one call's overshoot; a deleted session comment restarting the per-PR ledger, with the daily lock as the remaining bound; no second store for the per-PR ledger.

Changed from v0.4: the rule that treated Claude as exhausted after a lost session is replaced by the daily lock.

### CRB-DEC-03: the brief tripwire is procedural

`reset design` succeeds for any account with write access. The bot does not distinguish a person from an agent on the same account. That only a person resets is a rule of the editing agent's own policy.

Changed from v0.4: the `DESIGN_HUMAN_LOGINS` allowlist is removed. It belongs with the stronger model in §2.

## 11. What the reviewer checks

1. **Fidelity to the brief**, when one exists: nothing contradicts a decision or crosses a non-goal; each "what counts as done" item maps to an acceptance criterion; nothing exceeds the stated authorization. Without a brief, the comment says fidelity was not assessed.
2. **Soundness against the code**: claims about existing behavior are checked in the snapshot; authority, failure, retry and compatibility rules are coherent.
3. **Executability of the spec**: acceptance criteria are observable and verifiable, and authorizations are explicit.

The reviewer does not rewrite the contract and does not decide product questions.

## 12. Acceptance criteria

| ID | Requirement | Minimum evidence |
| --- | --- | --- |
| AC1 | Review is unchanged | Existing suite passes with `review-v2.yml` and all Review scripts byte-identical; one live Review PR lifecycle |
| AC2 | Isolation (§6.1) | Both task types on one PR in both orders. Model output and file content carrying Review markers, Design markers, HTML comments and encoded state. Wrong comment ID, changed `revision`, failed PATCH and DELETE. Review's planner and status sync select the same session as without Design, and Review sessions, findings, threads, PR reviews and statuses are unchanged |
| AC3 | Validation | Base or head moved: the run writes nothing, an existing session is byte-identical afterwards, and no model is called. Zero or several manifests; malformed schema; unknown role; missing file; symlink; submodule; oversize input; unreadable policy; repeated source comment. Each gives the stated status with no model call |
| AC4 | Brief tripwire | Changed, added or removed brief gives `BRIEF_CHANGED` with no model call. `reset design` re-anchors, zeroes `round`, keeps `spend` and processed commands |
| AC5 | Freshness and abandonment (§6.3) | Every row of the decision table. `DESIGN_IN_PROGRESS` gives `wait` before 30 minutes and `request_review` from 30 minutes. No session gives `request_review`. `DESIGN_BLOCKED` gives `request_review` when the head has moved since, `fix_input` for the two input reasons and `retry` for every other reason. **Stale queued run:** with a pass recorded for the present head, a queued run dispatched for an earlier head changes nothing, and the decision function still returns `continue`; with a rework recorded, it still returns `revise`. A listed file changed after a pass gives `request_review`. A code-only commit after a pass gives `continue` with the new head. A push between the two head reads is detected. An unreadable session gives `stop`. No case returns `continue` with a head whose bundle was not evaluated |
| AC6 | Loop | A seeded contradiction gives rework; a fix gives a full re-review that rules the old finding fixed and passes; three reworks give `ROUNDS_EXHAUSTED` |
| AC7 | Spend locks (§9) | Charge is written before the call. **One call per run:** with Gemini failing and Claude failing, the run makes exactly one Claude invocation and ends blocked; with USD 4 recorded, a run cannot make a second Claude invocation under one charge. **Abandoned run:** kill a run after the charge is written and post no human comment; after 30 minutes the decision function returns `request_review`, the agent's repeated command settles the charge first and re-evaluates, and no pass is visible before that evaluation completes (CRB-DEC-01). **Daily lock under concurrency:** with 19 runs counted, start Design on two different PRs at once, holding each just before admission; the runs execute one after the other and at most the limit is admitted; repeat after deleting a session comment and after repeated resets. With USD 4 recorded and USD 2 in flight, a `reset` followed by a command admits no Claude call. Reported cost above the per-call amount is recorded in full (CRB-DEC-02). The daily limit refuses at the threshold and when the count cannot be read. Review's ledger is unchanged throughout |
| AC8 | Logs | With a sentinel string in a listed file and in model output, the sentinel appears in no log or job summary |

Evidence must separate tests run, CI logs, model claims and observations on a real PR. A live test must confirm the deployed Worker revision.

## 13. Stages

- **S1 Gate.** Independent review of this document at its `design_ref`.
- **S2 Routing and validation, no model call.** Commands, `design.yml`, manifest validation, brief anchor, session writer with ISO-1 to ISO-3, the decision function. AC1 to AC5.
- **S3 Evaluation.** Provider call, findings, rounds, spend locks. AC6 to AC8 with providers stubbed.
- **S4 Live.** Only with separate authorization to deploy and to spend. One rework-to-pass loop and one Review lifecycle on real PRs.

## 14. Changes from v0.6, and the response to the v0.5 review

### Changes from v0.6

v0.6 passed independent design review. The bot's own code review of this document then reported one P2 finding against §6.3 (review session finding F001 on PR #70). It was verified as real and corrected here.

| Source | Problem | Correction |
| --- | --- | --- |
| Bot review F001, P2 | The decision function returned `fix_input` for every `DESIGN_BLOCKED`, including reasons where no input is wrong, and tested the status before anything else. A queued run dispatched for an earlier head wrote `DESIGN_BLOCKED / HEAD_MOVED` over a valid verdict, after which the agent was told to fix files that had no fault and never reached `request_review` | A run whose dispatched SHAs no longer match writes nothing (§8 step 1); the `HEAD_MOVED` reason is removed. The decision table distinguishes a blocked result for an earlier head, input reasons and all other reasons, adds a bounded `retry` action, and returns `request_review` when no session exists (§6.3). AC3 and AC5 extended |
| v0.6 review CRB-v06-F01, P3 | `queue: max` was described as keeping every pending run; GitHub keeps at most 100 | Wording corrected (§3 row 5, §4) |

Nothing else differs from v0.6.

### Response to the v0.5 review

The v0.5 review accepted the trust model, the isolation rules, the head-bound decision function, the brief tripwire and the settle-first rule. Its three findings all concern the spend locks first introduced in v0.5.

| Finding | Response |
| --- | --- |
| F01 P1, per-call reservation | A run makes at most one Claude SDK invocation: no shards, retries or second fallback. Admission happens once per run and covers that one call (§8 step 5, §9). AC7 |
| F02 P1, daily lock atomicity | All Design runs share one concurrency group, so admission is globally serialized. The count is of runs created and errs toward refusing. The one assumption it rests on is named for verification (§4, §9). AC7 |
| F03 P1, no recovery trigger | The decision function reports an in-progress status older than 30 minutes as `request_review`, and the editing agent posts the command again. Global serialization prevents overlapping evaluations (§6.3). AC5, AC7 |
| Row 12 citation | Corrected to the Claude adapter's lines (§3) |

Earlier findings, as the v0.5 reviewer ruled them: v0.4 F01 and F02 resolved; F03 partially resolved, now addressed above; F04 removed from scope by CRB-DEC-04.

## 15. Open items

- **Confirmed by the user on 2026-11-11.** `Jiaze-Li/personal-skills` is public. The lock values are USD 2 per call, USD 6 per PR and 20 runs per day.
- **Still proposed.** Three rounds; 64 KiB and 256 KiB; the 20-minute job timeout and the 30-minute abandonment threshold. They need the user's confirmation before S3.
- **To verify in S3.** That a completed run is in the Actions run listing when the next run in the group starts (§9).
- **Deployment parity.** The deployed Worker revision is unverified.
- **Authorization for this PR.** The user authorized documentation-only changes to this contract PR. Not authorized: implementation, merge, deployment, paid Design runs, credential or App permission changes, branch protection changes.
