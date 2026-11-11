# CRB-DESIGN-01 — Design Task Architecture Contract v0.11

**Status:** v0.6 received an independent **DESIGN PASS** on 2026-11-11, bound to blob `40b9823aa2d00282cf78d43b69fb45a55560dc0c`. v0.7 addressed bot review finding F001 (P2) and CRB-v06-F01 (P3). v0.8 incorporated CRB-v07-F06 (P3). v0.9 addressed F01 through F06. v0.10 addressed CRB-v09-F01 through F04. v0.11 resolves independent review findings CRB-v10-F01 through F03: establishing canonical cross-worktree atomic file locking with single-host scope (P2), separating queue wait timeout (60 min) from in-progress execution timeout (30 min) to prevent prematurely aborting active evaluations (P2), and clarifying the no-session acceptance criteria condition in AC5 (P3). §14 lists all findings. Not approved for implementation by this document.
**Target repository:** `Jiaze-Li/claude-review-bot`
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`
**Code baseline for the facts in §3 (read-only):** `b2ab0631ac0ef4192c2b6956ea100a8e3ca17047`, the merge of PR #71 on `main`.
**Risk / gate:** Tier 3 / REQUIRED / PENDING, as classified by the Engineering Lead for v0.1. v0.5 narrowed the scope (§2); re-classification is the Lead's decision, not this document's.
**Immutable `design_ref`:** `git:Jiaze-Li/claude-review-bot@<commit-of-this-file>:docs/design-task-architecture-contract-v0.11.md`, assigned in the PR description after commit.
**Previous versions:** v0.10 at `a663c487d2a1572b1d723ae6bfeb6b7bc40d20bd`, v0.9 at `34882a78c4d8469e113ccb7fba30f3b21c06cb89`, v0.8 at `1755afad28b3b497d83c7d71ab5b731da1057ee2`, v0.7 at `7b211fc52240ee75d3baca54ad352960e4ce50a1`, v0.6 at `62a15fab1c23c6b3f49bf2cda90bc529c2550300`, v0.5 at `5402aeca88697a94cf9ded791f1ba00ef61b4722`, v0.4 at `7c6b8c80e752f1f8e34e710cbf68b442baeda587`, v0.3 at `99682892968a76e0b47a9b44afcd97af377cabb7`, v0.2 at `b8034c3d3b6de60334c6f567a206723ef7559d0a`, v0.1 at `d424d833de44fddcf1fd804baf5630ff0027ac56`, all under `docs/`.
**Authorship:** v0.1 and v0.2 were drafted in the user's GPT conversation. v0.3 to v0.11 were revised by a coding-agent session at the user's request. Whoever reviews v0.11 must be a separate context from both.

This document proposes a change. It does not approve itself, and it grants no implementation, merge, deployment, credential or spending authority.

## 1. Purpose

Add a `design` task type to the review bot so that a task's contract documents can be independently reviewed on GitHub, and so that an agent can drive the revise-and-re-review loop without a person relaying messages. The existing `review` task type keeps its current behavior.

The workflow this serves:

1. A person and a general AI agree on a short **brief**: goal, non-goals, decisions already made, what counts as done, and how far the work is authorized to go.
2. The AI commits the brief and the contract documents to a task branch and opens a draft PR.
3. `design` reviews the contract documents. An external deterministic orchestrator checks status and coordinates the loop; when revision is required, an editing agent revises them. The orchestrator requests re-review until the verdict is pass, or the bot stops for a person.
4. Implementation and the existing `review` follow on the same PR.

### Non-goals

Free-form prompt commands. Any change to `review` commands, state, findings, threads, budgets or commit status. The reviewer editing contracts or code. A commit status, review threads or a PR review object for `design`. Contract files outside the target repository. `design` runs triggered by PR events. A `workflow_call` entry point for `design`. Starting or waking the editing agent. Embedding a full local orchestrator runtime into the bot repository (an external non-LLM orchestrator or simple script consumes `design-status.mjs`). Use by anyone other than the owner (§2).

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
| `@jiaze-claude-review-bot reset design` | Clear the brief anchor, round count, retry count and findings. Writes session status as `DESIGN_REWORK` with reason `RESET` and `bundle: null` (§6.2, CRB-v07-F04). Spend and processed-command history are kept. No model call. |

All existing commands keep their current meaning and act on Review only.

The Worker routes the three commands to a **separate workflow file**, `design.yml`, with the same kind of inputs Review receives (§3 row 4) and a `workflow_dispatch` trigger only. `design.yml` sets `run-name: design/${{ inputs.target_repo }}#${{ inputs.pr_number }}@${{ inputs.head_sha }}:${{ inputs.source_comment_id }}`. `review-v2.yml` is not modified.

When the deterministic orchestrator posts a command comment (`@claude design` or `@gemini design`), it includes a head marker `<!-- design-head:<40-hex-sha> -->` in the comment body to explicitly bind the command to head `H`. A manual comment from a person may omit the marker; in that case, the Worker binds the PR's head at dispatch time and `design.yml`'s `run-name` carries it. Combined with the source comment ID, this establishes the unique request identity: `<repo>#<pr>@<head>:<commentId>`.

**All Design runs share one concurrency group.** `design.yml` uses a single group for every target repository and PR, does not cancel a running Design, and keeps pending runs with `queue: max`, as Review does per PR (§3 row 5). GitHub keeps at most 100 pending runs in a group; a run cancelled while pending has written nothing and is not an evaluation. At most one Design run executes at a time, anywhere. Its job has a 20-minute timeout (proposed). With one owner, Design runs are rare and waiting behind another PR's run is acceptable; in exchange, per-PR ordering and the daily lock (§9) need no further coordination.

