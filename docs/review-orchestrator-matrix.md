# PR6: Unified Review Orchestrator Architecture & Behavior-Equivalence Matrix

## 1. Goal & Scope
Consolidate duplicated orchestration logic between `scripts/run-review.mjs` (Full Review) and `scripts/run-gemini-review.mjs` (Incremental and Verification reviews) into `scripts/review-orchestrator.mjs`.

This is a behavior-preserving refactor with zero changes to existing review policies.

---

## 2. Current Architecture & Duplication Analysis

### A. Provider Selection & Fallback
- `run-review.mjs` (Full Review):
  - Reads `REVIEW_PROVIDERS` (default `gemini, claude`).
  - Iterates through providers per review unit (shard).
  - Skips Gemini if `gemini.off` or unit size exceeds `GEMINI_SHARD_MAX_BYTES` without tool gateway.
  - Skips Claude if `safeRoot` is unavailable.
- `run-gemini-review.mjs` (Incremental / Verification):
  - `claudeOnly = plan.requestedMode === 'claude'`.
  - Tries Gemini first unless `claudeOnly` or `shared.geminiOff`.
  - On Gemini failure or when `claudeOnly`: executes Claude structured fallback.

### B. Gemini Circuit Breaker
- In both runners:
  - Immediate switch-off upon `unavailable` (402, 429, 5xx) or `config` (auth, invalid model).
  - Trips switch-off after 2 consecutive failures across shards/parts.
  - Once switched off, all remaining shards/parts route directly to Claude without calling Gemini.

### C. Claude Budget Pool & Concurrency Reservation
- `run-review.mjs`:
  - Total budget: `REVIEW_MAX_BUDGET_USD` ($2 default or manual comment ceiling).
  - Shard cap: `sharded ? Math.min(available, Math.max(1, REVIEW_MAX_BUDGET_USD / 3)) : available`.
  - Polling wait loop when available budget `< MIN_SHARD_BUDGET_USD (0.3)` while other shards are in-flight.
  - Inflight reservation (`inflightUsd += cap`), settlement upon completion (`charged = run.meta?.total_cost_usd ?? cap`).
- `run-gemini-review.mjs`:
  - Ledger-backed budget from `claudeFallbackCallBudget(session, { manual, pendingUsd })`.
  - Polling wait loop when budget `< CLAUDE_AUTO_MIN_BUDGET_USD (0.5)` while other parts are in-flight.
  - Per-part cap: `PART_CLAUDE_CAP_USD = 1.0`.
  - Inflight reservation, settlement with SDK-reported cost or conservative reserve.

### D. Bounded Concurrency & Deadlines
- `run-review.mjs`:
  - `SHARD_CONCURRENCY = 3`.
  - `DEADLINE_MS = 16 * 60 * 1000`. Workers stop pulling new shards when `timeLeftMs() < 60_000`.
- `run-gemini-review.mjs`:
  - `PART_CONCURRENCY = 3`.
  - `PARTS_DEADLINE_MS = 20 * 60 * 1000`. Workers stop pulling new parts when deadline is exceeded.

### E. Failure Diagnostics & Provenance
- `run-review.mjs`: Records notes, `fellBackFrom`, `claudeFacts`, writes `failure-reason.txt` and `claude-usage.json`.
- `run-gemini-review.mjs`: Records `fallback_from`, `fallback_reason`, writes `failure-reason.txt` and `fallback-unavailable.json`.

---

## 3. Behavior-Equivalence Matrix

