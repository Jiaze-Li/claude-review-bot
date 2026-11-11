# CRB-DESIGN-01-S2 — Task Spec: Design routing, validation and session (no model call)

**Task / spec:** `CRB-DESIGN-01-S2`, spec v1
**policy_sha:** `ae4c3f538f9e8998fe534aaa01ff12daae1725aa` (`Jiaze-Li/personal-skills`)
**Design gate:** Tier 3 / REQUIRED / **DESIGN PASS**
**design_ref:** `git:Jiaze-Li/claude-review-bot@62a15fab1c23c6b3f49bf2cda90bc529c2550300:docs/design-task-architecture-contract-v0.6.md`, git blob `40b9823aa2d00282cf78d43b69fb45a55560dc0c`. Independent review verdict DESIGN PASS on 2026-11-11, bound to that blob; recorded in the description of PR #70.
**Brief:** `docs/tasks/CRB-DESIGN-01-S2/brief.md`. It holds the user's decisions. **Do not edit it.** If you believe it is wrong, stop and report.
**Code baseline:** `b2ab0631ac0ef4192c2b6956ea100a8e3ca17047` (`main`).

## 1. Goal

Implement stage S2 of the approved design: the bot recognizes the Design commands, routes them to a separate workflow, validates the manifest and input, maintains the Design session comment, and ships the decision function. **No model is called and nothing is spent in this task.** After it, every Design command ends in a correct non-evaluating status.

## 2. Read first

The design contract is the authority for behavior. This spec selects the S2 subset and adds task constraints.

```bash
git fetch origin 62a15fab1c23c6b3f49bf2cda90bc529c2550300
git rev-parse 62a15fab1c23c6b3f49bf2cda90bc529c2550300:docs/design-task-architecture-contract-v0.6.md
# must print 40b9823aa2d00282cf78d43b69fb45a55560dc0c
git show 62a15fab1c23c6b3f49bf2cda90bc529c2550300:docs/design-task-architecture-contract-v0.6.md
```

If the blob differs, stop. Section numbers below (§) refer to that contract. If this spec and the contract disagree, or the contract is silent on something that changes observable behavior, stop and report; do not choose.

## 3. Preflight, non-destructive

1. Record the working tree state and your actual base commit.
2. Run the suite. Verified on 2026-11-11 at the baseline: `npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund` then `npm test` gives 592 tests, 592 passing. If your base gives a different result, report it before editing.
3. Re-check contract §3 rows 1 to 9 against your base. If any no longer holds, stop.

## 4. In scope

| # | Deliver | Contract |
| --- | --- | --- |
| 1 | Recognition of `@gemini design`, `@claude design`, `@jiaze-claude-review-bot reset design` as the first non-blank line, with the same strictness as existing commands | §4 |
| 2 | Worker routing of those commands to `design.yml`. Writer check applies. Draft PRs are accepted. Review commands are dispatched exactly as before | §4 |
| 3 | `.github/workflows/design.yml`: `workflow_dispatch` only; one concurrency group shared by all Design runs, `cancel-in-progress: false`, `queue: max`; 20-minute job timeout; target-repository token with contents-read and pull-requests-write only | §4 |
| 4 | Manifest discovery and validation, file checks, size limits, policy read, bundle identity | §5 |
| 5 | Design session: body construction, discovery and mutation rules ISO-1 to ISO-3; all state fields, statuses and reason codes | §6.1, §6.2 |
| 6 | The decision function as `scripts/design-status.mjs`, usable as a CLI with a read-only token and importable for tests, including the abandoned-run rule | §6.3 |
| 7 | Brief tripwire and `reset design` | §7, §4 |
| 8 | Run protocol steps 1 to 4 and 6, with step 5 behind a replaceable evaluator function | §8 |
| 9 | Log rule: no file contents, policy text or evaluator output in logs or the job summary | §8 |

Clarifications for S2:

- **Evaluator.** The evaluator shipped in this task makes no model call and reports the provider as unavailable. A run that passes validation therefore publishes `DESIGN_BLOCKED / PROVIDER_UNAVAILABLE`. Tests exercise pass, rework and round logic through an injected evaluator and through constructed session fixtures.
- **Settle first.** §8 step 2 is implemented now, although this task never sets `inFlight` itself: a session that carries `inFlight` has it added to `spend` and cleared before anything else, in every run including `reset`.
- **Admission.** §8 step 4 writes `DESIGN_IN_PROGRESS` with `runStartedAt` and the brief anchor. It never admits Claude in this task.
- **Rounds.** The `round` check in §8 step 3 and `ROUNDS_EXHAUSTED` are implemented.
- **Queue limit.** GitHub keeps at most 100 pending runs in a concurrency group. State this in a comment in `design.yml` and in the README. A run cancelled while pending writes nothing (v0.6 review, CRB-v06-F01, P3).
- **Decision citations.** `CRB-DEC-03` and `CRB-DEC-04` are each cited in a code comment at the relevant branch, in a test whose name contains the ID, and in one README sentence. The README states that Design does not evaluate yet.

## 5. Out of scope

- S3: provider calls, findings produced by a model, the spend locks of §9 including the daily count, `CRB-DEC-01` and `CRB-DEC-02` paths beyond settle-first.
- S4: deployment and live runs.
- Do not add a Design commit status, review threads or PR review objects.
- Do not reintroduce what `CRB-DEC-04` removed: signed dispatch, policy authority checks, confidentiality checks, a reset allowlist.

## 6. Invariants