The token `design.yml` uses on the target repository has contents-read and pull-requests-write. It has no statuses permission. Pull-requests-write would also allow review objects and threads; Design not touching them rests on `design.yml` invoking none of that code (§6.1), not on the token.

## 5. Manifest and input

### 5.1 Location

The manifest is `.reviewbot/tasks/<task_id>.json` at the dispatched head. `task_id` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and equals the file name.

On the first Design run for a PR (or when an existing session has `manifestPath: null`), the host takes the files added or modified between the merge base and the head that match `.reviewbot/tasks/*.json`. Exactly one must exist. Later runs with a non-null `manifestPath` use the path recorded in the session.

**First-run manifest failure (CRB-v07-F02).** If zero or multiple files match `.reviewbot/tasks/*.json`, or if the candidate file fails schema or syntax validation before establishing a valid `task_id`, the run writes `DESIGN_BLOCKED / MANIFEST_INVALID` with `taskId: "UNASSIGNED"` and `manifestPath: null`. The session comment is created and bound to the PR. Having `manifestPath: null` explicitly identifies the session as unassigned, ensuring that subsequent runs re-execute manifest discovery across changed files instead of looking for a stale or non-existent recorded path. When the author subsequently commits a valid manifest, the next run sees `manifestPath: null`, discovers the valid manifest, updates `taskId` and `manifestPath` to the valid manifest in step 4, updates its local expected `taskId` under ISO-3, and continues to evaluation and publish.

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

**ISO-3, mutation (CRB-v07-F03).** Design has its own comment writer. Immediately before every PATCH or DELETE it re-fetches the comment by ID and verifies the ISO-2 conditions plus the expected `taskId` and `revision`. At the start of the run, the expected `taskId` is the one in the loaded session (or `"UNASSIGNED"` if recovering from an initial manifest failure). When a run replaces an unassigned manifest identity (`taskId: "UNASSIGNED"`, `manifestPath: null`) with a newly validated manifest's `taskId` (§5.1), the step 4 write verifies the existing `"UNASSIGNED"` `taskId`, writes the new `taskId`, `manifestPath` and revision `N+1`, and updates the run's expected `taskId` to the new `taskId` and expected revision to `N+1`. Subsequent intra-run writes (such as publishing in step 6 at revision `N+2`) verify against the updated `taskId` and updated revision `N+1`. This allows intra-run sequential writes and manifest recovery to proceed while strictly rejecting any external or concurrent mutation. `design.yml` invokes no Review session writer, thread reconciler, PR-review publisher or status writer.

**The Design session comment is the only Design decision.**

### 6.2 State

| Field | Meaning |
| --- | --- |
| `status`, `reason` | A status below and a machine reason code |
| `repo`, `pr`, `taskId`, `manifestPath`, `revision` | Identity; `revision` increments on every write. On initial manifest failure, `taskId: "UNASSIGNED"` and `manifestPath: null` (CRB-v07-F02) |
| `bundle`, `reviewedHead` | Bundle identity of the verdict, and the PR head the run that wrote this state was looking at. `reviewedHead` is set on every write, including `DESIGN_BLOCKED` |
| `briefAnchor` | Set at the first validated run; cleared by `reset design` |
| `round`, `maxRounds` | Completed evaluations and the limit |
| `retryCount` | Retries executed for the current `reviewedHead`. Incremented when evaluating a retry command for `DESIGN_BLOCKED` or when recovering from an abandoned `DESIGN_IN_PROGRESS` on head `H`; reset to 0 when `reviewedHead` moves or on `reset design` |
| `lastHandledCommentId` | ID of the source command comment processed by the latest write; updated on every write |
| `findings` | `{id, severity, status, file, location, title, detail}` |
| `spend` | Design-only Claude ledger: recorded USD, cap, last call's cost |
| `runStartedAt` | Set when a run writes `DESIGN_IN_PROGRESS` |
| `updatedAt` | Timestamp of the latest session comment write |
| `inFlight` | `{sourceCommentId, chargedUsd}` while the run's one Claude call is outstanding, else null |
| `processedSourceComments` | Comment IDs already handled; kept across `reset design` |

| `status` | Meaning | Reason codes |
| --- | --- | --- |
| `DESIGN_IN_PROGRESS` | A run is active | — |
| `DESIGN_PASS` | No open blocking finding for the recorded bundle | — |
| `DESIGN_REWORK` | Open blocking findings for the recorded bundle, or state reset | `RESET` (on `reset design`), otherwise findings |
| `DESIGN_BLOCKED` | No evaluation happened or none could be published | `MANIFEST_INVALID`, `INPUT_INVALID`, `POLICY_UNREADABLE`, `PROVIDER_UNAVAILABLE`, `INPUT_CHANGED`, `OUTPUT_REJECTED` |
| `HUMAN_REQUIRED` | A person must decide | `BRIEF_CHANGED`, `ROUNDS_EXHAUSTED`, `BUDGET_EXHAUSTED`, `DAILY_LIMIT` |

`USER WAIVED` remains a human record under the engineering policy. It is not a bot state.

### 6.3 Consuming the result

**A status alone never authorizes continuing.** An earlier `DESIGN_PASS` can stay visible after the documents change.

**Consumer architecture: deterministic orchestrator vs cognitive editing agent.**
The consumer of the decision function is an external **deterministic orchestrator** (a non-LLM script, runner, or CI harness), not an active LLM agent context. Deterministic orchestration — polling, waiting, command dispatch, deduplication, timeout handling, and retry limits — requires **zero LLM inference tokens**. LLM execution is reserved strictly for tasks requiring reasoning: modifying contract documents or manifests in response to findings.

The only sanctioned way to act on a Design result is the decision function, shipped as `scripts/design-status.mjs`:

