# CRB-DESIGN-01 — Design Task Architecture Contract v0.1

**Status:** DRAFT / independent DESIGN Gate **PENDING** (not approved for implementation)  
**Target repository:** `Jiaze-Li/claude-review-bot`  
**Engineering policy snapshot (`policy_sha`):** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa`  
**Reviewed-code reference baseline (read-only):** `179569d7b434012c9024b43a19e20e2028a3a4e4` (`main` at initial design)  
**Risk / architecture basis / gate:** Tier 3 / REQUIRED / PENDING — touches the review service's shared session/publication/security boundary.  
**Immutable `design_ref`:** assigned externally as `git:Jiaze-Li/claude-review-bot@<actual-contract-commit>:docs/design-task-architecture-contract-v0.1.md` after this exact document is committed. Do not substitute a moving branch name or the PR number. The ref must be checked by the independent Reviewer against the bytes in that commit.  
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

For Design, the invoking PR must provide a validated manifest (PR description or a fixed-version contract file in the PR) identifying: task/contract ID and version, `policy_sha`, exact contract path(s), the intended immutable `design_ref` or a deterministic way to derive it from the pinned PR HEAD, applicable upstream decisions, and the bounded repository/context baseline. **The human/agent need only post `@gemini design` or `@claude design` once the manifest is complete.** Any missing material input produces DESIGN BLOCKED, not a guessed context or fabricated PASS. Manifest text and repository contents remain untrusted inputs for agent-tool security; they are never allowed to override host permissions or trusted reviewer instructions.

Do not require a new explicit `design_ref` string embedded within the contract whose Git commit defines it (self-reference). The invocation/PR metadata can carry `git:<repo>@<sha>:<path>`, and the reviewer must resolve that to exact file bytes. Multi-file contracts must identify every authoritative file at immutable references, rather than pretending a single document hash covers others.

## 4. Shared trunk and bounded extraction

The shared trunk owns **GitHub event/auth validation, bounded source acquisition, provider adapters/model requests, provider fallback/circuit-breaker, resource limits/charging, basic publication and audit/error helpers**. Task-specific branches own their review input rules, prompt/schema, findings interpretation, validity/gate decision, session state transitions and task-specific presentation.

Implementation may extract a **small, behavior-preserving shared helper** when both task types genuinely use it (e.g., publisher with owner-specific marker, comment safety checks, provider executor). Do not migrate the entire existing `review-session-core.mjs` into a generic framework or rewrite `review-v2.yml` merely for symmetry. Avoid introducing a parallel model stack, duplicated token holder, or second task controller. Follow existing error/privilege limits.

## 5. Session, findings, comment and commit-status ownership

**Invariant D-OWN-01 — Independent state:** `review` and `design` must have different, unambiguous, host-verified session namespaces, parsers and writer selection. For example, preserve `<!-- jiaze-review-session:v1 -->` for Review and use `<!-- jiaze-design-session:v1 -->` for Design. Each owns its state, finding IDs, attempt/verification history, provider charges, and comment IDs. A Review writer must not load/modify Design state, nor vice versa. Discovery and recovery may rely only on comments whose authenticated author and exact task marker both match.

**Invariant D-OWN-02 — Own-comment lifecycle:** Both types may post a current status, edit their own current session or remove their **own superseded status comments**, following the existing Review cleanliness philosophy. Do not impose append-only accumulation. Before PATCH/DELETE, re-fetch and verify **GitHub comment ID, actual bot author, expected task marker and expected session identity**; an unknown/ambiguous record fails closed. No task may edit/delete another type's comments or findings, or user-authored discussion. Preserve essential evidence (reviewed immutable ref, findings and decisions) in retained current results/immutable source references even when stale status messages are cleaned up. “Own comment” cannot be established by a body marker alone.

**Invariant D-OWN-03 — Separate commit status:** Preserve existing `claude-review-bot/review` context exactly. Design may publish its result only under a distinct `claude-review-bot/design` context if a Design status check is implemented; it must not change branch protection or turn Design into a new required check without separate authorization. A success state must never be based on the other Task Type's session. Design approval is bound to immutable contract content, not a claim that code has been reviewed.

**Invariant D-OWN-04 — Shared Git facts are not task-owned:** Both tasks read the actual PR base/head where needed. Neither task changes Git refs. They store independent evidence of which code/contract version they checked. The first version does **not** introduce cross-task HEAD synchronization or force a Code Review rerun because a Design document changed. Existing Code Review commit-SHA rules remain unmodified.

**Invariant D-OWN-05 — Concurrency and idempotency:** Initially retain the existing **per-PR serialization**, even across types; on a duplicate or replayed comment, use task-qualified event identity so one type's trigger cannot suppress the other. A failed or half-published run cannot convert either type to a false success, steal its status, or delete the other's data. Session size/comment pagination and partial-write recovery must fail safely.

## 6. Design reviewer protocol

Use the task's frozen `policy_sha` to fetch **that exact commit** of `Jiaze-Li/personal-skills/engineering-reviewer/skill.md` (not the newest `main`). Confirm the SHA and file bytes read successfully. A private-repository read must use an explicitly scoped, read-only credential/installation access; if missing, report DESIGN BLOCKED. Do not grant the model or target PR a GitHub write token or broaden GitHub App permissions silently. Existing external tool, security and ReviewLoop policies are still applicable where relevant.

The reviewer must:
1. Validate its exact `design_ref` and **complete authoritative original text** (including every file in a multi-file contract), plus task ID/version and the confirmed `policy_sha`.
2. Distinguish facts verified in code from proposals and unknowns. Read bounded related producers, storage, consumers, backward-compatibility/error/retry paths and dependencies as the contract demands; do not assume all repository code is reviewed.
3. Check structural invariants, authority boundaries, failure/transaction recovery, compatibility, implementation prerequisites and evidence needed to test the design. Identify actual contract contradictions or clearly label missing evidence.
4. Return **DESIGN PASS**, **DESIGN REWORK** or **DESIGN BLOCKED**, attached to the verified immutable `design_ref`, precise scope, reviewer/run identity and stated evidence limitations. Design PASS does not mean code exists, passes tests, is merged or is safe to deploy.
5. Report one consolidated, deduplicated batch of actionable findings. Every blocker identifies the violated invariant, impact, source/evidence location, required correction and acceptance/regression evidence. The reviewer does **not** rewrite the contract as its own independent approval.

Design review **must read all required designated contract content before PASS**. It must not reuse Code Review's sharded changed-file coverage as proof of a complete contract-level examination. Incomplete input, uncertain fundamental facts, missing authority or unavailable reviewer means BLOCKED, not PASS.

## 7. Design lifecycle and iteration

`UNREVIEWED → IN_PROGRESS → DESIGN REWORK / DESIGN BLOCKED / DESIGN PASS` (with explicit recoverable failure/wait state as technically necessary).

- Each explicit Design invocation is scoped to the current validated `design_ref` and target PR snapshot. Same-content duplicate events are idempotent and do not silently create more billed runs.
- When an authorized GPT/Coding Agent changes contract text, it creates a new immutable `design_ref` (usually new commit and path) and **explicitly** invokes another Design review. Any earlier PASS remains historical, not approval for the new original text.
- A new Design review evaluates **the full current bounded contract**, carries forward prior findings for verification, checks changed assumptions and new regressions, and does not mark PASS based solely on a narrow repair delta.
- Ordinary, evidence-backed technical fixes may be made in the **same authorized task** by the editing agent; Design Bot never edits. Major product/scientific/architectural choices go back to the engineering lead/user; do not weaken contract requirements merely to get PASS.
- On repeated systemic failures across two repair cycles in one shared design/authority boundary, stop local patching and request read-only root-cause audit. `HUMAN_REQUIRED` or tool/permission barriers must not be worked around by reset, new task ID or altered acceptance criteria.
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

Evidence records must distinguish tests the implementation team ran, CI logs, model claims and real PR observations; a successful Actions job alone is not a DESIGN PASS. Live test must observe the actual deployed Worker version/configuration; Git `main` alone is insufficient proof of deployment.

## 9. Minimal implementation plan and boundaries

**Stage S1 — Read-only preflight / contract-gate:** Independent Reviewer checks this exact document ref and necessary baseline; record DESIGN PASS/REWORK/BLOCKED. No implementation until applicable DESIGN Gate is satisfied or explicitly and validly waived by the user, with no substantive unresolved blocker.

**Stage S2 — Safe routing and isolation:** Add explicit Design command, task-qualified session writer/reader and ownership tests while keeping Review's behavior intact. Verify existing Review test suite at this exit point.

**Stage S3 — Design evaluation:** Add immutable contract/policy reader, scoped provider invocation, Design-specific structured result, findings and comment publication, complete re-review semantics; minimal shared-helper extraction only as justified. Re-run full Review tests and cross-task isolation tests.

**Stage S4 — Live end-to-end:** Deploy only with separate authorization; verify new Worker code is actually deployed, perform Design REWORK → corrected ref → DESIGN PASS live test and untouched Review regression test. Leave branch protection and production privileges unchanged unless expressly authorized.

### Operation permissions for the **current documentation PR**

Authorized by the user on 2026-11-11: make this **documentation-only** change on a new branch, commit/push it, and open a PR for review. **Not authorized:** code implementation, merge, deploying Cloudflare Worker, GitHub App/secret/permission changes, branch protection changes, destructive operations, or modifying existing Review discussions.

## 10. Open facts and next action

- **Design Gate:** PENDING; this document is a proposal, not a self-issued approval.
- **Design ref:** attach the immutable commit+path to the PR handoff; an independent reviewer must verify the actual bytes at that ref.
- **Private policy read:** implementation must verify feasible least-privilege GitHub access; do not assume the bot's current target-only token can read `personal-skills`.
- **Deployment parity:** existing source inspection and historical CI/PR evidence do not prove the current deployed Worker revision.
- **Next:** submit this exact contract for an independent Tier 3 DESIGN review, consolidate any REWORK findings, and only after a valid gate produce an implementation Task Spec with separately explicit permissions.
