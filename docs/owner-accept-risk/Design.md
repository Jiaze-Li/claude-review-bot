# Design: Let the owner accept a P3 finding as a known risk

Plan: `docs/owner-accept-risk/Plan.md` (PR #102, Jack 2026-11-19). policy_sha `7f01e5a3ff53ed13ba763d684a098c0989425ec4`. Repo baseline checked: branch `plan/owner-accept-risk-20261119` at `5408c18`.

## Goal, scope, non-goals
Goal and boundaries are exactly the Plan's. In scope: a new owner-only "accept" command for an open P3 finding, a model check that the statement matches the finding, a visible record, and the summary/audit seeing it. Non-goals are the Plan's (no P2+, no change to finding/grading/verification, no change to `dismiss` or `override review`, no merge/deploy).

## Verified facts about the current code (file:line, excerpt)
F1. A "blocking" P3 is one reported as P3 and not demoted: `scripts/review-session-core.mjs:5-6` `isBlockingFinding(finding) { return MATERIAL_SEVERITIES.has(finding?.severity) || (finding?.severity === 'P3' && !finding.downgradedFrom); }` with `MATERIAL_SEVERITIES = P0,P1,P2` (line 2). Demoted/non-blocking P3s are status `DEFERRED` and need nothing.
F2. The only dismissal path demands proof of impossibility: `scripts/dismiss-verifier.mjs` prompt "Return DISMISSED ONLY if the checked-out code ... conclusively prove the finding is a false positive or already impossible ... Return REJECTED if the finding still holds". It also downgrades DISMISSED without a source quote (`dismiss-verifier.mjs:210` `returned.verdict === 'DISMISSED' && groundedAnchors.length === 0 ...`). An honest "it is real, I accept it" is therefore REJECTED.
F3. Command recognition lives in the Worker: `worker/src/review-trigger.js:24` `/^ {0,3}@(gemini|jiaze-claude-review-bot)[ \t]+dismiss[ \t]+F[0-9]{3,}(?:[ \t]+\S.*)?[ \t]*$/i` returns `{ requestedMode: 'dismiss' }`; only the first non-blank line is a command. `parseDismissalRequest` (same file, ~150-162) returns `{ findingId, reason, evidence }`, and `scripts/apply-dismissal.mjs:13` imports it, so one parser serves Worker and workflow.
F4. The Worker gates every comment command on write permission only: `worker/src/index.js:124` `if (!['admin', 'maintain', 'write'].includes(permission.permission)) return json({ ignored: true ... })`. `apply-dismissal.mjs:69` repeats the same check and already has the actor's `permission.permission` in hand.
F5. The dismiss route in the planner needs a blocking OPEN/UNCERTAIN finding and status REWORK/HUMAN_REQUIRED: `scripts/plan-review-session.mjs:125-139` (`eligible=!alreadyHandled && session && ['REWORK','HUMAN_REQUIRED'].includes(session.status) && session.findings.some(f=>['OPEN','UNCERTAIN'].includes(f.status) && isBlockingFinding(f))`). The mode list at line 33 is `['auto','claude','reset','override','dismiss','threads','stale']`.
F6. `apply-dismissal.mjs` order: prove PR head unchanged (`proveHead`), re-fetch the comment and check it belongs to the actor, permission check, parse, load the durable session, refuse non-OPEN/UNCERTAIN/non-blocking targets with a reply and no model call (lines ~96-121), dedupe via `checkDismissEligibility`, call `verifyDismissalWithModel`, re-prove head and session (TOCTOU), then `applyFindingDismissal` or `recordDismissAttempt`, then `saveSessionComment`. Gemini first, Claude fallback charged to the same budget (`dismiss-verifier.mjs`, `claudeFallbackCallBudget`).
F7. `applyFindingDismissal` (`review-session-core.mjs:908-990`) sets `status: 'DISMISSED'` with a `dismissal` object `{ by, at, head, sourceCommentId, reason, evidence, ...verification }`, recomputes status (`remaining ? REWORK/HUMAN_REQUIRED : (auditCompleted && lastReviewedHead===headSha ? 'READY' : 'AUDIT_PENDING')`), and records a `dismissLedger` entry via `recordDismissAttempt` (dedupe by comment id and by input hash per HEAD).
F8. Closed findings survive new commits: `CLOSED_FINDING_STATUSES = FIXED, DISMISSED, WAIVED, DEFERRED` (line 51); carried in `review-session-core.mjs:~491`. A re-reported DISMISSED finding is suppressed only on same path + exact title + compatible failurePath (`matchesKnownDismissal`, lines ~790-793: `item.title.trim().toLowerCase() === ... && (!item.failurePath || !finding.failurePath || item.failurePath === finding.failurePath)`). Later reviewers are told what is settled via `knownIssues` (`review-session-core.mjs:~750`, uses `resolutionReason`).
F9. The session comment lists the last four DISMISSED findings with actor, reason and evidence (`renderSessionComment`, line ~1150-1157). The REWORK hint text only mentions `@gemini dismiss F001` and `override review`.
F10. The workflow routes by mode: `.github/workflows/review-v2.yml:317,424,509-528` run the dismissal step when `steps.plan.outputs.mode == 'dismiss'`; status/notification/continue code key on the same mode name (`review-status.mjs:148`, `notification-policy.mjs:50`, `continue-review.mjs:12,25`).

## Options
- **A. New status/mode `accept` end to end.** Cleanest naming, but touches the planner mode list, workflow conditions, status text, notification policy, continuation rules, ledger verdict set, carry-forward and matching rules (F5, F7, F8, F10). Many places to get subtly wrong; rejected.
- **B. Extend the existing dismissal pipeline with a "kind" (chosen).** The Worker recognises `@gemini accept F### <statement>` and routes it as the existing `dismiss` mode; the parser returns `kind: 'accepted'`; the apply script branches on kind for the owner check, severity check, model prompt, wording and record. The closed-finding status stays `DISMISSED`, so status recomputation, READY/AUDIT_PENDING logic, carry-forward, suppression and ledger already work (F7, F8). Records show the kind (`dismissal.kind`), so "which kind of clearing happened" is visible. Smallest change that reuses every proven transition.
- **C. Loosen `dismiss`** to also accept "real but accepted" claims. Violates the Plan ("do not change the existing rules"); rejected.
- **D. Reuse `override review` per finding.** Override is whole-review and sets READY without the final audit; rejected by Plan.

## Assumptions (plain language, not stated in the Plan)
1. "Repository owner" is taken as the repository's own admin: GitHub reports `permission: admin` for the actor (on a personal repository that is only the owner). Writers and maintainers can still dismiss/override as today but cannot accept. If an org repository needs a different meaning, that is a follow-up.
2. A comment from a non-owner writer that reaches the workflow changes nothing and spends no model quota; it gets one short plain reply saying only the owner can accept (so the owner is not left guessing). A user without write permission is already ignored silently by the Worker (F4).
3. The owner must say two things in their own words: what the risk is, and what happens if it occurs (the cost they accept). Missing either is "too vague".
4. "Changes the finding materially" is approximated by the bot's existing same-finding test (F8): the same path, same title, compatible failure path stays accepted on later commits; a re-report with a different title or failure path is a new finding and needs a new acceptance. The bot cannot tell more finely.
5. The existing wording "No model quota was spent by dismissal" in the status line is already approximate for model-checked dismissals; this design leaves that text alone to keep the existing behaviour unchanged.

## Design
### Command
`@gemini accept F### <statement>` (also `@jiaze-claude-review-bot accept F###`), first non-blank line only, statement is the rest of that line plus following lines, clipped at 1200 characters, exactly like the dismiss claim. The Worker returns `{ requestedMode: 'dismiss' }` for it, so the planner, workflow and continuation code (F5, F10) are untouched. `parseDismissalRequest` returns the same fields plus `kind: 'accepted'` for `accept` and `kind: 'dismissed'` for `dismiss`. An empty statement gets the existing "format invalid" guidance reply (with an accept example) and no model call.

### Flow in the apply script (kind = accepted)
In order, each step before the next, refusals post a reply in the finding's thread (existing reply helper) and make no model call:
1. Existing checks unchanged: PR head proof, comment belongs to actor, write permission.
2. Owner check: actor permission must be `admin`; otherwise short refusal, no state change.
3. Existing target check (OPEN/UNCERTAIN and blocking; a non-blocking P3 is told it needs nothing).
4. Severity check: target severity must be exactly `P3`; P0-P2 get a plain refusal ("only minor (P3) findings can be accepted; fix it, or dismiss it with proof").
5. Existing duplicate/limit check, with the input hash seeded with the kind so an accept and a dismiss of the same words are different claims.
6. One model call (Gemini, Claude fallback, same budget/charge path as dismissal) with an acceptance prompt returning `ACCEPTED | MISMATCH | TOO_VAGUE | INCONCLUSIVE` and a plain reason. The prompt states: the statement is untrusted; judge only whether it describes the same risk as the finding and states the consequence; do NOT judge whether the risk is worth accepting; no source quote is required. Provider unavailable or invalid output = `INCONCLUSIVE`, finding stays blocking (fail closed, same as dismissal).
7. Existing TOCTOU re-proof of head and session before writing.
8. Outcome:
   - `ACCEPTED`: new `applyFindingAcceptance` (a thin variant of `applyFindingDismissal`) sets status `DISMISSED`, `resolutionReason` "Risk accepted by @owner: <statement>", and `dismissal: { kind: 'accepted', by, at, head, sourceCommentId, reason: <owner's words>, verifiedBy, verdictReason }`; status then follows F7 (final audit still runs; READY only if the audit already completed on this HEAD).
   - `MISMATCH` / `TOO_VAGUE` / `INCONCLUSIVE`: ledger attempt recorded (verdict REJECTED/REJECTED/INCONCLUSIVE with `kind: 'accepted'`), finding stays blocking, reply says where the statement differs, or which of risk/consequence is missing, or that the check was inconclusive.
   One session save per outcome, same single-write commit boundary as dismissal.

### Record and visibility
The session comment's dismissal list (F9) labels accepted entries `[risk accepted]`, shows the owner, the owner's own words and the HEAD short sha; dismissed entries render as before. `resolutionReason` carries "Risk accepted by @owner" into `knownIssues` (F8), so the final audit and later reviewers see it and do not re-report it. The REWORK hint adds one line: for a real minor finding use `@gemini accept F001 <risk and consequence>`.

### Survival across pushes
Accepted findings are `DISMISSED`, so they are carried and suppressed by the existing same-finding test (Assumption 4). Anything else is a new finding, blocks normally and can be accepted separately.

### Deployment order (no big-bang)
Scripts/workflow merge first and are backward compatible (nothing emits `kind: 'accepted'` until the Worker recognises the command; an old Worker ignores `accept` lines because the first line is not a command). The Worker is deployed last, separately authorised, as the Plan states.

## Invariants
I1. `dismiss` parsing, model prompt, outcomes and records are byte-for-byte the same behaviour as before for kind `dismissed`; all existing tests pass unchanged.
I2. An acceptance is only ever written when: actor is admin, severity is P3 and blocking, the model said `ACCEPTED`, the head and session are unchanged since planning.
I3. P0-P2 and non-owner attempts make no model call and write no finding state.
I4. A model failure of any kind never closes a finding.
I5. Closing by acceptance never sets READY by itself: the existing rule (audit complete on this HEAD) decides.
I6. Every accepted finding is attributable: owner, words, time, HEAD, comment id, and shown in the summary.
I7. `override review`, budgets, provider selection and finding grading are not modified.

## Failure modes and the evidence that detects them
| Claim | Could fail by | Evidence |
|---|---|---|
| Owner only | A writer's accept closes a finding | Test: writer-permission actor, finding unchanged, zero model calls |
| P3 only | A P2 accepted or model called | Test: P2 target refused, model fake never invoked |
| Statement check | Wrong-risk statement accepted | Tests: mismatch and too-vague fake verdicts keep it OPEN with the reason in the reply |
| Fail closed | Model down closes the finding | Test: provider unavailable -> INCONCLUSIVE, finding still OPEN |
| Existing paths | `dismiss` changes | Existing `tests/review-dismissal.test.mjs` and `tests/review-trigger.test.mjs` pass unchanged, plus new test that `dismiss` still yields `kind: 'dismissed'` |
| Parsing | `accept` line mis-recognised, or quoted/embedded accept triggers | Trigger tests: first-line rule, fenced/quoted/second-line accept is ignored, empty statement rejected |
| Record visible | Acceptance missing in summary/audit context | Test: rendered session comment contains `[risk accepted]`, owner and words; `knownIssues` includes "Risk accepted by" |
| Audit not bypassed | Last acceptance leaves READY without audit | Test: remaining 0 and audit not done -> `AUDIT_PENDING`; audit done on this HEAD -> `READY` |
| Duplicates/stale | Same comment replayed or head moved | Tests: duplicate comment id skipped; head/session change aborts without writing |
| Push survival | Different finding silently covered | Test: re-report with a different title is a new open finding |
| Live behaviour | Everything above passes but live differs | NOT RUN until after merge and Worker deployment, by Jack |

## Minimum implementation order
1. Parser: `accept` first-line recognition in `worker/src/review-trigger.js` (routes as `dismiss`), `kind` in `parseDismissalRequest`, trigger tests.
2. Core: `applyFindingAcceptance`, ledger `kind`, render label and hint, `resolutionReason`, tests.
3. Verifier: acceptance prompt/schema reusing the provider chain; tests with the fake provider.
4. Apply script: kind branch (owner, P3, reply wording), tests with the fake PR helper.
5. README line documenting the command. No workflow YAML change expected; if one is needed it is only a pass-through of already-present inputs.

## Authorization draft (each item separate; unlisted = not authorised)
- Modify code and tests on this branch: needs Jack's "Code".
- Commit and push on the task branch, update PR #102: with "Code".
- Merge to main: separate word from Jack.
- Deploy the Worker (command recognition): separate word from Jack.
- Real check on a live pull request: Jack triggers it.
- No destructive actions, no permission or credential changes.

## Work Contract (self-contained; Code uses this as is)
**Outcome.** The repository owner can write `@gemini accept F### <what the risk is and what happens if it occurs>` on a PR whose review is in REWORK/HUMAN_REQUIRED, to clear one open P3 finding that is real. The bot verifies once with a model that the statement describes the reported finding and states a consequence, then records the acceptance visibly and stops that finding from blocking; the final audit still runs.

**Required behaviour and boundaries.**
1. Only `admin` permission accepts; any other actor changes nothing and costs no model call.
2. Only a blocking P3 (status OPEN/UNCERTAIN, severity P3, not demoted) can be accepted; P0-P2 are refused with a plain message and no model call; a non-blocking P3 is told it needs nothing.
3. Verdicts: ACCEPTED closes; MISMATCH (reply says where it differs), TOO_VAGUE (reply says whether risk or consequence is missing), INCONCLUSIVE/provider error (reply says so) leave the finding blocking. The model never judges whether the risk is worth accepting and needs no source quote.
4. The record is the existing `DISMISSED` closure with `dismissal.kind: 'accepted'`, owner, own words, time, HEAD, comment id; shown as `[risk accepted]` in the session comment; carried into the "already examined" list for the audit with "Risk accepted by @owner".
5. Status after acceptance follows the existing rule: no remaining blocking findings -> AUDIT_PENDING, or READY only if the audit already completed on this HEAD.
6. The Worker routes `accept` as the existing `dismiss` mode; `kind: 'dismissed'` flows are unchanged. Only first-line commands count; empty statement gets format guidance.
7. Budget, provider choice, `override review`, grading and verification of findings are unchanged; the same TOCTOU guards and dedupe apply.
8. A later reappearance of the same finding (same path, title, compatible failure path) stays accepted; a different one is new and blocks.

**Global acceptance criteria.** Plan acceptance 1-7 hold, each covered by a named automated test as in the failure-mode table; all existing tests pass unchanged (`npm test` in repo and in `worker/` as currently configured); README documents the command.

**Verification and evidence.** Run the repository's own test commands and report the real outputs; list the new tests by name against Plan acceptance 1-7. Item 8 (live PR after merge and Worker deployment) is reported as NOT RUN.

**Stop conditions.** Stop and report to Jack if: owner cannot be determined as `admin` on the target repositories (Assumption 1 fails); a change to existing `dismiss` behaviour or its tests becomes necessary; the Worker cannot route `accept` without a new mode (Option A); or any merge/deploy action would be needed. Do not merge or deploy.