1. Read the PR head, `H`.
2. Select the session by ISO-2. Where the table below needs it, compute the bundle identity at `H` from the session's `manifestPath`. Check for an active in-flight request for head `H` (`outstandingRequest`):
   - Query GitHub Actions workflow runs for `design.yml` targeting this repository, and query PR comments by authorized writers (§3 row 2). If querying GitHub Actions or PR comments fails, times out, or returns incomplete data (e.g. rate limit, pagination truncation), `design-status.mjs` fails closed: it outputs `{action: "stop", reason: "API_UNAVAILABLE"}` and exits with a non-zero code. It never assumes an absence of requests on network or API errors.
   - Evaluate active requests for head `H`:
     a) **In-flight Actions run:** A `design.yml` run targeting this PR with dispatched head `H` (matching `run-name: design/<repo>#<pr>@<head>:<commentId>`) is currently non-terminal in Actions (its status is not `completed` and its conclusion is null, covering `queued`, `in_progress`, `pending`, `waiting`, or `requested`). If matching: `outstandingRequest: { commentId: <parsed-commentId> ?? null, runId: run.id, status: run.status, createdAt: run.created_at, runStartedAt: run.run_started_at ?? null }`.
     b) **Pending dispatch:** A Design command comment on this PR authored by an authorized writer (§3 row 2), posted within 5 minutes (grace window for webhook/dispatch), without a completed or cancelled workflow run. The command comment may carry `<!-- design-head:<H> -->` or be an untagged manual command (presumed targeted at current PR head `H`). If no session exists yet, all authorized Design command comments within 5 minutes are eligible; if a session exists, the comment ID must not be in `processedSourceComments` and must exceed `session.lastHandledCommentId` (or if `session.lastHandledCommentId` is null, greater than 0). If matching (and no in-flight Actions run is matched yet): `outstandingRequest: { commentId: comment.id, runId: null, status: "dispatch_pending", createdAt: comment.created_at, runStartedAt: null }`.
   - If neither (a) nor (b) holds, record `outstandingRequest: null`. A request is confirmed terminated only when its Actions run has concluded (completed, cancelled, timed out, or action failure), or when a pending command receives no Actions run after the 5-minute dispatch window.
   - Count the unfulfilled commands posted on this PR carrying `<!-- design-head:<H> -->` posted after the latest completed evaluation (`DESIGN_PASS`, `DESIGN_REWORK`, or `DESIGN_BLOCKED`), or after the latest `reset design` command, or since head `H` became current (whichever is most recent). A **completed evaluation** is a workflow run that published a terminal session verdict (`DESIGN_PASS` or `DESIGN_REWORK`) or recorded a blocked state (`DESIGN_BLOCKED`). If `(session.reviewedHead == H && session.retryCount >= 2)` (2 retries executed after the initial review request for head `H`), or if 3 or more total commands (1 initial request + 2 retries) were posted for head `H` without producing a completed evaluation, flag `attemptsExhausted: true`.
3. Read the PR head again. If it is no longer `H`, start over, at most three times, then return `stop`.
4. Output a structured machine-readable JSON object on stdout and return `{action, head: H, bundle, reason, round, retryCount, findings, outstandingRequest}`:
   ```json
   {
     "action": "wait" | "request_review" | "fix_input" | "retry" | "revise" | "stop" | "continue",
     "head": "<git-sha>",
     "bundle": "<bundle-identity-sha>",
     "reason": "<reason-code>" | null,
     "round": 1,
     "retryCount": 0,
     "findings": [],
     "outstandingRequest": {
       "commentId": 123456 | null,
       "runId": 789012 | null,
       "status": "dispatch_pending" | "queued" | "in_progress" | "pending" | "waiting" | "requested",
       "createdAt": "2026-11-11T12:00:00Z",
       "runStartedAt": "2026-11-11T12:55:00Z" | null
     } | null
   }
   ```
   Exit code is 0 on successful status resolution (including `stop` verdicts), and non-zero on CLI or network failure (which also emits `{action: "stop", reason: "API_UNAVAILABLE"}` on stdout if possible). This interface permits an external non-LLM orchestrator to track outstanding requests, pipe findings, and resume after an interruption without maintaining an active LLM conversation.

| Condition | `action` |
| --- | --- |
| Reading the PR or its comments fails, or the newest Design comment fails ISO-2 | `stop` |
| Status is `HUMAN_REQUIRED` | `stop` |
| Status is `DESIGN_PASS`, identity equal | `continue` |
| Status is `DESIGN_REWORK`, identity equal, reason is not `RESET` | `revise` |
| Status is `DESIGN_BLOCKED` at `H`, reason `MANIFEST_INVALID` or `INPUT_INVALID` | `fix_input` |
| An `outstandingRequest` for head `H` is queued (non-running) and has been queued for 60 minutes or more | `stop` |
| An `outstandingRequest` for head `H` is active in queue (`dispatch_pending`, `queued`, `pending`, `waiting`, or `requested`) | `wait` |
| An `outstandingRequest` for head `H` is `in_progress` in Actions and `runStartedAt` is less than 30 minutes ago | `wait` |
| Status is `DESIGN_IN_PROGRESS` and (the workflow run is active in Actions or `runStartedAt` is less than 30 minutes ago) | `wait` |
| Evaluation attempts for head `H` are exhausted (`attemptsExhausted == true`) | `stop` |
| Status is `DESIGN_REWORK` and session reason is `RESET` | `request_review` |
| Status is `DESIGN_IN_PROGRESS` and `runStartedAt` is 30 minutes ago or more (and no active workflow run in Actions) | `request_review` |
| Status is `DESIGN_BLOCKED` at `H`, any other reason | `retry` |
| No Design session exists | `request_review` |
| Status is `DESIGN_BLOCKED` and `H` differs from the session's `reviewedHead` | `request_review` |
| Status is `DESIGN_REWORK` or `DESIGN_PASS`, and the bundle identity at `H` differs from the session's or cannot be computed | `request_review` |

