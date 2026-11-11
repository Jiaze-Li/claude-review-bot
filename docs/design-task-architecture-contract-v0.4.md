# CRB-DESIGN-01 — Design Task Architecture Contract v0.4

**Status:** REVISED DRAFT. Independent DESIGN Gate **PENDING** for v0.4. v0.1 was DESIGN REWORK (D01–D03). v0.2 was not independently reviewed. v0.3 was DESIGN REWORK (F01–F07). Not approved for implementation.
**Target repository:** `Jiaze-Li/claude-review-bot`
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`
**Code baseline for the facts in §2 (read-only):** `b2ab0631ac0ef4192c2b6956ea100a8e3ca17047`, the merge of PR #71 on `main`. v0.3 gave this SHA with a wrong eighth character.
**Risk / gate:** Tier 3 / REQUIRED / PENDING.
**Immutable `design_ref`:** `git:Jiaze-Li/claude-review-bot@<commit-of-this-file>:docs/design-task-architecture-contract-v0.4.md`, assigned in the PR description after commit. A reviewer must verify the bytes at that ref.
**Previous versions:** v0.3 at `99682892968a76e0b47a9b44afcd97af377cabb7`, v0.2 at `b8034c3d3b6de60334c6f567a206723ef7559d0a`, v0.1 at `d424d833de44fddcf1fd804baf5630ff0027ac56`, all under `docs/`.
**Authorship:** v0.1 and v0.2 were drafted in the user's GPT conversation. v0.3 and v0.4 were revised by a coding-agent session at the user's request. Whoever reviews v0.4 must be a separate context from both.

This document proposes a change. It does not approve itself, and it grants no implementation, merge, deployment, credential or spending authority.

## 1. Purpose

Add a `design` task type to the existing review bot so that a task's contract documents can be independently reviewed on GitHub, and so that an agent can drive the revise-and-re-review loop without a person relaying messages. The existing `review` task type keeps its current behavior.

The workflow this serves, stated here so the contract is self-contained:

1. A person and a general AI agree on a short **brief**: goal, non-goals, decisions already made, what counts as done, and how far the work is authorized to go.
2. The AI commits the brief and the contract documents to a task branch and opens a draft PR.
3. `design` reviews the contract documents. An editing agent revises them and requests re-review until the verdict is pass, or the bot stops for a person.
4. Implementation and the existing `review` follow on the same PR.

Two properties drive the design:

- **The loop is meant to change the contract documents and leave the brief alone.** The bot detects a changed brief and stops. How strongly this is enforced is decided in CRB-DEC-03 (§10).
- **A stop for a person must mean a decision is needed.** A recoverable technical failure should not stop the loop.

### Non-goals

Free-form prompt commands. Any change to `review` commands, state, findings, threads, budgets or commit status. The reviewer editing contracts or code. A commit status, review threads or a GitHub PR review object for `design`. Contract files outside the target repository. `design` runs triggered by PR events, including a refresh on push. A `workflow_call` entry point for `design`. Starting or waking the editing agent.

## 2. Verified baseline

Facts read at the full baseline SHA above. They are source facts, not evidence about the deployed Cloudflare Worker.

| # | Fact | Location |
| --- | --- | --- |
| 1 | A command is the first non-blank line of a new PR conversation comment. Unrecognized text is ignored. | `worker/src/review-trigger.js:4-35` |
| 2 | Automatic review runs on `opened`, `ready_for_review` and `reopened` only. A push does not trigger a review. | `worker/src/review-trigger.js:40-53` |
| 3 | A comment command requires the author to have `write`, `maintain` or `admin`. | `worker/src/index.js:119-127` |
| 4 | Triggers with `sourceKind: pull_request` are skipped on draft PRs. That covers automatic PR events and review-thread events. Comment commands run on drafts. | `worker/src/review-trigger.js:59-66`, `worker/src/index.js:131-133` |
| 5 | The Worker dispatches one workflow, by default `review-v2.yml` and configurable through `CONTROL_WORKFLOW`, with `target_repo`, `pr_number`, `base_sha`, `head_sha`, `trigger_user`, `source_comment_id`, `source_kind`, `requested_mode`. The inputs are not signed. | `worker/src/index.js:145-175` |
| 6 | `review-v2.yml` accepts `workflow_dispatch` and `workflow_call`, is serialized per PR, and does not cancel a running review. | `.github/workflows/review-v2.yml:4-88,89-95` |
| 7 | The workflow stops if the PR base or head differs from the dispatched SHAs. | `.github/workflows/review-v2.yml:224-228` |
| 8 | The review session is a bot-authored comment. An in-progress state is edited in place. A changed result is posted as a new comment and the old one is deleted on a best-effort basis, so an old copy can remain. The writer mutates by the supplied comment ID without re-checking ownership. | `scripts/session-comment.mjs:20-36` |
| 9 | Review finds its session as the newest comment whose author is the App identity and whose body **contains** `<!-- jiaze-review-session:v1 -->` anywhere. An unreadable newest match is a hard error. | `scripts/plan-review-session.mjs:24-36`, `scripts/sync-commit-status.mjs:65-82` |
| 10 | Session state is base64url JSON in `<!-- jiaze-review-state:... -->`. | `scripts/review-session-core.mjs:898-943` |
| 11 | Review allows 2 verification rounds before `HUMAN_REQUIRED`. | `scripts/review-session-core.mjs:4` |
| 12 | The review commit status context is `claude-review-bot/review`. | `scripts/sync-commit-status.mjs:9` |
| 13 | The reviewer's file snapshot contains ordinary blobs only and excludes `CLAUDE.md` and `.claude/`. | `scripts/materialize-safe-tree.mjs:44-53,107-113` |
| 14 | The shared budget manager settles a call at the provider-reported cost with no upper bound, and at the reservation when no cost is reported. | `scripts/review-orchestrator.mjs:161-175` |
| 15 | The Claude adapter passes `maxBudgetUsd` to the SDK. Claude runs on a subscription OAuth token. | `scripts/provider-adapter.mjs:1286`, `README.md:79` |

Not verified: the deployed Worker revision; whether the App's installation token can read the private `Jiaze-Li/personal-skills`; how strictly the SDK enforces `maxBudgetUsd`.

## 3. Commands and routing

| First non-blank line | Effect |
| --- | --- |
| `@gemini design` | Design review, Gemini first, Claude where Gemini cannot |
| `@claude design` | Design review, Claude only |
| `@jiaze-claude-review-bot reset design` | Discard the Design session's anchors, round count and findings. Spend and processed-command history are kept. No model call. |

All existing commands keep their current meaning and act on Review only. `reset review`, `override review`, `dismiss` and thread resolution never touch Design state.

The Worker routes the three commands above to a **separate workflow file**, `design.yml`, which has a `workflow_dispatch` trigger only. `review-v2.yml` is not modified. `design.yml` has its own concurrency group per PR and does not cancel a running Design.

The token `design.yml` uses on the target repository has contents-read and pull-requests-write only. It has no statuses permission, so Design cannot write a commit status.

The Worker and the provider adapters are shared. Review's session core is not generalized.

## 4. Invocation authority

### 4.1 Signed envelope

Today the Worker's dispatch inputs are unsigned (§2 row 5), so the workflow cannot tell a Worker dispatch from a manual one. Design adds a signature.

After the Worker has verified the webhook signature of an `issue_comment.created` event, parsed a Design command from its first line and confirmed the author's write permission, it builds an **envelope**:

`version`, `target_repo`, `pr_number`, `source_comment_id`, `comment_author`, `command` (`design` or `reset`), `provider_mode` (`auto` or `claude`), `base_sha`, `head_sha`, `delivery_id`, `issued_at`.

It serializes the envelope canonically and signs it with HMAC-SHA-256 under a **dispatch key** held only by the Worker and by this repository's Actions secrets. The dispatch key is separate from the webhook secret. `design.yml` takes exactly two inputs, the envelope and its signature.

The envelope fixes the bundle: `head_sha` identifies one commit, and the manifest and every listed file are read from that commit.

### 4.2 Verification before anything else

`design.yml` first verifies the signature over the exact envelope bytes in constant time and rejects an envelope older than 6 hours (proposed). On failure the run ends and **writes nothing** to the target repository.

With a valid envelope it then checks GitHub, and reports a failure in the Design session as `DESIGN_BLOCKED`:

- The comment `source_comment_id` exists on that PR and its author is `comment_author`.
- The comment has never been edited (`updated_at` equals `created_at`).
- Its first non-blank line still parses to the same `command` and `provider_mode`.
- `comment_author` has write access now.
- The PR is open and its head equals `head_sha`.

Consequences:

- A manual dispatch without the dispatch key cannot start a run.
- A comment edited into a command never produced a signed envelope and is also rejected as edited.
- An old command cannot be applied to a newer head, because the head is inside the signature.
- A captured valid envelope can only be replayed for the same comment and head. The run then stops at the processed-command check (§8 step 1).

### 4.3 Reviewer policy authority

The policy repository is host configuration. The manifest supplies only `policy_sha`, and:

- `policy_sha` must be a commit reachable from the policy repository's default branch. A commit that exists only on another branch is rejected as `POLICY_NOT_ON_DEFAULT_BRANCH`.
- The first Design run that passes validation records `policy_sha` in the session as the **policy anchor**. A later run with a different `policy_sha` produces `HUMAN_REQUIRED / POLICY_CHANGED` before any model call. `reset design` clears the anchor.

## 5. Manifest and input

### 5.1 Location

The manifest is `.reviewbot/tasks/<task_id>.json` at the envelope's `head_sha`. `task_id` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and equals the file name.

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

Every path is an ordinary UTF-8 blob in the target repository at `head_sha`. Symlinks, submodules, paths outside the repository and URLs are rejected. Each file is at most 64 KiB, matching the limit ReviewLoop places on `contractText`, and the set is at most 256 KiB. Oversize input is rejected, never truncated. Both limits are proposed defaults.

The manifest and every listed file are **untrusted data** to the model. They are never placed in a system prompt and cannot widen tool access. The PR description is not an input.

### 5.3 Bundle identity

The **bundle identity** is the manifest's git blob SHA, each listed file's git blob SHA, and `policy_sha`. A verdict is bound to the bundle identity. The reviewed head SHA is recorded for audit.

A verdict is **current** when the bundle identity computed at the PR's present head equals the one in the session. A commit that changes no listed file and not the manifest leaves a pass current. A Design pass approves the documents. It says nothing about code committed afterwards.

## 6. Session, states and findings

### 6.1 Ownership and isolation

Review selects its session by author plus a marker substring anywhere in the body (§2 row 9). A Design comment is written by the same App identity, so a separate workflow is not sufficient isolation. Three rules apply.

**ISO-1, body construction.** The host builds every Design comment body.

- The body starts with `<!-- jiaze-design-session:v1 -->` and contains one `<!-- jiaze-design-state:<base64url JSON> -->`.
- Every string that originates from the model, the manifest, a file path, a file's content or an error is HTML-escaped before it is placed in the body, so it cannot open or close an HTML comment.
- Before any write the host asserts on the final body: each Design marker occurs exactly once, and the substrings `jiaze-review-session` and `jiaze-review-state` occur nowhere, including inside the encoded state. A failed assertion publishes nothing from that body and yields `DESIGN_BLOCKED / OUTPUT_REJECTED` written from fixed text.

**ISO-2, discovery.** A comment is the Design session only if its author is the App identity, its body starts with the Design marker, it contains no Review marker, its state decodes, and the decoded repository and PR number match. The newest such comment is used. If the newest comment by author and Design marker fails the remaining checks, the run stops without a model call and without mutating it.

**ISO-3, mutation.** Design has its own comment writer. Immediately before every PATCH or DELETE it re-fetches the comment by ID and verifies the ISO-2 conditions plus the decoded `taskId` and `revision` it loaded at the start of the run. On any mismatch it does not mutate and stops. `design.yml` invokes no Review session writer, thread reconciler, PR-review publisher or status writer.

Review code is unchanged. ISO-1 is what keeps Review's substring match from ever selecting a Design comment.

**The Design session comment is the only Design decision.** A workflow result, a log or model output is not a verdict.

### 6.2 State

| Field | Meaning |
| --- | --- |
| `status`, `reason` | One of the five statuses below, and a machine reason code |
| `repo`, `pr`, `taskId`, `manifestPath` | Identity of the session |
| `revision` | Incremented on every write |
| `bundle` | Manifest blob SHA, `{path, role, blob}` for each file, and `policySha` |
| `reviewedHead` | PR head when the bundle was read |
| `briefAnchor`, `policyAnchor` | Set at the first validated run; cleared by `reset design` |
| `round`, `maxRounds` | Completed evaluations and the limit |
| `findings` | `{id, severity, status, file, location, title, detail}` |
| `spend` | Design-only Claude ledger: settled USD, cap, and any overshoot |
| `inFlight` | `{sourceCommentId, reservedUsd, startedAt}` while a paid call is outstanding, else null |
| `processedSourceComments` | Comment IDs already handled; kept across `reset design` |

| `status` | Meaning | Reason codes |
| --- | --- | --- |
| `DESIGN_IN_PROGRESS` | A run is active | — |
| `DESIGN_PASS` | No open blocking finding for the recorded bundle | — |
| `DESIGN_REWORK` | Open blocking findings for the recorded bundle | — |
| `DESIGN_BLOCKED` | No evaluation happened or none could be published | `COMMAND_INVALID`, `HEAD_MOVED`, `MANIFEST_INVALID`, `INPUT_INVALID`, `POLICY_UNREADABLE`, `POLICY_NOT_ON_DEFAULT_BRANCH`, `PROVIDER_UNAVAILABLE`, `INPUT_CHANGED`, `OUTPUT_REJECTED` |
| `HUMAN_REQUIRED` | A person must decide | `BRIEF_CHANGED`, `POLICY_CHANGED`, `ROUNDS_EXHAUSTED`, `BUDGET_EXHAUSTED`, `SESSION_LOST` |

`USER WAIVED` remains a human record under the engineering policy. It is not a bot state, and `design` has no override or dismiss command in this version.

### 6.3 Consuming the result

**A status alone never authorizes continuing.** An earlier `DESIGN_PASS` can remain visible after the documents change, because Design does not run on push and an interrupted run leaves the previous comment in place. Such a pass is not current.

The only sanctioned way to act on a Design result is the decision function, shipped as `scripts/design-status.mjs` and usable with a read-only token:

1. Read the PR's present head.
2. Select the session by ISO-2.
3. Compute the bundle identity at the present head from the session's `manifestPath`.
4. Return one action:

| Condition | Action |
| --- | --- |
| Any step fails, the session is missing, or the manifest cannot be read | `stop` |
| Status is `DESIGN_IN_PROGRESS` | `wait` |
| Status is `HUMAN_REQUIRED` | `stop` |
| Status is `DESIGN_BLOCKED` | `fix_input` |
| Bundle identity differs from the session's | `request_review` |
| Status is `DESIGN_REWORK`, identity equal | `revise` |
| Status is `DESIGN_PASS`, identity equal | `continue` |

`continue` is returned in exactly one row. The session comment's visible text states the bundle a verdict applies to and names this function as the way to check it.

The host re-checks the bundle identity before publishing (§8 step 4). That check only avoids posting a verdict already known to be stale. The head can still move between the check and the write; the verdict is then a correct statement about the recorded bundle, and the decision function reports `request_review` for the new one.

### 6.4 Rounds

A round is one evaluation that ends in `DESIGN_PASS` or `DESIGN_REWORK`. `maxRounds` is 3 (proposed). When the third evaluation ends with open blocking findings, the status is `HUMAN_REQUIRED / ROUNDS_EXHAUSTED` and the findings stay listed. `DESIGN_BLOCKED` does not consume a round. `reset design` sets `round` to 0.

### 6.5 Findings

Severity follows the bot: P0, P1 and P2 block; P3 does not. At most 8 P3 items are listed.

A blocking finding must name the file and location, what it contradicts (a brief item, a stated invariant, another part of the contract, or a cited code fact), and the correction required. A finding that cannot do this is recorded as P3.

Every evaluation reads the whole current bundle and also rules on each previously open finding as fixed or still open. A pass requires all listed files read in full, no open blocking finding, and every earlier blocking finding ruled fixed. Findings are listed in the session comment. There are no inline threads.

## 7. Brief anchor

When a Design run first passes validation for a PR, the host records the brief's path and blob SHA as the **brief anchor**. If the manifest has no brief, the anchor records that.

On every later run, a brief whose path or blob differs from the anchor, or a brief that was added or removed, produces `HUMAN_REQUIRED / BRIEF_CHANGED` before any model call. `reset design` clears the anchor, and the next run anchors the brief as it then stands.

The anchor shows the brief is unchanged since the first Design run. It does not show a person read it. What it protects against is decided in CRB-DEC-03 (§10).

## 8. Run protocol

1. **Validate, no model call.**
   - Verify the envelope and the live GitHub checks (§4.2).
   - Select the session (ISO-2). If none exists, apply the session-loss rule (§9.3).
   - If `source_comment_id` is in `processedSourceComments`, stop without change.
   - For `reset`: apply §3 and CRB-DEC-03, write the session, stop.
   - Locate and validate the manifest and files (§5). Compute the bundle identity.
   - Check the policy rules (§4.3) and the brief anchor (§7). Read the reviewer policy (§9.4).
   - If the session holds a pass or rework for this exact bundle identity, record the command as processed, re-surface the result and stop.
   - If `inFlight` is set, apply CRB-DEC-01 (§10).
   - Check `round` and the admission rule (§9.1).
2. **Reserve.** Write the session as `DESIGN_IN_PROGRESS` with `inFlight` set and the anchors recorded. If this write fails, stop before any model call.
3. **Evaluate.** Shared read-only provider execution. The model receives the full bytes of every listed file, the reviewer policy text, prior findings, and the existing sanitized read-only tools over the snapshot at `head_sha`. It receives no GitHub token.
4. **Publish.** Apply the output checks (§9.5). Recompute the bundle identity at the PR's present head. If unchanged, write the verdict, findings, incremented `round`, settled spend, `inFlight: null` and the processed command. If changed, write `DESIGN_BLOCKED / INPUT_CHANGED` with settled spend and `inFlight: null`.

## 9. Budget, session loss, policy access and privacy

### 9.1 Admission cap

Design has its own Claude ledger in the Design session, separate from Review's. Proposed figures: USD 2 reserved per evaluation, USD 6 cap per PR across all rounds, commands and resets.

- **Admission.** A Claude call starts only if `cap − spend ≥ reservation`. Otherwise Claude is unavailable for this PR.
- **Per-call limit.** The call passes `maxBudgetUsd` equal to the reservation.
- **Settlement.** The provider-reported cost is recorded, including any amount above the reservation, which is also shown as overshoot. With no reported cost, the full reservation is recorded.

What this guarantees is stated in CRB-DEC-02 (§10). Review's allowance and manual-call ceiling are unchanged. Gemini uses the existing provider budget controls and is not charged to this ledger.

`@gemini design` still runs when Claude is unavailable. If Gemini then cannot complete, or the command is `@claude design`, the status is `HUMAN_REQUIRED / BUDGET_EXHAUSTED`.

These figures are proposals. They are not authority to spend.

### 9.2 What the ledger survives

`spend` and `processedSourceComments` are kept across `reset design`, new bundles and new rounds.

### 9.3 Session loss

The session comment is the only store, and anyone with write access to the target repository can delete it. When a run finds no session, the host looks in this repository's Actions history for earlier `design.yml` runs for the same target PR, created since the PR was opened, whose reserve step succeeded.

- None found: this is the first evaluation. Start a fresh session.
- At least one found, or the history cannot be read: write a new session as `HUMAN_REQUIRED / SESSION_LOST` with `spend` set to the cap. No model call.

After `SESSION_LOST`, `reset design` restores the loop with round 0 and new anchors. `spend` stays at the cap, so only Gemini is available for that PR.

Limits: Actions run history is retained for a bounded period (90 days by default), and the owner of this repository can delete runs. Beyond those limits a lost session is not detectable.

### 9.4 Policy access

The reviewer policy is read from the configured policy repository at the manifest's `policy_sha`, subject to §4.3. That repository is private and this one is public. The read uses a token scoped to contents-read on that one repository, separate from the target-repository token. If the policy cannot be read, the status is `DESIGN_BLOCKED / POLICY_UNREADABLE`.

### 9.5 Privacy at the output boundary

Instructions to the model are not a privacy control. The host enforces the following.

- **Structured output.** Model output must validate against a JSON schema. Free-text fields are length-bounded: title 160 characters, detail 1,200 characters, at most 30 findings (proposed).
- **Policy leak check.** After whitespace and case normalization, no model-supplied string may share a run of 48 or more characters with the policy text (proposed threshold). A violation publishes nothing from the output and yields `DESIGN_BLOCKED / OUTPUT_REJECTED`. Spend is settled and no round is consumed.
- **Logs.** `design.yml` writes to logs and the job summary only through one helper that accepts fixed reason codes, counts, SHAs and costs. Model output, file contents, policy text, provider error bodies and GitHub response bodies are never logged and never uploaded as artifacts.

Quoting a target repository's own contract files in a comment on that repository's PR is allowed. The comment has the same visibility as the files.

## 10. Recorded decisions

These are decisions of the user. The behaviors listed under each are **intended, not defects**. They must not be reported or "fixed" as bugs without a new decision from the user. The implementation cites the decision ID in a code comment at the relevant branch, in a test named for it, and in one README sentence each.

### CRB-DEC-01: an interrupted run is re-run automatically

Decided 2026-11-11. Replaces v0.2 §5A and changes how v0.1 finding D02 is resolved. Accepted by the v0.3 independent review as a user decision.

**Behavior.** A Design run that finds `inFlight` set treats the earlier run as dead, because Design runs are serialized per PR. It adds the full `reservedUsd` to `spend`, clears `inFlight`, and continues planning. If the admission rule allows, the bundle is evaluated again. No person is involved.

**Why.** Stopping for a person whenever a result might have been paid for but not stored turns a recoverable technical failure into a human stop, to save an amount the cap already limits.

**Intended, not defects:**
- A second paid evaluation of the same bundle after an interrupted run.
- Charging the full reservation for an interrupted run whose true cost is unknown.
- No stored intermediate result that would allow finishing without another model call.
- No human stop after an interrupted paid call.

**Not weakened.** An interruption cannot create a pass or extend one to new content. A pass is written only in §8 step 4, and it is usable only through §6.3.

**Revisit when** the reservation is raised above USD 5, an interrupted run is observed more than once in ten Design runs, or Design is offered to accounts other than the owner's.

### CRB-DEC-02: the cap is an admission cap

Decided 2026-11-11 in response to v0.3 finding F04.

**Behavior.** §9.1 and §9.3.

**What is guaranteed.** No Claude call starts unless a full reservation fits under the cap. Recorded spend therefore never exceeds `cap − reservation` plus the reported cost of the last admitted call.

**What is not guaranteed.** That recorded spend stays at or under the cap. A call whose reported cost exceeds its reservation can take the ledger past it. The contract does not rely on how strictly the SDK enforces `maxBudgetUsd`. Claude runs on a subscription token, so the figures are SDK-reported cost estimates used as a usage limit, not invoiced amounts.

**Intended, not defects:**
- Recorded spend above the cap by the overshoot of one call.
- After a lost session, Claude treated as exhausted for that PR even if little was spent.
- No second store for the ledger outside the session comment.

**Revisit when** a recorded overshoot exceeds the reservation, or Claude is moved to metered API billing.

### CRB-DEC-03: the brief freeze is a procedural rule for now

Decided 2026-11-11 in response to v0.3 finding F05.

**Behavior.** `reset design` is accepted from any author with write access, unless the host variable `DESIGN_HUMAN_LOGINS` is set. When it is set, the Worker and `design.yml` accept `reset design` only when the envelope's `comment_author` is in that list, and reject it otherwise as `COMMAND_INVALID`.

**What the brief anchor is.** A tripwire. It stops the loop when the brief changes during revision, which is the case the workflow needs to catch: an agent editing the brief while fixing findings.

**What it is not.** A security boundary. While the editing agent uses the user's GitHub account and `DESIGN_HUMAN_LOGINS` is unset, an agent that changes the brief and then issues `reset design` is not stopped by the bot. The same applies to the round limit and the policy anchor, which `reset design` also clears, and to deleting the session comment. The rule that only a person issues `reset design` is enforced by the editing agent's own policy.

**Intended, not defects:**
- `reset design` succeeding for a command posted by an agent under the user's account while the allowlist is unset.
- The bot not distinguishing a person from an agent on the same account.

**Revisit when** the editing agent has its own GitHub identity. Setting `DESIGN_HUMAN_LOGINS` to the user's login then makes the rule enforced, with no code change.

## 11. What the reviewer checks

1. **Fidelity to the brief**, when one exists. Nothing in the spec or design contradicts a decision or crosses a non-goal. Each item under "what counts as done" maps to an acceptance criterion. Nothing exceeds the stated authorization. Without a brief, the session comment says fidelity was not assessed.
2. **Soundness against the code.** Claims about existing behavior are checked in the snapshot. Authority, failure, retry and compatibility rules are coherent. Facts, proposals and unknowns are kept apart.
3. **Executability of the spec.** Acceptance criteria are observable and verifiable, and authorizations are explicit.

The reviewer does not rewrite the contract and does not decide product questions.

## 12. Acceptance criteria

| ID | Requirement | Minimum evidence |
| --- | --- | --- |
| AC1 | Review is unchanged | Existing suite passes with `review-v2.yml` and all Review scripts byte-identical; one live Review PR lifecycle |
| AC2 | Isolation (ISO-1 to ISO-3) | Both task types on one PR in both orders and interleaved. Model output and file content carrying Review markers, Design markers, HTML comments and encoded state. Wrong comment ID, changed `revision`, failed PATCH and DELETE. In every case Review's planner and status sync select the same session as without Design, and Review sessions, findings, threads, PR reviews and `claude-review-bot/review` statuses are unchanged |
| AC3 | Invocation authority | Missing, wrong and altered signature; expired envelope; manual dispatch; comment edited into a command; command edited away; deleted comment; non-writer; old command with a newer head; replayed envelope. None reaches a model call, and a bad signature writes nothing. A legitimate command runs |
| AC4 | Manifest and policy validation | Zero or several manifests, malformed schema, unknown role, missing file, symlink, submodule, oversize input, `policy_sha` not on the default branch, unreadable policy. Each gives `DESIGN_BLOCKED` with the stated reason and no model call |
| AC5 | Anchors and CRB-DEC-03 | Changed, added or removed brief gives `BRIEF_CHANGED`; changed `policy_sha` gives `POLICY_CHANGED`; both without a model call. `reset design` re-anchors, zeroes `round`, keeps `spend` and processed commands. With `DESIGN_HUMAN_LOGINS` set, a reset from an unlisted writer is rejected and one from a listed login succeeds. With it unset, a reset from any writer succeeds |
| AC6 | Freshness (§6.3) | For every row of the decision table. In particular: a listed file changed after a pass gives `request_review`; a code-only commit after a pass gives `continue`; head moved between the publish check and the write; run interrupted before the reserve write and after the publish write; session removed, corrupted or unreadable. No case returns `continue` for a bundle that was not evaluated |
| AC7 | Loop | A seeded contradiction gives rework. A fix gives a full re-review that rules the old finding fixed and passes. Three reworks give `ROUNDS_EXHAUSTED` |
| AC8 | CRB-DEC-01 | Kill a run after the reserve write. The next command charges the full reservation, clears `inFlight`, evaluates and publishes without a person. The decision function never returns `continue` in between |
| AC9 | CRB-DEC-02 | Reported cost above the reservation is recorded with overshoot. Cost unavailable charges the reservation. A call is refused when less than one reservation remains. Gemini-to-Claude fallback and Claude-only both draw on the ledger. Deleted session with a prior reserved run gives `SESSION_LOST` with spend at the cap, and unreadable history does the same. Review's ledger is unchanged throughout |
| AC10 | Privacy (§9.5) | A sentinel string in the policy and in a private target's files, with model output and provider errors that echo them. The sentinel appears in no log, job summary, artifact or comment outside the target repository's own PR, and the policy sentinel appears in no comment at all. Failure paths included |

Evidence must separate tests run, CI logs, model claims and observations on a real PR. A live test must confirm the deployed Worker revision.

## 13. Stages

- **S1 Gate.** Independent review of this document at its `design_ref`. No implementation before a pass, or a valid explicit waiver with no unresolved substantive blocker.
- **S2 Routing and validation, no model call.** Commands, envelope signing and verification, `design.yml`, manifest and policy validation, anchors, session writer with ISO-1 to ISO-3, the decision function. AC1 to AC6. Creating the dispatch key needs separate authorization.
- **S3 Evaluation.** Provider call, findings, rounds, ledger, CRB-DEC-01 and CRB-DEC-02 paths, output checks. AC7 to AC10 with providers stubbed.
- **S4 Live.** Only with separate authorization to deploy and to spend. One rework-to-pass loop and one Review lifecycle on real PRs.

## 14. Response to the v0.3 review

| Finding | Response |
| --- | --- |
| F01 P1, invocation authority | Signed envelope binding the original event, author, command, provider mode, PR and head (§4.1). Edited comments rejected (§4.2). `policy_sha` restricted to the policy repository's default branch and anchored (§4.3). No `workflow_call` entry. AC3, AC4 |
| F02 P1, comment isolation | ISO-1 to ISO-3 (§6.1), a Design token without statuses permission (§3). Review code unchanged. AC2 |
| F03 P1, stale pass | The claim that an interruption leaves no visible pass is withdrawn. Freshness is mandatory at the consumption boundary through one decision function (§6.3). AC6 |
| F04 P1, spend ceiling | User decision CRB-DEC-02: an admission cap with stated limits, and a fail-closed rule for a lost session (§9.1 to §9.3). AC9 |
| F05 P1, brief freeze exception | User decision CRB-DEC-03: procedural for now, with an allowlist that makes it enforced once the agent has its own identity (§10). AC5 |
| F06 P2, baseline | Full baseline SHA. Rows 4, 5 and 8 corrected. Rows 9, 14 and 15 added because F02 and F04 depend on them (§2) |
| F07 P2, privacy | Host-side schema, leak check and log rules (§9.5). AC10 |

Disposition of the v0.1 findings as the v0.3 reviewer stated it: D01 not resolved, now addressed by §4. D02 partially resolved, now addressed by §6.1 and §6.3 with CRB-DEC-01 kept. D03 partially resolved, now addressed by §9 and CRB-DEC-02.

## 15. Open items

- **Dispatch key.** A new shared secret in the Worker and in this repository's Actions secrets. Needs the user's authorization before S2.
- **Policy access.** Whether the App can mint a contents-read token for `personal-skills`, and whether the user authorizes it.
- **Proposed numbers.** Three rounds, USD 2 and USD 6, 64 KiB and 256 KiB, the 6-hour envelope age, and the output bounds in §9.5 need the user's confirmation before S3.
- **Deployment parity.** The deployed Worker revision is unverified.
- **Authorization for this PR.** The user authorized documentation-only changes to this contract PR. Not authorized: implementation, merge, deployment, paid Design runs, credential or App permission changes, branch protection changes.