| Scenario / Invariant | Full Review (`run-review.mjs`) | Incremental (`run-gemini-review.mjs`) | Verification (`run-gemini-review.mjs`) | Unified Orchestrator Primitive (`scripts/review-orchestrator.mjs`) |
| :--- | :--- | :--- | :--- | :--- |
| **A. Gemini Success** | Shard reviewed by Gemini, credits assigned files, no Claude call | Diff reviewed by Gemini, returns findings, no Claude call | Diff verified by Gemini, returns verifications + repair findings | Unified provider attempt loop returns on first successful provider outcome |
| **B. Gemini 402/429/5xx** | Trips breaker, records fallback note, hands shard to Claude | Trips breaker, records fallback note, calls Claude structured fallback | Trips breaker, records fallback note, calls Claude structured fallback | `CircuitBreaker.trip(reason)` switches off Gemini; fallback provider invoked |
| **C. Claude-Only Request** | `REVIEW_PROVIDERS=claude` skips Gemini completely | `requestedMode=claude` skips Gemini completely | `requestedMode=claude` skips Gemini completely | Provider chain configuration excludes Gemini |
| **D. Two Gemini Failures** | Breaker trips after 2 failures; remaining shards route to Claude | Breaker trips after 2 failures; remaining parts route to Claude | Breaker trips after 2 failures; remaining parts route to Claude | `CircuitBreaker.recordFailure()` trips breaker when threshold reached (2) |
| **E. Claude Budget Concurrency** | Inflight reservation prevents concurrent shards from exceeding $2 cap | Inflight reservation prevents concurrent parts from exceeding ledger allowance | Inflight reservation prevents concurrent parts from exceeding ledger allowance | `BudgetManager.acquireReservation()` with asynchronous wait-polling |
| **F. Unknown Cost Reserve** | Charged at allotted cap ($1 or available) | Charged at conservative default ($0.50) or reserved budget | Charged at conservative default ($0.50) or reserved budget | `BudgetManager.settleReservation()` charges fallback cost when SDK cost missing |
| **G. Partial Coverage** | Shard/PR unreviewed paths remain unreviewed; session status stays `PARTIAL` | N/A (all files required in delta) | N/A (all open findings require verification) | Preserved in mode-specific coverage reconciliation & result reducers |
| **H. Non-duplicate Retry** | `priorReviewed` files skipped; only unreviewed files assigned | Unreviewed files in multi-part merged without duplicate review | Unreviewed files in multi-part merged without duplicate review | Preserved in mode-specific shard/part planning |
| **I. Mode Integrity** | Full review retains shard planning & coverage requirements | Incremental never escalates to Full unless risk policy requires | Verification never evaluates unrelated findings | Mode-specific callers own prompts, scope, and reducers; orchestrator only executes work units |
| **J. Verification Rulings** | N/A | N/A | Worst ruling per findingId (`STILL_OPEN > UNCERTAIN > FIXED`) | Handled by mode-specific reducer `mergeVerifications` |
| **K. Budget/Deadline Exhaustion** | Fails closed; writes failure reason and usage; no fabricated review | Fails closed; writes `fallback-unavailable.json`; no fabricated review | Fails closed; writes `fallback-unavailable.json`; no fabricated review | `DeadlineTracker` and `BudgetManager` signal failure; callers fail closed |
| **L. Failed Requests** | Never mark `ok: true` or advance session to `READY` | Never mark `ok: true` or advance session to `READY` | Never mark `ok: true` or advance session to `READY` | Failures return explicit error outcomes; downstreams never receive fabricated reviews |
| **M. Output Schemas** | Matches `publish-review.mjs` schema | Matches `normalizeReviewResult` schema | Matches `normalizeVerificationResult` schema | Mode-specific validation schemas unchanged |
| **N. Re-running Reviewed HEAD** | No duplicate review; preserves audited baseline | No duplicate review; requires changed HEAD | No duplicate review; requires changed HEAD | Mode-specific session preflight checks unchanged |

---

## 4. Architectural Boundaries

1. **`scripts/review-orchestrator.mjs`** owns only generic execution primitives:
   - `DeadlineTracker`
   - `CircuitBreaker`
   - `BudgetManager`
   - `runBoundedPool`
   - Outcome normalization helpers

2. **Runners (`run-review.mjs` and `run-gemini-review.mjs`)** own domain specifics:
   - Prompts and system prompts
   - File planning, chunking, and ignore rules
   - Mode-specific schemas and validation
   - Result reduction (`mergeShardResults`, `mergeParts`, `mergeVerifications`)