The rows are evaluated in order. What each action asks of the consumer:

- `wait`: non-LLM orchestrator pauses (sleep) and calls again later; consumes zero LLM tokens. While a run is non-terminal in GitHub Actions (`queued`, `in_progress`, `pending`, `waiting`, or `requested`, even past 30 minutes in a congested queue), `wait` is returned continuously without duplicate requests.
- `request_review`: non-LLM orchestrator posts the Design command with `<!-- design-head:<H> -->`.
- `fix_input`: non-LLM orchestrator passes the error reason to the editing agent, which corrects the manifest or listed files and pushes; the orchestrator then posts the Design command.
- `retry`: nothing in the repository needs to change. Non-LLM orchestrator posts the Design command with `<!-- design-head:<H> -->`. The session state and comment history track attempts, persisting across orchestrator restarts. At most 2 retries (3 total attempts for the same head H) are permitted; subsequent attempts are rejected with `stop`.
- `revise`: non-LLM orchestrator transfers open findings to the editing agent, which modifies the contract documents to address them and pushes; the orchestrator then posts the Design command.
- `stop`: non-LLM orchestrator reports to the person and terminates (including when an unstarted request exceeds the 60-minute queue timeout with reason `QUEUE_TIMEOUT`).
- `continue`: see below.

**What `continue` authorizes.** Exactly this: the listed documents as they are at commit `H` passed. The result is a statement about `H`, not about the branch. A consumer bases its work on `H`, and calls the function again before relying on the pass at any later commit, in particular before it hands the task on.

**Outstanding requests, queue separation, and interruption recovery.** When the orchestrator posts a Design command comment (either for a new review or for a retry), GitHub Actions dispatches the workflow asynchronously. Because `design.yml` runs in a single global concurrency group across the repository, runs may wait in non-terminal status (`pending`, `queued`, `waiting`) during high activity. `design-status.mjs` checks Actions run state: as long as a run for this PR and head `H` is non-terminal in Actions (covering `queued`, `in_progress`, `pending`, `waiting`, `requested`), it returns `wait` with `outstandingRequest` populated, completely eliminating duplicate review commands caused by arbitrary time limits. Only when a run is confirmed terminated (completed, cancelled, timed out) without publishing a session, or when a command receives no workflow dispatch after 5 minutes, is the request treated as terminated, allowing `request_review` or `retry` up to the 2-retry bound. Persistent `retryCount` and PR comment history guarantee that restart or multiple invocations of the orchestrator enforce the at-most-2-retries limit deterministically.

**Queue timeout vs running timeout separation (CRB-v09-F03, CRB-v10-F02).** Timeouts strictly separate queue waiting from active execution duration:
- **Queue phase timeout (60 minutes):** While a request is in queue or pending dispatch (`status` is `"dispatch_pending"`, `"queued"`, `"pending"`, `"waiting"`, or `"requested"`), it has a maximum wait upper bound of 60 minutes (`maxQueueWaitMs: 3600000`) measured from request creation. If queue wait reaches 60 minutes without starting, `design-status.mjs` returns `stop` with `reason: "QUEUE_TIMEOUT"`. It does not re-dispatch, does not retry, and does not burn daily runs.
- **Execution phase timeout (30 minutes):** Once the Actions run transitions to `in_progress`, queue phase timeout no longer applies. The execution timer is governed by `run.run_started_at` (or `session.runStartedAt`), matching the 20-minute job timeout plus buffer. An active run executing for less than 30 minutes continuously returns `wait`, ensuring a run that waited 55 minutes in queue before executing is never prematurely aborted. A run still `in_progress` after 30 minutes is treated as an abandoned dead run (§8, CRB-DEC-01).

**Concurrent orchestrators, canonical lock directory, and atomic mutual exclusion (CRB-v09-F02, CRB-v10-F01).** Exactly one orchestrator process owns a target PR at any time:
- **Canonical lock directory:** To prevent collisions between multiple Git worktrees or directories on the same host targeting the same PR, orchestrators use a canonical lockfile in the system runtime directory: `${TMPDIR:-/tmp}/crb-orchestrator/<owner>_<repo>_<pr>.lock`.
- **Atomic exclusion covering check and dispatch:** The orchestrator acquires an exclusive OS file lock (`flock(2)` or atomic `open(O_CREAT | O_EXCL)`) before calling `design-status.mjs` and retains it through command dispatch. If the lock is held, a secondary orchestrator process exits or waits without querying GitHub or posting commands.
- **Concurrency scope:** Mutual exclusion is strictly guaranteed across processes on the same host (the single developer machine per PR under the single-owner model, CRB-DEC-04). Multi-host concurrency across distributed machines is explicitly out of scope.
- **Auxiliary comment deduplication:** In addition to local file locking, if an authorized writer posted any Design command on the PR within the previous 15 seconds (or an unhandled command targeting head `H` within the 5-minute dispatch window), `design-status.mjs` returns `wait` with `status: "dispatch_pending"`, suppressing redundant comments as defense-in-depth against unclean process restarts.

**Abandoned runs.** A run that is killed after writing `DESIGN_IN_PROGRESS` leaves that status behind, and nothing dispatches a successor by itself. The job timeout is 20 minutes, so a status still in progress after 30 minutes belongs to a dead run. If evaluation attempts for head `H` are exhausted (`attemptsExhausted == true`, through `retryCount >= 2` or 3 unfulfilled attempts), the decision function returns `stop`. Otherwise, it returns `request_review`. The consumer, which is the deterministic orchestrator in the automated loop, posts the Design command again. That run settles the abandoned charge first, increments `session.retryCount` (§8 step 3), and evaluates (§8, CRB-DEC-01). No person relays anything. Two evaluations cannot overlap, because Design runs execute one at a time (§4).

