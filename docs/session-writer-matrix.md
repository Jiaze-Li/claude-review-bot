# Review Session Writer Ownership Matrix & Concurrency Audit

## 1. Complete Session Writer Matrix

| # | Writer Entrypoint | Trigger Event | Workflow Context | GitHub Actions Concurrency Group | Operation Type | Allowed to Run Concurrently on Same PR? | Evidence Location |
|---|---|---|---|---|---|---|---|
| 1 | `scripts/publish-gemini-review.mjs` (`publishGeminiReview`) | PR push / comment `@gemini review` | `review-v2.yml` (lines 451-463) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | POST PR review + `saveSessionComment` (POST new comment if status/HEAD changed and DELETE old; or in-place PATCH) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/publish-gemini-review.mjs:165`, `.github/workflows/review-v2.yml:78,451` |
| 2 | `scripts/deep-review.mjs` (`begin`) | PR comment `@claude review` | `review-v2.yml` (lines 311-325) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (in-place PATCH setting `REVIEW_IN_PROGRESS`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/deep-review.mjs:164`, `.github/workflows/review-v2.yml:78,311` |
| 3 | `scripts/deep-review.mjs` (`finalize`) | Successful Claude deep review run | `review-v2.yml` (lines 496-507) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (POST new comment / in-place PATCH setting `READY` or `REWORK`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/deep-review.mjs:164`, `.github/workflows/review-v2.yml:78,496` |
| 4 | `scripts/deep-review.mjs` (`fail`) | Claude deep review timeout/failure or `deep_review_stale` | `review-v2.yml` (lines 509-522) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (POST new comment setting `HUMAN_REQUIRED`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/deep-review.mjs:164`, `.github/workflows/review-v2.yml:78,509` |
| 5 | `scripts/apply-override.mjs` (`applyManualOverride`) | Repository writer comment `@gemini override` | `review-v2.yml` (lines 340-352) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (POST new comment setting `READY`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/apply-override.mjs:29`, `.github/workflows/review-v2.yml:78,340` |
| 6 | `scripts/apply-dismissal.mjs` (`applyManualDismissal`) | Repository writer comment `@gemini dismiss F001 ...` | `review-v2.yml` (lines 354-368) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (in-place PATCH updating finding state to `DISMISSED`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/apply-dismissal.mjs:65`, `.github/workflows/review-v2.yml:78,354` |
| 7 | `scripts/apply-thread-resolutions.mjs` (`applyThreadResolutions`) | Review thread resolved / reopened by writer | `review-v2.yml` (lines 370-382) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (in-place PATCH updating P3 finding status) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/apply-thread-resolutions.mjs:112`, `.github/workflows/review-v2.yml:78,370` |
| 8 | `scripts/sweep-stale-deep-reviews.mjs` (`sweepStaleDeepReviews`) | Cron schedule `*/15 * * * *` or `workflow_dispatch` | `sweep-stale-deep-reviews.yml` (lines 83-91) | `independent-review-${matrix.repo}-${matrix.pr}` (`cancel-in-progress: false`, `queue: max`) | `saveSessionComment` (POST new comment setting `HUMAN_REQUIRED`) | **NO** (Shares identical concurrency group with `review-v2.yml`) | `scripts/sweep-stale-deep-reviews.mjs:59`, `.github/workflows/sweep-stale-deep-reviews.yml:54` |
| 9 | `scripts/recover-review-session.mjs` (`recoverReviewSession`) | Missing session comment recovery | `review-v2.yml` (lines 327-338) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (POST new comment reconstructed from commit check) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/recover-review-session.mjs:36`, `.github/workflows/review-v2.yml:78,327` |
| 10 | `scripts/stop-unavailable-review.mjs` (`stopUnavailableReview`) | Gemini / Claude quota exhaustion or 402/503 | `review-v2.yml` (lines 404-414, 433-444) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (POST new comment setting `HUMAN_REQUIRED`) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/stop-unavailable-review.mjs:69`, `.github/workflows/review-v2.yml:78,404` |
| 11 | `scripts/review-status.mjs` (`recordSessionMarker`) | No-op (`noop_ready`, `noop_waiting`, `deep_review_stale`) or zero-change `threads` | `review-v2.yml` (lines 556-580) | `independent-review-${target_repo}-${pr_number}` (`cancel-in-progress: false`) | `saveSessionComment` (in-place PATCH appending idempotency marker) | **NO** (Workflow concurrency + in-job step serialization) | `scripts/review-status.mjs:106`, `.github/workflows/review-v2.yml:78,556` |

---

## 2. Writer Categorization & Serialization Analysis

### Category A: Supported Internal Bot Writers
All 11 entrypoints above are internal bot writers. Every single one runs inside a GitHub Actions runner governed by the exact concurrency group:
```yaml
concurrency:
  group: independent-review-${{ target_repo }}-${{ pr_number }}
  cancel-in-progress: false
```
GitHub Actions enforces that for any given PR (`${repo}#${pr}`), only **one** workflow instance executes at any time. When a new event arrives during an ongoing run, the new run is placed in a pending queue and executes only after the current run completes.

Furthermore, within a single `review-v2.yml` run:
- Steps execute sequentially in one job.
- Mode-specific mutations (e.g. `publish-gemini`, `finalize-deep`, `override`) run in early steps.
- `Finalize workflow status` (which calls `recordSessionMarker`) runs as the final step.
- Between any early review step and `recordSessionMarker`, no concurrent internal step exists.

### Category B: Unprotected Internal Writers
**Count: 0.**
- **Cloudflare Worker** (`worker/src/index.js`): Never writes or mutates comments. It only reads reviews and comments (`GET /repos/{owner}/{repo}/pulls/{pr}/reviews` and `GET /repos/{owner}/{repo}/issues/{pr}/comments`) to perform preflight deduplication, then dispatches `review-v2.yml` via GitHub Actions `workflow_dispatch`.
- **Workflow Dedupe Step** (`.github/workflows/review-v2.yml:150-182`): Read-only (`gh api GET`). Sets `duplicate=true` or `duplicate=false` in `$GITHUB_OUTPUT`. Performs zero writes.
- **Workflow `review.yml`**: A thin wrapper that invokes `review-v2.yml` via `uses: ./.github/workflows/review-v2.yml`.
- **Workflow `test.yml`**: Runs `npm test` and syntax checks on CI. Has read-only contents permission and zero comment interaction.

### Category C: External Writers & Residual Risks
- Any manual edit made by a human user through the GitHub Web UI or API using personal credentials.
- External API calls made by unauthorized third-party apps outside the control repository's Actions workflow.
- Because the GitHub REST API (`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`) does not enforce `If-Match` / HTTP ETags or provide atomic compare-and-swap (CAS), any concurrent external write that arrives during a bot write's network window follows last-write-wins (LWW).

---

## 3. Analysis & Evidence on Findings F001 and F002

### Finding F001 Assessment
- **Claim**: "`recordSessionMarker` has no CAS... The workflow concurrency group is the only protection, and it does not cover other writers such as the webhook or dedupe path, other workflows, or manual edits."
- **Audit Verdict**:
  1. **Webhook & Dedupe Path**: The claim that the webhook or dedupe path writes to session comments is **demonstrably refuted** by code inspection (`worker/src/index.js` and `.github/workflows/review-v2.yml:150-182` are 100% read-only with respect to GitHub comments).
  2. **Other Workflows**: The claim that other workflows write unprotected is **demonstrably refuted**; the only other workflow writing session comments is `sweep-stale-deep-reviews.yml`, which shares the identical concurrency group `independent-review-${matrix.repo}-${matrix.pr}`.
  3. **Manual Edits**: The claim is **partially true** strictly for out-of-band external human edits in the Web UI. However, GitHub's API architecture does not offer CAS for Issue Comments; internal workflow serialization is the correct architectural boundary.
  4. **Test Clarification**: The test `deterministic concurrency` was added to verify the actual HTTP last-write-wins behavior of two un-serialized actors, demonstrating that even under an external un-serialized write, session JSON integrity remains valid and uncorrupted.

### Finding F002 Assessment
- **Claim**: "`recordSessionMarker` patches a stale snapshot with no post-write verification or retry... When another writer changes the session between GET and PATCH, for example a publish step that sets READY or records cost, this call silently reverts it."
- **Audit Verdict**:
  1. **Publish Step Interleaving**: The claim that a publish step can change the session between `recordSessionMarker`'s GET and PATCH is **architecturally impossible in production**:
     - `publishGeminiReview` runs at step 451.
     - `recordSessionMarker` runs at step 580.
     - They execute sequentially in the exact same runner job. Step 580 only begins after step 451 has fully finished.
     - `publishGeminiReview` from a second run cannot execute because the second run is queued by `concurrency: group: independent-review-${repo}-${pr}`.
  2. **Stale Snapshot Claim**: `recordSessionMarker` immediately executes `GET /issues/comments/${id}` and parses `currentSession = parseSessionComment(data?.body)`. It never uses pre-run snapshots (such as `session-plan.json`), and it fails closed if the comment is corrupted or unreadable.