- **I1, Review unchanged.** No existing file under `scripts/` is modified. `review-v2.yml`, `review.yml` and `sweep-stale-deep-reviews.yml` are unmodified. No existing test file is modified. Existing files you may modify: `worker/src/index.js`, `worker/src/review-trigger.js`, `.github/workflows/test.yml`, `README.md`. New files are unrestricted. No new dependency is expected; needing one is a stop condition.
- **I2, isolation.** Design code reads, writes and deletes only comments that satisfy ISO-2, and re-validates before every mutation (ISO-3). It calls no Review session writer, thread reconciler, PR-review publisher or status writer.
- **I3, no model, no spend.** No code path in this task invokes a provider. Tests use no network.
- **I4, fail closed.** A missing, unreadable or mismatched input never yields `DESIGN_PASS`, and the decision function never returns `continue` for it.
- **I5, untrusted strings.** Every string from the manifest, a path, file content, an evaluator or an error is HTML-escaped before it enters a comment body, and the ISO-1 assertions run on the final body.

Internal structure, file names other than the two named above, and helper design are yours, following the repository's existing conventions.

## 7. Acceptance criteria

Contract AC1 to AC5 apply as written. For this task:

| ID | Claim | How it could fail | Evidence required |
| --- | --- | --- | --- |
| AC1 | Review is unchanged | A shared file edit alters Review routing or planning | Full suite passes with no existing test modified; the byte-identity check in §8 prints nothing; existing command inputs give identical parse results |
| AC2 | Isolation | Review's substring match selects a Design comment; Design mutates a comment it does not own | Tests feeding Review's own session selection (`scripts/plan-review-session.mjs`, `scripts/sync-commit-status.mjs`) a comment list with and without Design comments, in both orders, including evaluator output and file content carrying Review markers, Design markers, HTML comments and encoded state: same selection both ways. Wrong ID, changed `revision`, failed PATCH and failed DELETE leave foreign comments untouched |
| AC3 | Validation | A bad input reaches the evaluator | Base moved, head moved, zero manifests, several manifests, malformed schema, unknown key, unknown role, missing file, symlink, submodule, oversize file, oversize set, unreadable policy, repeated source comment: each gives the contract's status and reason, with the evaluator not invoked |
| AC4 | Brief tripwire and reset | The brief changes unnoticed; reset loses spend | Changed, added and removed brief each give `HUMAN_REQUIRED / BRIEF_CHANGED` with the evaluator not invoked. `reset design` re-anchors, zeroes `round`, keeps `spend` and `processedSourceComments` (`CRB-DEC-03`) |
| AC5 | Freshness and abandonment | `continue` for content that was not evaluated; a dead run waits forever | Every row of the §6.3 table. Listed file changed after a pass gives `request_review`. Code-only commit after a pass gives `continue` with the new head. A head change between the two reads is detected. Missing or unreadable session gives `stop`. In progress gives `wait` before 30 minutes and `request_review` from 30 minutes |
| AC6 | Settle first | A reset or early exit drops an outstanding charge | Session with `spend` 4 and `inFlight` 2: after `reset`, and after a run that ends blocked, `spend` is 6 and `inFlight` is null |
| AC7 | No model call | An S2 path reaches a provider | A spy on the provider entry points shows zero invocations across the whole Design test suite |
| AC8 | Routing | A Design command reaches `review-v2.yml`, or a Review command reaches `design.yml` | Worker tests for each command, for a non-writer, for a draft PR, and for quoted, fenced or mid-prose mentions |

## 8. Verification

```bash
npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm test
# I1: must print nothing
git diff --diff-filter=MDR --name-only "$(git merge-base origin/main HEAD)" HEAD -- \
  scripts .github/workflows/review-v2.yml .github/workflows/review.yml \
  .github/workflows/sweep-stale-deep-reviews.yml tests
```

Add `node --check` for each new script to `test.yml`, as the existing scripts have.

Not verifiable in this task, and to be reported as unverified: behavior of the deployed Cloudflare Worker; real GitHub concurrency-queue behavior; a live Design command.

## 9. Authorization, from the brief

| Action | Authorized |
| --- | --- |
| Modify code within §4 and I1 | Yes |
| Commit and push to the task branch | Yes |
| Open a draft PR, and mark it ready when local work is complete | Yes |
| Follow the bot's code review to `READY`, including repair pushes | Yes |
| Merge | **No** |
| Deploy the Cloudflare Worker | **No** |
| Create or change secrets, App permissions or branch protection | **No** |
| Any paid Design run | **No** |
| Destructive operations on existing data or comments | **No** |

Anything not listed is not authorized.

## 10. Execution and review

1. Follow the installed ReviewLoop Worker Policy. Call `reviewloop_begin` with the full text of this file as `contractText`, and the commands in §8 as verification commands. One gate.
2. After the local `PASS`: commit, push, open the draft PR if none exists, then mark it ready. Marking ready starts the bot's code review.
3. Follow the bot's Independent Review Session as the Worker Policy describes. **A push alone does not start a re-review** (`worker/src/review-trigger.js:40-42`). After a repair push, comment `@gemini review` once to request it.
4. `HUMAN_REQUIRED` from ReviewLoop or from the bot: stop and report. Do not reset or override.

**Stop and report** if: the contract blob does not match; the spec and contract conflict; I1 cannot be kept; a new dependency, secret or permission is needed; the baseline suite fails; the brief seems wrong.

## 11. Completion report

Write it for the user in Chinese, in plain words:

1. Each of the six items under "怎样算做完" in the brief, with the evidence for it or "未验证" and why.
2. Base and head commits, PR link, ReviewLoop result, the bot's session status and the head it reviewed.
3. What remains unverified (§8).
4. End with the three-line status card:

```
现在在哪：<任务名> 的第 N 步「<阶段名>」，<一句话结果>
下一步：<谁> 去做 <什么>
要你做的：<一件具体的事>，或者"没有，等结果即可"
```