A PR head can change at any time, so no check can promise the branch will not move afterwards. Binding the answer to `H` makes that harmless: an answer about `H` stays true, and it does not cover a later commit.

### 6.4 Rounds and findings

A round is one evaluation ending in `DESIGN_PASS` or `DESIGN_REWORK`. `maxRounds` is 3 (proposed). A third evaluation with open blocking findings gives `HUMAN_REQUIRED / ROUNDS_EXHAUSTED`. `DESIGN_BLOCKED` consumes no round. `reset design` sets `round` to 0.

P0, P1 and P2 block; P3 does not, and at most 8 are listed. A blocking finding must name the file and location, what it contradicts (a brief item, a stated invariant, another part of the contract, or a cited code fact) and the correction required; otherwise it is recorded as P3.

Every evaluation reads the whole current bundle and rules on each previously open finding. A pass requires all listed files read in full, no open blocking finding, and every earlier blocking finding ruled fixed. Model output must validate against a JSON schema with bounded field lengths. Findings are listed in the session comment.

## 7. Brief tripwire

When a Design run first passes validation for a PR, the host records the brief's path and blob SHA as the **brief anchor**, or records that there is no brief. On a later run, a brief that differs from the anchor, or was added or removed, gives `HUMAN_REQUIRED / BRIEF_CHANGED` before any model call. `reset design` clears the anchor.

This is a tripwire for the case the workflow must catch: an agent editing the brief while fixing findings. It is not a security boundary (CRB-DEC-03).

## 8. Run protocol

1. **Load.** Check that the live PR is open and that its base and head equal the dispatched SHAs. If they do not, the run ends here and **writes nothing**: a run that was queued for an earlier head must not replace the session, which may hold a valid verdict. The consumer learns what to do from the decision function at the present head (§6.3). Otherwise select the session (ISO-2), or start an empty one. If `H` differs from `session.reviewedHead`, reset `session.retryCount` to 0.
2. **Settle first.** If `inFlight` is set, add `chargedUsd` to `spend` and clear it. This happens before anything else in every run that loads a session, including `reset` and runs that then stop for any reason (CRB-DEC-01).
3. **Validate, no model call.**
   - If the source comment is in `processedSourceComments`, write the settlement if step 2 made one, and stop.
   - For `reset`: write `DESIGN_REWORK` with reason `RESET`, `bundle: null`, `round: 0`, `retryCount: 0`, `findings: []`, clear `briefAnchor`, record the source comment in `processedSourceComments`, update `lastHandledCommentId` and `updatedAt`, and stop (§4, §6.2, CRB-v07-F04).
   - If the session at `H` is already `DESIGN_BLOCKED` or `DESIGN_IN_PROGRESS` (recovering from a prior blocked result or an abandoned in-progress run on head `H`), increment `session.retryCount` for this evaluation attempt.
   - Validate the manifest and files (§5), compute the bundle identity, read the policy, check the brief anchor. If any check fails, or if `round` is exhausted, write the resulting `DESIGN_BLOCKED` or `HUMAN_REQUIRED` status with `reviewedHead: H`, `session.retryCount`, `updatedAt`, `lastHandledCommentId`, and the source comment recorded in `processedSourceComments`, and stop. On an initial manifest failure (§5.1), write `taskId: "UNASSIGNED"` and `manifestPath: null` (CRB-v07-F02).
   - If the session holds a pass or rework for this exact bundle identity, record the command as processed, re-surface the result and stop.
   - Check `round`.
4. **Admit and charge.** Decide now whether this run may use Claude, by applying the three locks in §9. Write the session as `DESIGN_IN_PROGRESS` with `runStartedAt`, `updatedAt`, `lastHandledCommentId`, `session.retryCount`, the brief anchor and, if Claude was admitted, `inFlight` set. Update local expected revision to `N+1` and, if transitioning from an unassigned manifest session (`manifestPath: null`), update local expected `taskId` to the validated manifest's `taskId` (ISO-3, CRB-v07-F03). If this write fails, stop before any model call.
5. **Evaluate.** **A Design run makes at most one Claude SDK invocation.** There are no shards, no retries and no second fallback. `@gemini design` tries Gemini and, only if Gemini cannot complete and Claude was admitted in step 4, makes the one Claude invocation. `@claude design` makes the one Claude invocation. If that invocation fails, the run publishes `DESIGN_BLOCKED / PROVIDER_UNAVAILABLE` with `reviewedHead: H`, `session.retryCount`, `updatedAt`, `lastHandledCommentId`, and the source comment recorded in `processedSourceComments`. Shared read-only provider execution. The model receives the listed files, the reviewer policy, prior findings, and the existing sanitized read-only tools over the snapshot at the head. It receives no GitHub token.
6. **Publish.** Recompute the bundle identity at the PR's present head. If unchanged, write the verdict, findings, incremented `round`, `retryCount: 0`, `updatedAt`, `lastHandledCommentId`, the call's cost in place of the charge, `inFlight: null`, and the processed command. If changed, write `DESIGN_BLOCKED / INPUT_CHANGED` with the same spend settlement, `retryCount: 0`, `updatedAt`, `lastHandledCommentId`, and the processed command.

`design.yml` does not print file contents, policy text or model output to logs or the job summary. Target repositories can be private while this repository's logs are public.

## 9. Spend locks

The requirement is the user's: a Claude call that misbehaves must not be able to burn tokens without limit, and a crash must not be a way around the limit. Three locks apply to Claude. Gemini keeps the existing provider budget controls.

