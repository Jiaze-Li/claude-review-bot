# CRB-DESIGN-01 — Design Task Architecture Contract v0.2

**Status:** REVISED DRAFT / independent DESIGN Gate **PENDING** (v0.1: DESIGN REWORK, D01–D03; v0.2 not approved for implementation)  
**Target repository:** `Jiaze-Li/claude-review-bot`  
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`  
**Reviewed-code reference baseline (read-only):** `179569d7b434012c9024b43a19e20e2028a3a4e4` (`main` at initial design)  
**Risk / architecture basis / gate:** Tier 3 / REQUIRED / PENDING — touches the review service's shared session/publication/security boundary.  
**Immutable `design_ref`:** assigned externally as `git:Jiaze-Li/claude-review-bot@<actual-contract-commit>:docs/design-task-architecture-contract-v0.2.md` after this exact document is committed. Do not substitute a moving branch name or the PR number. The ref must be checked by the independent Reviewer against the bytes in that commit.  
**Contract authority:** this document proposes how to extend the bot; it does **not** change any existing frozen project contract, grant deployment or merge authorization, or approve itself.

## 1. Purpose and non-goals

Add an explicitly invoked **`design` Task Type** to the existing PR review service, while preserving the already deployed `review` Task Type. The operating model is **one review bot, shared infrastructure, independently owned task-specific review flows**.

- `review` evaluates implementation changes: defects, regressions, tests, and established correctness constraints.
- `design` independently evaluates specified architecture/engineering contracts against a fixed policy snapshot, relevant actual source context and architectural invariants.
- Both reviewers are **read-only** with respect to repository contents and formal contracts. They return findings and decisions through GitHub PR comments/review output. An independently authorized GPT/Coding Agent may edit a contract or code, commit/push, and request a fresh review.
- Design runs **only** on an authorized explicit PR comment. Opening/updating a PR never automatically starts Design. Existing automatic Code Review triggers remain unchanged.

Not in scope: arbitrary free-form `@gemini prompt ...` commands; a new model orchestration platform; changes to existing code-review acceptance policy; automatic code/contract edits by the reviewer; forced merge or deployment; a new persistent database; an always-running GPT repair agent; and automatic cross-task review invalidation/re-triggering beyond the existing Code Review behavior.

## 2. Verified baseline versus proposal

The following are **code inspection facts**, not a statement about current deployed Worker version:

| Existing component | Current relevant behavior (baseline above) | Proposed reuse |
| --- | --- | --- |
| `worker/src/review-trigger.js`, `worker/src/index.js` | strict leading-line commands and Webhook dispatch, GitHub writer authorization | add explicit Design command routing; do not change Review commands |
| `scripts/provider-adapter.mjs`, `scripts/review-orchestrator.mjs` | provider adapters, fallback, circuit breaker, budgets, deadline and bounded execution | share the provider execution machinery |
| `scripts/plan-review-session.mjs`, `scripts/review-session-core.mjs` | Review-specific durable session lookup, findings, READY/REWORK/PARTIAL, full/delta logic | preserve Review state machine; make Design a separately owned protocol |
| `scripts/session-comment.mjs` | edits own current session, posts a new result and deletes its old session comment when necessary | reuse ownership-checked lifecycle; each Task Type manages only its own comments |
| `scripts/sync-commit-status.mjs` | Review status context is `claude-review-bot/review` on an exact commit | preserve Review; Design must not write the same context |
| `.github/workflows/review-v2.yml` | serialized per target PR, exact HEAD capture, trusted diff context, workflow reviews | retain existing Review behavior and per-PR serialization initially |

The first Design implementation needs to inspect the entire applicable target contract and relevant source context, not only a PR's changed lines. Model-generated judgments, local tests, and deployment version remain separate evidence classes.

## 3. Commands, routing and provider independence

| PR command (first nonblank line) | Task Type | Provider selection |
| --- | --- | --- |
| `@gemini review` | `review` | existing Gemini-first/fallback behavior **unchanged** |
| `@claude review` | `review` | existing Claude-only behavior **unchanged** |
| `@gemini design` | `design` | Gemini-first, with the same applicable fallback mechanism |
| `@claude design` | `design` | Claude-only, with existing provider constraints |

Internally, route a command as `taskType + providerPolicy + sourceCommentId + target PR identity`; **`taskType` is not the provider and `providerPolicy` is not a review verdict**. Unknown, malformed, quoted, or embedded commands do not execute. Existing `reset`, `dismiss`, `override`, thread-resolution and legacy aliases keep their existing Review behavior. Do **not** implicitly apply those commands to Design without a separately specified and tested Design semantics.

### 3A. Fixed manifest and trusted invocation authority (D01)

Design v1 uses **one authoritative, versioned manifest** committed as ordinary UTF-8 bytes at `.reviewbot/design-task.json` in the **exact PR HEAD Git tree**. The mutable PR description is display-only and **never** supplies or overrides the `policy_sha`, `design_ref`, task scope or authorization. Therefore editing PR description without moving HEAD cannot silently alter the review subject.

The manifest has a strictly validated bounded schema, conceptually:

```json
{
  "schema_version": 1,
  "task_id": "EXAMPLE",
  "contract_version": "v0.1",
  "policy_sha": "<40-character commit SHA>",
  "contracts": [{"path": "docs/architecture/example.md"}],
  "baseline": {"repository": "owner/repo", "sha": "<40-character commit SHA>"},
  "evidence_refs": []
}
```

This is a *schema example*, not a new independent authority for CRB-DESIGN-01 itself. The host derives each primary `design_ref` from `git:<target-repo>@<pinned-pr-head>:<validated-path>`; never embed a commit's own hash in the contract that creates it. Multiple required contracts must be **enumerated individually**, with full bytes and fingerprints. External evidence/contract refs require exact repo, SHA and path, approved repository/path scope, and bounded content. Reject moving refs, symlinks, submodules, untrusted URLs, hidden instructions and unbounded context expansion. No model or source document may widen host access.

The authorizing event is a **new PR Conversation comment** with a leading exact `@gemini design` or `@claude design`, issued by a GitHub writer. The webhook captures a task-qualified **invocation envelope**: target repo and PR, authenticated author, original comment ID and body SHA-256, command/task type, provider policy, base/head SHAs, immutable manifest Git blob SHA or content digest, frozen `policy_sha`, the full derived contract-ref set and scope. The expected input is fixed **at dispatch**, not silently reinterpreted later.

Before **any paid model call** and again **before finalization**, the trusted runner independently re-fetches the exact source comment, checks its real GitHub author, writer permission, PR ownership, unedited body, exact first-line command and source ID; re-fetches PR base/head and the HEAD-bound manifest, re-derives `policy_sha`, `design_ref` and scope, and compares all with the captured envelope. It must reject untrusted `workflow_dispatch`/`workflow_call` parameters unless an authentic eligible comment and matching envelope can be proven. Manual workflow dispatches do not bypass command authorization. A deleted/edited comment, wrong repo/path, changed HEAD or manifest, policy mismatch or inaccessible referenced material yields **DESIGN BLOCKED before billing or PASS**. Only a new explicit comment after a new contract commit can authorize a new-ref review.

The human or an authorized GPT needs only to commit the manifest and contracts and send the short command; arbitrary natural-language `@gemini prompt ...` is not required. PR content and manifests remain **untrusted data**, never provider system instructions.

## 4. Shared trunk and bounded extraction

The shared trunk owns **GitHub event/auth validation, bounded source acquisition, provider adapters/model requests, provider fallback/circuit-breaker, resource limits/charging, basic publication and audit/error helpers**. Task-specific branches own their review input rules, prompt/schema, findings interpretation, validity/gate decision, session state transitions and task-specific presentation.

Implementation may extract a **small, behavior-preserving shared helper** when both task types genuinely use it (e.g., publisher with owner-specific marker, comment safety checks, provider executor). Do not migrate the entire existing `review-session-core.mjs` into a generic framework or rewrite `review-v2.yml` merely for symmetry. Avoid introducing a parallel model stack, duplicated token holder, or second task controller. Follow existing error/privilege limits.

## 5. Session, findings, comment and commit-status ownership

**Invariant D-OWN-01 — Independent state:** `review` and `design` must have different, unambiguous, host-verified session namespaces, parsers and writer selection. For example, preserve `<!-- jiaze-review-session:v1 -->` for Review and use `<!-- jiaze-design-session:v1 -->` for Design. Each owns its state, finding IDs, attempt/verification history, provider charges, and comment IDs. A Review writer must not load/modify Design state, nor vice versa. Discovery and recovery may rely only on comments whose authenticated author and exact task marker both match.

**Invariant D-OWN-02 — Own-comment lifecycle:** Both types may post a current status, edit their own current session or remove their **own superseded status comments**, following the existing Review cleanliness philosophy. Do not impose append-only accumulation. Before PATCH/DELETE, re-fetch and verify **GitHub comment ID, actual bot author, expected task marker and expected session identity**; an unknown/ambiguous record fails closed. No task may edit/delete another type's comments or findings, or user-authored discussion. Preserve essential evidence (reviewed immutable ref, findings and decisions) in retained current results/immutable source references even when stale status messages are cleaned up. “Own comment” cannot be established by a body marker alone.

**Invariant D-OWN-03 — Separate commit status:** Preserve existing `claude-review-bot/review` context exactly. Design may publish its result only under a distinct `claude-review-bot/design` context if a Design status check is implemented; it must not change branch protection or turn Design into a new required check without separate authorization. A success state must never be based on the other Task Type's session. Design approval is bound to immutable contract content, not a claim that code has been reviewed.

**Invariant D-OWN-04 — Shared Git facts are not task-owned:** Both tasks read the actual PR base/head where needed. Neither task changes Git refs. They store independent evidence of which code/contract version they checked. The first version does **not** introduce cross-task HEAD synchronization or force a Code Review rerun because a Design document changed. Existing Code Review commit-SHA rules remain unmodified.

**Invariant D-OWN-05 — Concurrency and idempotency:** Initially retain existing **per-PR serialization** across types. Design attempt identity is `design/<target-repo>/<PR>/<source-comment-ID>/<manifest-digest>/<head-sha>`. Replaying one comment uses the same attempt and cannot trigger another paid call. A fresh authorized comment is a new request only after the Design planner applies same-ref and spending rules. Half-published work cannot yield false PASS, steal another type's status, or mutate its records. Session-size/comment-pagination limits fail closed. Do not trust injected task markers in model output or user text as proof of ownership.

## 5A. Failure-atomic Design publication and recovery (D02)

**The authoritative decision is the single successful GitHub POST of a fully validated, bot-authored FINAL Design Session PR Conversation comment.** It carries a Design-only marker, unique attempt identity, exact full `design_ref` set, `policy_sha`, reviewed HEAD, hashes, bounded coverage, final verdict, reviewer identity and consolidated findings. The model output, pending state, GitHub Actions success, a PR review and optional commit status are **not** DESIGN PASS. A final verdict can be used as the current Gate only if its contract references still match the task under review.

Design writes use this ordered protocol:

1. **PREPARE:** Validate the D01 envelope and pre-read contract/policy bytes. Check for a completed or interrupted same-attempt record. Before a paid call, persist a bot-authored **DESIGN_IN_PROGRESS** staging comment containing the task-qualified attempt key, input fingerprints, conservative budget reservation, and nonfinal status. On an ambiguous POST response, read back by exact attempt key rather than posting again; if ownership/response cannot be proven, stop.
2. **EVALUATE:** Use shared, read-only provider execution and persist the structured candidate result with provider charge and full evidence inventory in a Design-only **EVALUATED / NOT FINAL** staging record. PATCH only after re-fetching the actual GitHub comment and checking bot author, expected Design marker, comment ID and matching attempt/session. No raw private policy text, credentials or sensitive sources may be exposed in a public PR.
3. **VALIDATE:** Deterministically check output schema, required all-file coverage, absence of unresolved blockers, exact full contract bytes, policy SHA, source comment permission/identity, immutable manifest and PR HEAD before finalization. A favorable model narrative never overrides incomplete or inconsistent host evidence. If anything material is missing, return DESIGN BLOCKED.
4. **FINALIZE:** Perform exactly one authoritatively scoped FINAL Design Session POST. This atomic **single-comment write** is the formal decision commit point. If the API response is lost, locate the actual FINAL by bot author, task marker, attempt key and exact input fingerprints; never blindly create a second FINAL. Conflicting/ambiguous durable finals require manual reconciliation.
5. **MIRROR/CLEAN:** Only after FINAL is confirmed, optionally post under **`claude-review-bot/design`**, never `claude-review-bot/review`. Clean only Design-owned superseded/staging status comments and only after fresh author/marker/ID/session verification. Mirror or cleanup failure is a warning/recovery task, not a new PASS; enough current evidence remains traceable without infinite obsolete comments.

**Interrupted publication:** An EVALUATED record without FINAL can be revalidated and finalized **without re-calling the provider**. If paid work might have happened but EVALUATED was not persisted, count its full reserved exposure and stop as DESIGN BLOCKED/HUMAN_REQUIRED: no automated paid replay. If FINAL exists but mirror/cleanup failed, repair only those postcommit steps with no provider call. A moved HEAD or changed manifest cannot acquire a current-ref PASS; any prior-ref verdict is explicitly stale for the new contract. Failed/ambiguous ownership checks never authorize PATCH/DELETE.

**Review isolation:** Existing Review's unconditional terminal status writer and review-thread reconciler must never run on a Design event. A small Design-specific workflow entrypoint using the **same shared provider helpers** is acceptable if it most safely preserves `review-v2.yml`; it is not a second bot or model stack. Alternatively explicit mutually-exclusive task gates must prove the same property. Design comments must not be mistaken for Review pending reviews, findings or bot-owned review threads.

## 5B. Design costs, settlement and explicit retry (D03)

Design uses existing provider adapters, timeouts, Gemini-first/Claude fallback and Claude-only selection; **it does not inherit Review's spending exception**. Preserve Review's existing USD 6 automatic per-PR ledger and up-to-USD 5 explicit manual Claude call behavior without modification.

**Proposed Design hard limits:** reserve at most **USD 2 Claude exposure per explicit Design invocation** and **USD 6 cumulative Claude exposure per PR across all Design versions, comments and retries**. Both `@gemini design` fallback and `@claude design` draw on the same independent **Design-only** PR ledger. Explicit commands never bypass that total; a new commit/attempt cannot reset it. Calls are not split into unbounded repetitions merely to obtain more budget. These figures are conservative **proposed limits, not new payment authority**; paid Design enablement requires separate operator authorization.

Gemini uses the existing deployment-approved provider/quota controls and separately reported costs when measurable, never the Review Claude ledger. If Gemini fails due to availability/quota and the policy permits fallback, Claude may be called **once** within remaining Design reservation/cap; Claude-only never calls Gemini. Budget or provider enforcement unavailable → fail closed, not unlimited retries.

Persist an attempt's maximum reservation **before** provider execution. Settle with trusted SDK/provider usage if available; otherwise charge the entire conservative reserved amount. If invocation crashes ambiguously, preserve worst-case reservation until reconciled; no replay doubles the paid call or charge. Charge ledger belongs to Design's durable PR-owned records and survives new contract refs or attempts.

Same source-comment ID is **webhook replay**, always idempotent. A **new valid comment ID** is a fresh authorization attempt, but if a valid FINAL PASS/REWORK already exists for the exact current ref, return that verdict **without calling a model again**; REWORK requires a changed contract before re-review. After transient DESIGN BLOCKED, a fresh authorized command may retry with complete revalidation **only within the remaining budget**. Interrupted paid work without trustworthy settlement instead requires human reconciliation. No automatic background retries or status-reset bypasses.

No credential change, expanded quota or actual paid Design invocation is authorized by this architecture contract. Enabling Design billing, GitHub App/private-policy access and deployment are separate explicit user/operator decisions.

## 5C. Failure and trust-transition matrix

| Situation | Required behavior | Review side effects |
| --- | --- | --- |
| Edited/deleted source command, wrong writer, mutable PR body, missing HEAD-bound manifest | no paid Design call; BLOCKED or ignore | none |
| Forged workflow_dispatch/call input, wrong `policy_sha`, repo, ref or SHA | reject before model; no PASS | none |
| Staging/reservation POST uncertain | re-fetch exact attempt; ambiguity stops before provider | none |
| Provider unavailable, budget depleted, incomplete read/model coverage | BLOCKED; no success | none |
| Provider may have run, EVALUATED not durable | conservative charge, HUMAN_REQUIRED, no auto re-call | none |
| EVALUATED stored, FINAL absent | validate and finalize without another model call | none |
| FINAL POST timed out but succeeded | read back and reuse exact FINAL | none |
| Design mirror or own-comment cleanup fails after FINAL | preserve FINAL, warn and recover only Design side effects | none |

## 6. Design reviewer protocol

Use the task's frozen `policy_sha` to fetch **that exact commit** of `Jiaze-Li/personal-skills/engineering-reviewer/skill.md` (not the newest `main`). Confirm the SHA and file bytes read successfully. A private-repository read must use an explicitly scoped, read-only credential/installation access; if missing, report DESIGN BLOCKED. Do not grant the model or target PR a GitHub write token or broaden GitHub App permissions silently. Existing external tool, security and ReviewLoop policies are still applicable where relevant.

The reviewer must:
1. Validate its exact `design_ref` and **complete authoritative original text** (including every file in a multi-file contract), plus task ID/version and the confirmed `policy_sha`.
2. Distinguish facts verified in code from proposals and unknowns. Read bounded related producers, storage, consumers, backward-compatibility/error/retry paths and dependencies as the contract demands; do not assume all repository code is reviewed.
3. Check structural invariants, authority boundaries, failure/transaction recovery, compatibility, implementation prerequisites and evidence needed to test the design. Identify actual contract contradictions or clearly label missing evidence.
4. Return **DESIGN PASS**, **DESIGN REWORK** or **DESIGN BLOCKED**, attached to the verified immutable `design_ref`, precise scope, reviewer/run identity and stated evidence limitations. Design PASS does not mean code exists, passes tests, is merged or is safe to deploy.
5. Report one consolidated, deduplicated batch of actionable findings. Every blocker identifies the violated invariant, impact, source/evidence location, required correction and acceptance/regression evidence. The reviewer does **not** rewrite the contract as its own independent approval.

Design review **must read all required designated contract content before PASS**. The host enumerates exact files, validates full UTF-8 original bytes/digests, and supplies the **complete bounded text** to the model with no silent truncation; unfit/oversize inputs are BLOCKED rather than implicitly accepted. Relevant unchanged code can be examined by sanitized read-only tools with honest coverage. No changed-line-only sharding or model summary is proof of a complete design examination. Incomplete input, uncertain fundamental facts, missing authority or unavailable reviewer means BLOCKED, not PASS.

## 7. Design lifecycle and iteration

`UNREVIEWED → IN_PROGRESS → DESIGN REWORK / DESIGN BLOCKED / DESIGN PASS` (with explicit recoverable failure/wait state as technically necessary).

- Each explicit Design invocation is scoped to the D01 trusted envelope and complete immutable contract-ref set. Same-comment webhook replays are idempotent; fresh same-ref commands follow §5B's explicit no-duplicate-spend rules.
- When an authorized GPT/Coding Agent changes contract text, it creates a new immutable `design_ref` (usually new commit and path) and **explicitly** invokes another Design review. Any earlier PASS remains historical, not approval for the new original text.
- A new Design review evaluates **the full current bounded contract**, carries forward prior findings for verification, checks changed assumptions and new regressions, and does not mark PASS based solely on a narrow repair delta.
- Ordinary, evidence-backed technical fixes may be made in the **same authorized task** by the editing agent; Design Bot never edits. Major product/scientific/architectural choices go back to the engineering lead/user; do not weaken contract requirements merely to get PASS.
- On repeated systemic failures across two repair cycles in one shared design/authority boundary, stop local patching and request read-only root-cause audit. `HUMAN_REQUIRED`, paid-work ambiguity or tool/permission barriers must not be worked around by resetting, a new comment/task ID or altered acceptance criteria.
- No automatic follow-up loop is assumed merely because the Reviewer posted feedback. End-to-end GPT/Worker orchestration requires actual authorized tool access and a continuing execution environment.

## 8. Failure modes and acceptance evidence

| ID | Requirement / failure to exclude | Minimum verification |
| --- | --- | --- |
| AC1 | Review command and workflow parity; no Review regression | Existing complete automated suite plus a live Review PR: automatic/open trigger, manual Gemini/Claude semantics, findings, verification, READY/REWORK and status context |
| AC2 | Task-owned state and cleanup; no cross-task mutation | Mixed Design/Review same-PR tests with both orderings, retries, concurrent trigger queue, invalid/mismatched comment ownership, failed PATCH/DELETE, new HEAD, duplicate delivery; inspect actual comments, status and finding IDs |
| AC3 | Reliable complete Design judgment | Fixed `policy_sha` and byte-exact `design_ref` read; full multi-file coverage; known-consistent contract → PASS, concrete contradiction → REWORK, missing/changed contract or policy → BLOCKED |
| AC4 | Real Design correction loop | A Design PR: deliberate defect → REWORK; authorized edit/new commit/new `design_ref`; new explicit command → full re-review, old finding checked and no stale PASS |
| AC5 | No false approval on failures | Bad SHA, unavailable private-skill access, malformed manifest, provider exhaustion, partial evidence, stale PR and publication failure all fail closed without affecting Review |
| AC6 | Operational workload | Authorized GPT can open/read a PR, post exact command, retrieve structured findings and re-invoke after own approved edit; no manual transcript copy needed on normal findings; major choices stop for human |
| AC7 | Reviewer has no mutation privileges | Model receives no write credential or repository mutation tools; host publisher can only write task-owned review records; no merge/contract/code/deploy action by reviewer |
| AC8 (D01) | Invocation/manifest identity | Change PR description without HEAD change; edit/delete the trigger comment; forge workflow_dispatch/workflow_call inputs; substitute writer, manifest, `policy_sha`, repo/path, SHA or HEAD. Only real authorized matching original command can run Design. Review unchanged |
| AC9 (D02) | Failure-atomic publication | Fault-inject at staging POST, provider completion, EVALUATED PATCH, before/after FINAL POST (including lost acknowledgement), Design status mirror and own-comment DELETE/PATCH; prove recovery without false PASS, repeated paid calls, foreign-comment mutations or Review status updates |
| AC10 (D03) | Bounded spend/retries | Replayed webhook vs new source comment; same-ref PASS/REWORK short circuit; transient BLOCKED explicit retry; fallback and Claude-only; USD 2 invocation / USD 6 Design PR caps, charge settlement and worst-case unknown usage independent of Review |

Evidence records must distinguish tests the implementation team ran, CI logs, model claims and real PR observations; a successful Actions job alone is not a DESIGN PASS. Live test must observe the actual deployed Worker version/configuration; Git `main` alone is insufficient proof of deployment.

## 9. Minimal implementation plan and boundaries

**Stage S1 — Read-only preflight / contract-gate:** Independent Reviewer checks this exact document ref and necessary baseline; record DESIGN PASS/REWORK/BLOCKED. No implementation until applicable DESIGN Gate is satisfied or explicitly and validly waived by the user, with no substantive unresolved blocker.

**Stage S2 — D01 routing and isolation:** Add explicit Design command, fixed HEAD manifest, independently trusted invocation envelope, task-specific routing and ownership tests. Keep Review entrypoint, session parser, triggers and final status semantics unchanged. Verify the full existing Review test suite before continuing.

**Stage S3 — D02/D03 Design execution:** Add full-byte contract/policy reader, shared provider invocation, independent Design budget/reservation ledger, EVALUATED staging, authoritative FINAL publication/recovery, Design findings and complete re-review semantics. Prevent Review's status/threads finalizers from running for Design. Extract minimal verified shared helpers. Re-run all Review tests plus cross-task, billing and fault-injection suites.

**Stage S4 — Live end-to-end:** Deploy and enable paid Design only with separate user/operator authorization; verify Worker revision actually deployed. Test live Design REWORK → corrected ref → DESIGN PASS, transient BLOCKED, replay/no-double-charge, and an untouched Review PR lifecycle. Leave branch protection and existing Review privileges/statuses unchanged.

### Operation permissions for the **current documentation PR**

Authorized by the user on 2026-11-11: make and maintain the **documentation-only** contract PR and its consolidated revision for independent design review, including contract-only commit/push. **Not authorized:** code implementation, merge, Cloudflare deployment, new Design model spending, GitHub App/private-policy permissions/secrets changes, branch protection changes, destructive production actions or changes to existing Review comments. The v0.1 draft is preserved immutably in Git history even if its working PR file is renamed to v0.2.

## 10. Open facts and next action

- **Design Gate:** v0.1 had an independent **DESIGN REWORK** on D01/D02/D03. This v0.2 proposes corrections; its own independent Gate is **PENDING**, not DESIGN PASS.
- **Design ref:** attach the immutable commit+path to the PR handoff; an independent reviewer must verify the actual bytes at that ref.
- **Private policy read:** implementation must verify feasible least-privilege GitHub access; do not assume the bot's current target-only token can read `personal-skills`.
- **Deployment parity:** existing source inspection and historical CI/PR evidence do not prove the current deployed Worker revision.
- **New spending/credential boundary:** the proposed USD 2/6 Design limits do not authorize any spending or additional private-repository access; obtain explicit authorization separately before enablement/deployment.
- **Next:** submit this new immutable **v0.2** `design_ref` to the same independent Tier 3 Reviewer policy SHA for a *complete* re-review. Only a matching DESIGN PASS (or valid explicit USER WAIVED, without substantive blockers) permits later task-spec compilation; implementation needs separate permissions.

### v0.2 consolidated response to independent findings

- **CRB-D01 / P1:** HEAD-bound manifest, identity-preserving comment and dispatch envelope, manual-dispatch provenance checks, no PR-body contract authority.
- **CRB-D02 / P1:** Design-only PREPARE → EVALUATE → VALIDATE → FINALIZE → MIRROR/CLEAN; FINAL comment as commit point, crash/replay recovery, owned comments and isolated terminal statuses.
- **CRB-D03 / P2:** independent bounded Design charges and reservations, explicit fresh-vs-replayed comment behavior, provider-fallback budgets, separate actual spending authorization.
- **Baseline parity:** no Code Review behavior is redefined and no implementation claim is made by this document.