| Lock | Rule | Proposed value |
| --- | --- | --- |
| Per call | `maxBudgetUsd` and the adapter's turn limit are passed to the SDK; the job timeout ends a run that does not return. A run makes at most one Claude call | USD 2, 20 minutes |
| Per PR | Claude is admitted for a run only if `cap − spend ≥ per-call amount`. The full per-call amount is recorded as `inFlight` **before** the call (§8 step 4) | USD 6 cap |
| Daily, all PRs | Before admitting Claude, the host counts the `design.yml` runs created in this repository in the last 24 hours, in any state and including the present run. If `count > 20`, or if the count cannot be read, the status is `HUMAN_REQUIRED / DAILY_LIMIT` (CRB-v07-F05) | 20 runs |

**One run, one call, one charge.** Admission happens once per run and covers exactly the one Claude invocation the run may make (§8 step 5). `inFlight` therefore never stands for more than one paid call, and no call starts without its own recorded charge.

**Why the daily count needs no reservation.** The count is of runs created, not of calls admitted, so it also counts resets and blocked runs; that errs toward refusing. Design runs execute one at a time (§4). When a run reads the count, every Design run that executed before it has ended and is in the listing, and runs still pending can only raise the count. Two commands arriving together on different PRs therefore cannot both be admitted past the limit: whichever executes second sees the first. Exactly 20 runs in any rolling 24-hour window are admitted (`count <= 20`); the 21st run is refused with `HUMAN_REQUIRED / DAILY_LIMIT` (CRB-v07-F05). If the listing cannot be retrieved, the run fails closed. This rests on one assumption, to be confirmed in S3: a completed run appears in the Actions run listing by the time the next run in the group starts.

**Settlement.** On publish, the call's provider-reported cost replaces the charge, including any amount above the per-call value. With no reported cost, the full charge stands. If the run completed without invoking Claude, because Gemini finished the evaluation, the charge is released and nothing is recorded. Design supplies no smaller fallback cost to the shared budget manager (§3 row 11).

**Why a crash cannot bypass the per-PR lock.** The charge is written before the call, and every later run settles it first (§8 step 2). A killed run therefore costs the full per-call amount on the ledger whether or not it actually spent it.

**Why the daily lock exists.** The per-PR ledger lives in a comment that can be deleted, and `reset design` restarts the round count. The daily count is kept by GitHub Actions, outside the PR, and bounds the total across PRs, resets and deleted sessions.

**Visibility.** The session comment shows recorded spend, the cap, the last call's cost and the round count. The job summary shows the same numbers.

When Claude is not admitted, `@gemini design` still runs on Gemini alone. If Gemini cannot complete, or the command is `@claude design`, the status is `HUMAN_REQUIRED / BUDGET_EXHAUSTED`.

The three lock values were confirmed by the user on 2026-11-11. They limit usage; they are not authority to enable paid Design runs, which S4 requires separately.

What the locks are: admission accounting plus per-call limits passed to the SDK. What they are not: a verified hard ceiling on actual subscription token use, because SDK enforcement of `maxBudgetUsd` is unverified (§3).

### Cost model and token efficiency

The architecture separates three distinct cost dimensions:

1. **Design Bot evaluation cost**: Model tokens consumed during evaluation runs on GitHub Actions. Bounded and controlled by the spend locks above (USD 2 per call, USD 6 per PR, 20 runs per day).
2. **Editing Agent modification cost**: Model tokens consumed locally by the coding agent (e.g., Claude Code, Gemini CLI) when performing reasoning tasks (revising contracts or fixing input errors). Bounded by local agent configuration and turn limits.
3. **Orchestration overhead**: Non-LLM operations. Polling, waiting, deduplicating, dispatching commands, and handling retries consume **zero LLM inference tokens**.

## 10. Recorded decisions

Decisions of the user, all dated 2026-11-11. The behaviors listed are **intended, not defects**, and must not be reported or "fixed" as bugs without a new decision. The implementation cites each ID in a code comment at the relevant branch, in a test named for it, and in one README sentence. CRB-DEC-04 is in §2.

### CRB-DEC-01: an interrupted run is re-run automatically

A run that finds `inFlight` set adds the full charge to `spend`, clears it and carries on. If the locks allow, the bundle is evaluated again with no person involved. The run that does this is started by the next Design command; in the automated loop the deterministic orchestrator posts it after the decision function reports the abandoned run (§6.3).

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
| AC5 | Freshness, abandonment, and token-efficient orchestration (§6.3, §9) | Every row of the decision table. **No session, and no active `outstandingRequest`, gives `request_review`.** `DESIGN_BLOCKED` gives `request_review` when the head has moved since, `fix_input` for the two input reasons and `retry` for other reasons (`session.retryCount < 2`), or `stop` (`session.retryCount >= 2`). **Stale queued run:** with a pass recorded for the present head, a queued run dispatched for an earlier head changes nothing, and the decision function still returns `continue`; with a rework recorded, it still returns `revise`. A listed file changed after a pass gives `request_review`. A code-only commit after a pass gives `continue` with the new head. A push between the two head reads is detected. An unreadable session gives `stop`. No case returns `continue` with a head whose bundle was not evaluated. **Zero-token orchestration & queue separation (CRB-v07-F01, F06):** repeated status checks during a pending review consume zero LLM tokens; queue latency in the single concurrency group maintains `wait` without duplicate requests while the run is `queued` or `in_progress` in Actions; target head binding (`<!-- design-head:<H> -->` / `run-name`) prevents earlier commands from stalling a new head; `retryCount` persisted in session state bounds retries across orchestrator restarts; PASS and terminal states end orchestration without LLM invocation; REWORK transfers structured findings to the editing agent; an interrupted orchestrator resumes from `design-status.mjs` state without duplicate evaluations. **Initial request & untagged command waiting (CRB-v09-F01, CRB-v10-F03):** with no prior session, an untagged manual command within 5 minutes returns `wait` with `runId: null` and `status: "dispatch_pending"`; when that 5-minute window expires without an Actions run, it returns `request_review`; Actions API failure exits non-zero and returns `stop` with `reason: "API_UNAVAILABLE"`. **Cross-worktree mutual exclusion (CRB-v09-F02, CRB-v10-F01):** two orchestrator processes in different Git worktrees or directories on the same host targeting the same PR acquire a canonical OS lockfile (`${TMPDIR:-/tmp}/crb-orchestrator/<owner>_<repo>_<pr>.lock`) covering status check and dispatch, emitting at most one command under simulated race. **Queue timeout vs running timeout (CRB-v09-F03, CRB-v10-F02):** a run queued for 55 minutes that starts executing at minute 55 continues returning `wait` during its active execution (< 30 minutes since start), and is never prematurely aborted by the 60-minute queue timeout; an unstarted request remaining in queue for 60 minutes or more returns `stop` with `reason: "QUEUE_TIMEOUT"` without re-dispatching |
| AC6 | Loop | A seeded contradiction gives rework; a fix gives a full re-review that rules the old finding fixed and passes; three reworks give `ROUNDS_EXHAUSTED` |
| AC7 | Spend locks (§9) | Charge is written before the call. **One call per run:** with Gemini failing and Claude failing, the run makes exactly one Claude invocation and ends blocked; with USD 4 recorded, a run cannot make a second Claude invocation under one charge. **Abandoned run:** kill a run after the charge is written and post no human comment; after 30 minutes the decision function returns `request_review`, the orchestrator's repeated command settles the charge first and re-evaluates, and no pass is visible before that evaluation completes (CRB-DEC-01). **Daily lock under concurrency (CRB-v07-F05, CRB-v09-F04):** Exactly 20 runs in any rolling 24-hour window are admitted (`count <= 20`); the 21st run is refused with `HUMAN_REQUIRED / DAILY_LIMIT` (`count > 20`). Test boundary cases 19 (admitted), 20 (admitted), and 21 (refused). With 19 runs counted, start Design on two different PRs at once, holding each just before admission; the runs execute one after the other and exactly the limit is admitted; repeat after deleting a session comment and after repeated resets. With USD 4 recorded and USD 2 in flight, a `reset` followed by a command admits no Claude call. Reported cost above the per-call amount is recorded in full (CRB-DEC-02). The daily limit refuses when `count > 20` and when the count cannot be read. Review's ledger is unchanged throughout |
| AC8 | Logs | With a sentinel string in a listed file and in model output, the sentinel appears in no log or job summary |

Evidence must separate tests run, CI logs, model claims and observations on a real PR. A live test must confirm the deployed Worker revision.

## 13. Stages

- **S1 Gate.** Independent review of this document at its `design_ref`.
- **S2 Routing and validation, no model call.** Commands, `design.yml`, manifest validation, brief anchor, session writer with ISO-1 to ISO-3, the decision function. AC1 to AC5. Verified using deterministic non-LLM test drivers without requiring an external production agent platform.
- **S3 Evaluation.** Provider call, findings, rounds, spend locks. AC6 to AC8 with providers stubbed.
- **S4 Live.** Only with separate authorization to deploy and to spend. One rework-to-pass loop and one Review lifecycle on real PRs.

## 14. Changes from v0.10, and the response to earlier reviews

### Changes from v0.10 (Resolution of v0.10 independent review findings CRB-v10-F01–F03)

v0.10 addressed initial waiting states, orchestrator deduplication, and queue timeouts. The independent review of v0.10 returned two P2 findings and one P3 finding on mutual exclusion scope and timeout semantics, all resolved here:

| Source | Problem | Correction |
| --- | --- | --- |
| Independent review CRB-v10-F01 (P2) | Relative lockfile path (`.design-orchestrator.<pr>.lock`) failed mutual exclusion across different Git worktrees; 15-second comment check was non-atomic | Specified canonical lockfile path in the system runtime directory (`${TMPDIR:-/tmp}/crb-orchestrator/<owner>_<repo>_<pr>.lock`) in §6.3. Mandated atomic OS file locking (`flock(2)` or atomic creation) covering both status checking and command dispatch. Explicitly scoped concurrency to single-host mutual exclusion under the single-owner model (CRB-DEC-04) |
| Independent review CRB-v10-F02 (P2) | Measuring 60-minute queue timeout from request creation aborts actively running evaluations that queued for near 60 minutes before starting | Separated Queue phase timeout from Execution phase timeout in §6.3. Queue phase timeout (60 minutes) strictly applies only while the request is non-running in queue (`dispatch_pending`, `queued`, `pending`, `waiting`, `requested`). Once the run enters `in_progress`, timeout is governed by run execution time (`runStartedAt`) under the 20-minute job timeout (+10m buffer), ensuring runs queued for 55 minutes that run for 15 minutes are never prematurely stopped |
| Independent review CRB-v10-F03 (P3) | AC5 text stated "No session gives `request_review`", which appeared to conflict with the waiting state on initial untagged requests | Qualified AC5 requirement: "No session, and no active `outstandingRequest`, gives `request_review`", and added explicit test cases for (1) no session and no request, (2) no session with active request within 5m grace, and (3) no session with expired grace window |

### Changes from v0.9 (Resolution of v0.9 independent review findings CRB-v09-F01–F04)

v0.9 addressed the primary queued-state separation and lifecycle hardening. The independent review of v0.9 returned four boundary findings (CRB-v09-F01 through F04), all resolved here:

| Source | Problem | Correction |
| --- | --- | --- |
| Independent review CRB-v09-F01 (P2) | Waiting state was incomplete for initial review requests and manual untagged commands before a workflow run is visible; `runId` lacked null definition in JSON schema; Actions API failure could default to assuming no request | Expanded pending dispatch rule in §6.3 to cover untagged manual commands within 5 minutes even when no session exists yet, populating `outstandingRequest` with `runId: null` and `status: "dispatch_pending"`. Explicitly defined `runId: number \| null` in JSON schema. Specified fail-closed behavior on Actions API/network failure (exits non-zero, outputs `{action: "stop", reason: "API_UNAVAILABLE"}`) |
| Independent review CRB-v09-F02 (P2) | Concurrently running orchestrator instances on the same PR could race on checking outstanding requests and post duplicate commands | Established single-orchestrator per PR principle in §6.3. Defined local mutual exclusion via PR-scoped lockfile (`.design-orchestrator.<pr>.lock`) and 15-second comment post deduplication protocol, suppressing duplicate dispatches if multiple processes run simultaneously |
| Independent review CRB-v09-F03 (P2) | Non-terminal Actions status lacked a total queue wait upper bound, causing infinite `wait` if a runner or queue stalled indefinitely | Introduced a 60-minute total queue wait upper bound in §6.3. If an outstanding request remains non-terminal for 60 minutes or more, `design-status.mjs` returns `stop` with `reason: "QUEUE_TIMEOUT"` without re-dispatching |
| Independent review CRB-v09-F04 (P3) | AC7 still contained ambiguous wording ("refuses at the threshold") despite §9 specifying `count <= 20` admitted and `count > 20` refused | Unified AC7 wording to explicitly state "20th run admitted, 21st run refused" and mandated testing boundary conditions 19, 20, and 21 |

### Changes from v0.8 (Resolution of v0.7 independent review findings F01–F06)

v0.8 addressed the initial architecture clarification for token-efficient agent orchestration. The full independent engineering review of v0.7 returned six prioritized findings (F01–F06), all resolved here:

| Source | Problem | Correction |
| --- | --- | --- |
| Independent review F01 (P1) | Queued requests exceeding 30 minutes in the global concurrency group returned `request_review`, triggering duplicate commands and exhausting the 20-run daily limit | Separated `queued` vs `in_progress` vs `terminated` states via GitHub Actions run queries in §6.3. As long as a run is `queued` or `in_progress`, `design-status.mjs` returns `wait`, regardless of queue latency. A run is only re-requested when confirmed terminated without writing or if dispatch failed after a 5-minute grace window (§6.3, AC5) |
| Independent review F02 (P2) | When the first manifest is invalid, the session had no established `taskId` or `manifestPath` to allow subsequent recovery | Defined fallback identity for initial manifest failures in §5.1 and §6.2: `taskId: "UNASSIGNED"` and `manifestPath: null`. Subsequent runs re-trigger manifest discovery while `manifestPath` is null, updating `taskId` and `manifestPath` once valid and updating expected `taskId` under ISO-3 in step 4 |
| Independent review F03 (P2) | ISO-3 checked comment revision against the initial revision loaded at the start of the run, conflicting with sequential writes in a single run (e.g. step 4 writing in-progress, step 6 publishing) | Clarified ISO-3 in §6.1: a run tracks its own incremented expected revision and updated expected `taskId` across sequential writes, allowing internal multi-write execution and unassigned manifest recovery while rejecting external/concurrent mutations |
| Independent review F04 (P2) | `reset design` left session status and next consumer action undefined | Defined `reset design` state in §4, §6.2, and §6.3: session status is written as `DESIGN_REWORK` with reason `RESET` and `bundle: null`; `design-status.mjs` maps `reason: RESET` directly to `request_review` |
| Independent review F05 (P3) | Daily 20-run limit boundary was described ambiguously ("at most the limit", "refuses at threshold", "above the limit") | Clarified in §9: exactly 20 runs per rolling 24-hour window are admitted (`count <= 20`); the 21st run is refused with `HUMAN_REQUIRED / DAILY_LIMIT` |
| Independent review F06 (P3) | Token-efficient agent orchestration, request tracking, and retry recovery | Defined non-LLM Deterministic Orchestrator boundary in §1 and §6.3 (0 LLM tokens for polling/waiting/retrying). Structured machine-readable JSON output for `design-status.mjs`. Added explicit target head marker `<!-- design-head:<H> -->` and `design.yml` `run-name`. Persisted `retryCount` in session state to deterministically enforce the 2-retry limit across restarts. Established the three-bucket cost model in §9 and updated AC5 |

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
| F03 P1, no recovery trigger | The decision function reports an in-progress status older than 30 minutes as `request_review`, and the orchestrator posts the command again. Global serialization prevents overlapping evaluations (§6.3). AC5, AC7 |
| Row 12 citation | Corrected to the Claude adapter's lines (§3) |

Earlier findings, as the v0.5 reviewer ruled them: v0.4 F01 and F02 resolved; F03 partially resolved, now addressed above; F04 removed from scope by CRB-DEC-04.

## 15. Open items

- **Confirmed by the user on 2026-11-11.** `Jiaze-Li/personal-skills` is public. The lock values are USD 2 per call, USD 6 per PR and 20 runs per day.
- **Still proposed.** Three rounds; 64 KiB and 256 KiB; the 20-minute job timeout and the 30-minute abandonment threshold. They need the user's confirmation before S3.
- **To verify in S3.** That a completed run is in the Actions run listing when the next run in the group starts (§9).
- **Deployment parity.** The deployed Worker revision is unverified.
- **Authorization for this PR.** The user authorized documentation-only changes to this contract PR. Not authorized: implementation, merge, deployment, paid Design runs, credential or App permission changes, branch protection changes.
