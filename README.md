# claude-review-bot

Account-wide bounded PR review service for GitHub.

## Daily use

Normal PR review is automatic once the GitHub App is subscribed to **Pull request**
events and the current Worker is deployed:

- opening a non-draft PR starts a bounded discovery session automatically;
- moving a draft PR to **Ready for review** starts it automatically;
- commenting `@gemini review` after pushing a repair while the session is **REWORK** runs targeted verification;
- commenting `@gemini review` after pushing a new commit on a **READY** session first classifies the exact delta from the last reviewed HEAD: small low-risk changes get an incremental review, while broad/high-risk changes get full discovery + audit;
- webhook redelivery is idempotent, and an unchanged PR HEAD is a no-op at the durable session planner, so it does not spend another reviewer call.

The manual commands remain available as a retry/escape hatch:

```text
@gemini review
@claude review
```

The review session is intentionally stateful and simple:

- First review of a PR/session: **latest Gemini Flash (`gemini-flash-latest` alias), medium thinking, one discovery pass**.
- Any P0/P1/P2 discovery candidate gets one **targeted Gemini Flash / medium validation pass** over the candidate file, related symbols/guards, and matching tests.
- **CONFIRMED** P0–P2 findings enter REWORK. **REJECTED** candidates are resolved only when source/evidence checks refute the claim. **UNCERTAIN** P0–P2 candidates stay in the durable ledger with their own F-number and **block READY**: targeted validation has already run but could not establish a verdict. With no other confirmed blockers, status becomes **HUMAN_REQUIRED**. They are never added to the already-examined suppression ledger.
- If confirmed material findings exist, push a repair; the new PR commit automatically triggers the next review step. For **UNCERTAIN** candidates, inspect their cited code and supply evidence via `@gemini dismiss F001` if disproven, or push a fix/new HEAD for a fresh full review. Unresolved candidates carry across HEADs unless the new targeted validator explicitly CONFIRMS or REJECTS that same concern; **silence does not clear it**. Neither "validator omitted a candidate" nor "source evidence insufficient" counts as a pass.
- A REWORK repair becomes targeted **verification** plus checks for independent regressions introduced by that HEAD delta, not another full PR discovery.
- At most **2 verification rounds** are allowed.
- Once material findings converge, one independent final audit runs automatically on the final cumulative PR diff. It stays **Gemini Flash / low** for ordinary PRs; a deterministic state-integrity classifier escalates only shared-state/concurrency-sensitive PRs to **medium** with an explicit interleaving audit.
- Final-audit P0/P1/P2 candidates use the same targeted medium validator.
- The final broad audit runs **at most once per full-review session**. Safe incremental updates reuse that audit for unchanged code; after 15 successful incremental reviews a fresh full audit is required.
- P3 findings are non-blocking.
- A malformed/no-text structured Gemini review response is retried **once with the identical prompt, model, thinking level, and schema**; usage from both attempts is reported.
- Re-running on the same unchanged HEAD spends **no reviewer model quota**.
- If material findings remain after the verification budget, or a material candidate remains **UNCERTAIN** after its targeted validator check, the session stops at **HUMAN_REQUIRED** instead of claiming success. An unresolved candidate cannot be cleared by an unrelated clean final audit or a free-form Claude answer.
- If Gemini is unavailable (HTTP 402/429/5xx), Claude automatically takes over. **All automatic Claude calls**, including material-finding validation and final audit, share a **$6 cumulative cap per PR**; there is no separate $3 fallback pool. Each automatic call receives at most the remaining cap through SDK `maxBudgetUsd`, and does not start below a **$0.50** allowance.
- An authorized writer's explicit `@gemini review`, `@jiaze-claude-review-bot reset review` or `@claude review` **may exceed the internal $6 automatic cap**. Each manual Claude call remains limited by its SDK `maxBudgetUsd`; actual provider credits/quota still apply. Automatic pull-request events can never opt out.
- If Gemini is unavailable **and** fallback cannot run (budget, credential, or SDK failure), the bot records a durable **HUMAN_REQUIRED / reviewer unavailable** state for the exact HEAD. Comment `@gemini review` to retry even if HEAD advanced: unfinished verification keeps its prior repair baseline; other moved-head retries start a fresh discovery. The successful model review must still complete the required final audit and resolve all material findings before **READY**. A manual `@claude review` retries it exactly as `@gemini review` does, using Claude only.
- Costs remain cumulative across retries, pushes and manual reviews. The ledger distinguishes SDK-reported costs, conservative reservations when usage is unknown, and old unclassified amounts; reservations are not presented as confirmed charges. Normal model/publication failures still fail closed.
- Session state is stored in a bot-authored GitHub PR comment, so it survives new ChatGPT conversations, different agents, and local restarts.


### Meaning of READY

**READY is an independent code-review clearance, not merely "no confirmed bugs yet".**
For the reviewed HEAD, every P0/P1/P2 candidate must be resolved (confirmed and fixed,
evidence-backed rejected, or explicitly human-adjudicated), the required audit must
have passed, and no unresolved material uncertainty may remain. An explicit
`override review` is marked **manually overridden** so it cannot be mistaken
for machine clearance.

**GitHub remains the final merge gate.** READY alone does not prove that
independent CI, branch protection, required approvals, or conflict checks have
passed. The PR is mergeable only when its review is READY *and* GitHub's
other required checks succeed. This avoids a circular dependency on the
review bot's own required status check.

### HEAD changes after READY

A successful full audit establishes a trusted code-tree baseline. On the next HEAD,
the reviewer computes the exact diff between the previous **reviewed** HEAD and
the new HEAD (not the cumulative 100-commit PR diff). A delta of at most 50
added/deleted lines across at most 3 files is eligible for a single incremental
Gemini review, with surrounding function context. Changes to high-risk paths
(workflows, security, schemas, dependencies, migration/persistence, etc.), risk
signals in changed lines, renames/deletions/binary files, large patches, unknown
old revisions, and uncertain diff metadata cause **full Discovery + Final Audit**.

Incremental review still validates any material findings, publishes on the exact
HEAD, and never inherits the previous commit's green status without a successful
model result. Findings, verification state, and the Claude spending ledger survive
eligible changes. If new bugs are found, their fixes enter the existing bounded
Verification path without repeating Final Audit. The 15th completed incremental
review is followed by a full refresh on the next update. An explicit manual
override does **not** establish a reusable audited baseline.

A forced push or rebase is compared by final code trees, not by commit ancestry.
If the old reviewed commit can no longer be fetched, the bot fails back to
full review. A provider outage on an incremental HEAD remains HUMAN_REQUIRED;
a manual retry resumes the same delta rather than silently clearing the gate.

### Gemini request timeout policy

Discovery and final audit each allow up to **480 seconds per model request** (verification: **180 seconds**, hard cap: **600 seconds**). The review workflow has a 30-minute overall job limit to accommodate sequential stages. Override per mode with `GEMINI_DISCOVERY_TIMEOUT_MS` or `GEMINI_AUDIT_TIMEOUT_MS`; `GEMINI_TIMEOUT_MS` remains a fallback override.

Workflow logs report the review mode, request/context byte sizes, timeout budget, and elapsed time—not the prompt, diff contents, or API key. A Gemini request timeout is not retried against Gemini: the request (or, for a large diff, that part) is handed to Claude and the timeout is recorded as the fallback reason in the review footer. Only if Claude cannot take it (no credential, or its allowance for this PR is spent) does the run **fail closed** without claiming a successful review; after checking the logs, use `@gemini review` to manually retry an unchanged HEAD. Large diffs are split into parts (see above), so one timeout no longer costs the whole review.

You do **not** need to remember discovery, verification, round numbers, or provider selection.

Manual commands (the first nonblank line must be exactly one of these):

```text
@gemini review   # manual retry; allowed past automatic $6 cap, $5 per Claude call
@claude review   # the same review as @gemini review, with Claude as the only model ($5 per run)
```

Gemini review runs automatically only when a PR is opened, reopened, or marked ready. **New pushes do not trigger a review**; comment `@gemini review` or `@claude review` when you want the latest HEAD reviewed. **The two commands are the same review; only the model differs.** Whatever the session calls for (a first review, an incremental check, verification of a repair, the final audit, or continuing a partial review) is what either command does; `@gemini review` tries Gemini first and lets Claude finish what Gemini cannot, `@claude review` uses Claude alone and never needs a Gemini key or session. Both are exempt from the automatic per-PR cap the same way, and on a HEAD that is already READY both are a no-op (use `@jiaze-claude-review-bot reset review` for a fresh review). A complete, clean pass is READY by itself (partial coverage is PARTIAL, never READY). `@claude review` is never automatic. **Every first full review takes one route, whatever its size or provider:** the diff is split by file into shards (about 100 KB each, at most 20, so a small PR is one shard), and each shard is reviewed by the first provider that can: Gemini first (cheaper, inline diff, its own API key), and Claude (with Read/Glob/Grep tools) for any shard Gemini cannot finish. Gemini is switched off for the rest of a run once it is out of credits, rate limited, down or misconfigured (HTTP 402/429/5xx/400/401/403/404) or after two shard-level failures; the review says how many shards Claude took over and why. Up to 3 shards run at once within a 16-minute deadline; Claude's share is bounded by the run budget ($5 for a manual command, the per-PR automatic allowance otherwise, and when that is spent Gemini alone can still review; Gemini is billed to its own key, not that ledger). The review lists reviewed/assigned files per shard. Concerns already dismissed or settled in the session are shown to every shard, and an exact repeat of a dismissed finding is not reported again. If a run cannot reach every file (time, budget), the session remembers which files it covered; comment `@gemini review` or `@claude review` again on the same HEAD and only the remaining files are reviewed. Binary assets (png, jpg, gif, ico, pdf, fonts) are skipped automatically. A repository can skip more (lockfiles, generated code) with a `.reviewbotignore` file at its root (gitignore-style patterns, one per line, `#` comments); the bot reads it from the PR's **base** commit, so a PR cannot exempt its own files. Skipped files are reported as skipped, not as unreviewed. A clean, complete pass is READY by itself; any file no provider reached makes it PARTIAL, never READY. Delta reviews after a repair (verification, incremental) and the final audit keep the staged pipeline (validator, verification rounds, audit before READY) but use the same model layer: a small diff is one request as before, a diff over about 300 KB is split by file into up to 20 parts (3 at a time, 20-minute limit) reviewed Gemini first with Claude for any part Gemini cannot do (any Gemini failure, not just out of credits: it is recorded as the fallback reason, and Gemini is skipped for the rest of the run after a credit, rate-limit, outage or key error, or two other failures). The parts are merged back into one result: findings deduplicated and limited to what a session records, and for verification the verdict of a finding comes from the parts that contain its file, worst first. Claude calls in a large run are capped at $1 each within the same $5 manual or per-PR automatic allowance, counted across parts.

`@gemini review` is the same as the original `@jiaze-claude-review-bot review`, and `@jiaze-claude-review-bot claude review` is the same as `@claude review`; the longer forms keep working.

If the PR has changed so radically that the old review session should be discarded:

```text
@jiaze-claude-review-bot reset review
```

Reset is intentionally explicit; the normal review command never silently opens unlimited discovery rounds.

If you have read the open findings and decide the PR is fine to merge anyway (for example when the session is stuck in REWORK or HUMAN_REQUIRED):

```text
@jiaze-claude-review-bot override review
```

This needs write access, spends no model quota, waives both confirmed-open and unresolved-uncertain material findings (they stay in the record as WAIVED), and explicitly marks the current HEAD **READY (manually overridden)**. This is a human risk acceptance, *not* a claim that the bot disproved the concern. A later commit starts a fresh bounded session.

### Findings as review threads

Every finding is posted as an inline review thread you can resolve. A finding is pinned to its own line when that line is part of the PR's diff (changed or an unchanged line inside a hunk); otherwise to the nearest changed line of the same file, with a note saying so. Only a finding about a file the PR does not touch (or a file GitHub gives no patch for) stays in the review body under "Findings without an inline anchor". Each thread carries a hidden marker, and at the end of every review run the bot resolves the threads of findings that are now **FIXED**, **DISMISSED** or **WAIVED** (an override), so the PR's unresolved-thread count is the number of problems still open. It only ever resolves threads it opened itself, never reopens one, and never undoes a person's own resolve or unresolve; if the GitHub App lacks permission to resolve threads the step warns and the review is unaffected. Threads posted before this feature have no marker and are left for you to resolve by hand.

**Resolving a thread means "I fixed it", and the review checks that.** When a person with write access clicks **Resolve** on the bot's threads, nothing turns green by itself. Once *every* blocking (P0-P2) finding has been resolved and new commits exist since the last review, the normal verification review starts automatically (Gemini first, Claude continues if Gemini cannot; same route as `@gemini review`), and only its result decides READY. A finding that is really fixed becomes FIXED; one that is still open has its thread reopened with the reviewer's reason as a reply. If everything is resolved but nothing was pushed, there is nothing to check, so the threads are reopened with a note to push a fix or use `@gemini dismiss`. Resolving a non-blocking (P3) thread simply closes that finding for good, and unresolving it reopens it, with no model run. Only a writer's resolve counts and the bot's own resolves never do. This needs the GitHub App to be subscribed to the **Pull request review thread** event (App settings, Permissions & events, Subscribe to events) and the Worker redeployed.

**Very large PRs and the final audit.** The final audit normally runs as one staged request (or up to 20 parts). If the diff is bigger than that even after the ignore rules, the audit is run by the sharded engine instead (Gemini first, Claude continues): it can continue over several runs, a PARTIAL result is continued by the next review command, and a complete pass with no blocking finding counts as the audit and makes the HEAD READY.

### Dismiss a disproven finding without skipping final audit

An authorized repository writer can dismiss **one specific** confirmed-open **or UNCERTAIN** P0/P1/P2
candidate on the **same exact reviewed HEAD** by posting a fresh PR comment with 1–3 evidence links:

```text
@gemini dismiss F001
Reason: The report mixes exact Git reference lookups with matching-refs; the exact endpoint does not return arrays.
Evidence: https://docs.github.com/en/rest/git/refs
Evidence: https://api.github.com/repos/actions/checkout/git/ref/tags/v5.0
```

The `Reason:` line must be 30-400 characters; supply 1-3 `Evidence:` lines
with credential-free HTTPS URLs. Evidence is **attributed to the human operator**,
not automatically certified by the bot. The workflow re-reads the source
comment, validates its PR, author, writer permission and the unchanged HEAD,
and stores actor, cited links, reason, source comment, HEAD and timestamp in
the durable session.

Only the named OPEN or UNCERTAIN material candidate becomes **DISMISSED**.
Other confirmed or unresolved candidates remain blocking. A successful cited
dismissal does not pretend the underlying claim was model-verified. If the
audit has not passed, the session enters **AUDIT_PENDING** and runs the normal
Final Audit; an already completed audit is not repeated.

Resolving a GitHub review thread alone is not a dismissal. The separate
`override review` command still waives the entire PR and is **not** used
to adjudicate false positives.

## Convergence rules

These keep the reviewer from finding "one more thing" forever:

- **Known-issue ledger.** Only REJECTED candidates, human-dismissed claims and nonblocking P3s enter the settled/suppression ledger. UNCERTAIN P0–P2 concerns retain actionable IDs and **are never suppressed as settled**. The review notes which settled items were omitted.
- **Evidence rule.** Every finding must give a concrete `failurePath` (input/state -> wrong result). A P0/P1/P2 without one is demoted to non-blocking P3, and a validator CONFIRMED verdict with no cited evidence becomes UNCERTAIN.
- **Exact-HEAD source check.** A validator `CONFIRMED` verdict additionally needs a real code quote (`path`, one-based `line`, exact excerpt) present both in targeted context and at that line in the reviewed checkout. Unsupported or invented citations become visible **UNCERTAIN blockers**, not invented confirmed bugs. This verifies a quote, **not the correctness of a claimed failure path**; externally dependent claims still require authoritative verification.
- **Narrow external-fact guard.** Only explicit assertions that a particular GitHub Action `owner/repo@ref` does not exist are eligible for an official GitHub ref check. The absence claim must directly attach to that reference, not an unrelated local defect such as missing permissions. An existing ref disproves the missing-ref claim; absence is considered verified only if the action repository is accessible. All other findings—including workflow security issues, local `provider` bugs, and third-party API claims—follow the ordinary Gemini validation path without an automatic downgrade. Probes use only `api.github.com` with a bounded timeout and never fetch untrusted URLs.
- **Manual override.** See above.

READY means the **review's** required evidence is resolved and its audit gate passed; separate CI, approvals and GitHub branch protection remain mandatory before merge. A manual override is visibly marked.

## Review policy

The automatic state machine is:

```text
New PR / changed HEAD
       |
       v
Discovery or incremental review
       |
       +-- No material candidates ------+
       |                                |
       +-- P0/P1/P2 candidates          |
                    |                   |
             Targeted validator         |
                    |                   |
        +-----------+----------+        |
        |           |          |        |
     REJECTED   CONFIRMED   UNCERTAIN    |
        |           |          |        |
        |         REWORK   HUMAN_REQUIRED
        |           |          |
        |        fix + push   evidence-based dismissal,
        |           |        code change or explicit waiver
        |           |          |
        +-----------+----------+--------+
                                       |
                              Final audit if required
                                       |
                         same material-validation rules
                                       |
                       zero unresolved material candidates
                                       |
                                     READY
                          (also require independent CI)
```

Material validation is not a second discovery pass: it may only confirm, reject, or mark uncertain the candidates already produced by discovery, and must actively check downstream guards, fingerprints/scope filters, and relevant tests before confirming. **UNCERTAIN is not REJECTED:** it is persisted as a review blocker (not a confirmed bug); an independent audit may not silently suppress it. After evidence-based human dismissal, the normal final-audit rule still applies. Verification is likewise not allowed to reopen broad, unrelated discovery. A new finding is valid there only when it is a regression directly caused by the repair (except a catastrophic P0/security issue). After convergence, one independent final audit gets a fresh look at the final cumulative diff; it can run only once and any confirmed audit finding returns to targeted verification rather than reopening broad discovery. These bounds prevent the endless “review → fix → fresh full review → new edge case” loop.

Codex is deliberately **not automatic in v1**. At HUMAN_REQUIRED, use a targeted Codex or Claude review only when human judgment says the remaining issue is worth escalation. This keeps Codex and Claude usage low.

## Security and execution model

The GitHub comment is only a trigger. The central workflow pins the exact PR HEAD, builds trusted diff context, runs the reviewer without a GitHub write token, and re-checks HEAD before publication.

Default Gemini review is intentionally lightweight:

```text
model: gemini-flash-latest   # moving alias; override with GEMINI_MODEL to pin
thinking: MEDIUM (discovery); LOW for verification and ordinary final audit
input: exact cumulative PR diff for discovery and final audit
       exact previous-HEAD..new-HEAD delta for incremental review
       repair diff + durable open findings for verification
```

Gemini is not given agent tools or repository write access. The existing Claude deep-review path retains its read-only sanitized snapshot and host-enforced tool policy.

A durable **Independent Review Session** comment records READY / REWORK / HUMAN_REQUIRED, stable finding IDs (F001, F002, ...), verification count, and next action. The bot only trusts session comments authored by its own GitHub App identity.

The first nonblank line must contain only a supported command. Matching ignores case and ordinary spaces/tabs; quoted commands, fenced/indented code, lists, mid-prose mentions, and edited comments do not trigger.

### Deploying a trigger change

A GitHub commit updates the central workflow, but does not by itself prove the
Cloudflare webhook Worker is running new code. Redeploy the existing Worker from
the updated checkout (preserving its existing secrets):

```bash
npm test
cd worker
npm ci
npm run deploy
```

After deployment, verify one fresh PR lifecycle event (open a non-draft PR or move
a draft to Ready) and confirm that the matching automatic trigger reaches the
central run and its bot-authored status. The manual `@gemini review` command should still
work as a fallback. The `test.yml` workflow runs deterministic trigger/status
tests without Claude calls or Cloudflare deployment.

Repository code cannot change the GitHub App event subscription or deploy the
Cloudflare Worker by itself: after merging a trigger change, subscribe the App to
**Pull request** events and redeploy the Worker from the merged checkout.

## Legacy Claude deep-review path

- Listens for `@claude review` on pull requests through one GitHub App.
- Works across every repository where that App is installed; target repos do not need their own Claude workflow.
- Rejects triggers from users without write/admin access.
- Pins the review to the exact PR head SHA that was current when the command was sent.
- Checks out the target repository and gives Claude the real PR diff plus read access to the repository code.
- Claude is review-only: it does not edit, push, merge, or approve code.
- Publishes actionable findings as inline PR review comments when they can be anchored to changed lines; otherwise includes them in the review summary.
- Uses Claude Code's moving `sonnet` alias at `medium` effort with a 24-turn ceiling to give non-trivial PRs enough room to finish while still bounding subscription usage.
- The alias is resolved by the Claude Code CLI bundled in `@anthropic-ai/claude-agent-sdk`, so it only follows new Sonnet releases when the SDK is current. `.github/dependabot.yml` opens a PR for each new SDK release; merge it to move the alias forward. The published review's runtime line shows the resolved model.
- Reports the resolved model, agent turns, and SDK token usage in each published review.

## Architecture

```text
PR opened / reopened / ready
or manual review command
        |
        v
GitHub App webhook / Cloudflare Worker
        |
        v
review-v2.yml (serialized per PR)
        |
        +--> exact-HEAD preflight + PR diff
        +--> restore durable review session
        +--> choose automatically:
        |      Gemini discovery
        |      Gemini verification
        |      one-time Gemini final audit
        |      no-op / HUMAN_REQUIRED
        |
        +--> exact-HEAD publisher
        +--> update durable session comment
        |
        v
READY / REWORK / HUMAN_REQUIRED
```

The provider is an implementation detail. The session policy, stable finding IDs,
round budget, and GitHub publication are separate from the Gemini/Claude adapters.
A future ReviewLoop integration should call this service through one thin review
interface rather than embedding provider-specific logic in ReviewLoop core.

## Review cost controls

Default automatic review:

```text
discovery:
  model: gemini-flash-latest
  thinking: medium
  structured-output budget: 32k (medium thinking)
  passes: 1

material validator:
  model: gemini-flash-latest
  thinking: medium
  structured-output budget: 8k normally; 32k for state-integrity candidates
  passes: max 1 per discovery
  only CONFIRMED blocks

verification:
  model: gemini-flash-latest
  scope: repair diff + open findings
  passes: max 2

final audit:
  model: gemini-flash-latest
  thinking: low normally; medium only for deterministic state-integrity risk
  structured-output budget: 16k normally; 32k for medium state-integrity audit
  scope: final cumulative PR diff
  passes: max 1 per session
  state-integrity risk: explicitly test read-modify-write boundaries, stale snapshots,
                        lost updates, TOCTOU, CAS/version checks and two-actor interleavings
  P0/P1/P2 candidates: targeted medium validator

P3: non-blocking
same HEAD: no model call
```

Gemini receives bounded textual context rather than repository tools. Discovery
uses the exact PR diff. The material validator receives only targeted context for
each candidate (primary file, relevant PR hunk, matching symbols/guards and tests).
Verification uses only the repair diff plus durable open findings. Before model review, a zero-model-cost deterministic classifier inspects added diff lines for a narrow combination of synchronization/transaction primitives plus durable/shared-state changes. The final audit reuses the cumulative PR diff exactly once after convergence; only a state-integrity hit changes its thinking level and prompt. The request has a hard output/thinking-token ceiling and the publisher fails closed on malformed output or a moved PR HEAD.

Claude remains an explicit deep-review escape hatch:

```text
model: sonnet
effort: medium
maxTurns: 24
```

It is not part of the normal automatic loop. Explicit Claude calls are bounded
to $2 each even if prior automatic fallback calls already reached the $6 PR cap.
Codex is also not called automatically; use targeted escalation after HUMAN_REQUIRED.

## One-time setup

There are two pieces that cannot be created from repository code alone: your GitHub App registration and secrets. Everything else lives in this repository.

### 1. Create a GitHub App

GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App.

Suggested permissions:

- Actions: **Read and write** (to dispatch the central workflow)
- Contents: **Read-only**
- Issues: **Read-only** (to receive PR conversation comments)
- Pull requests: **Read and write** (to receive PR lifecycle events and publish PR reviews)
- Metadata: read is implicit

Subscribe to both **Issue comment** and **Pull request** events.

Install the App on your account and choose **All repositories** if you want Codex-like account-wide behavior.

Generate one private key for the App. Never commit it to this repository.

### 2. Deploy the webhook Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npm run deploy
```

Use the deployed Worker URL as the GitHub App Webhook URL. Set the same random value as both the GitHub App webhook secret and `GITHUB_WEBHOOK_SECRET` in the Worker.

### 3. Add central-repo secrets/variable

In this repository -> Settings -> Secrets and variables -> Actions:

Repository variable:

- `APP_ID`: numeric GitHub App ID

Repository secrets:

- `APP_PRIVATE_KEY`: complete GitHub App private-key PEM
- `GEMINI_API_KEY`: Google AI Studio / Gemini API key used by the default bounded reviewer
- `CLAUDE_CODE_OAUTH_TOKEN`: Claude Code OAuth token used only by explicit Claude deep review

The OAuth token can be generated locally with Claude Code using `claude setup-token` if that authentication mode is available to your account.

### 4. Merge the review-service branch into `main`

The Worker dispatches `.github/workflows/review-v2.yml` on `main`, so the workflow must exist on `main` before end-to-end testing.

### 5. Test

Open a non-draft PR in any repository covered by the GitHub App, or move a draft
PR to **Ready for review**.

Expected behavior: the PR event automatically runs a Gemini discovery review and
creates an **Independent Review Session** comment. If material findings exist,
push a repair, then comment `@gemini review` to run targeted verification (pushes do not trigger it).
After findings converge, the workflow automatically runs the one-time final audit
before READY. A later commit after READY is reviewed only when you comment `@gemini review`.

The manual command remains useful for retrying a stopped/no-op path:

```text
@gemini review
```

## Security model

The GitHub App is intentionally review-only. V1 does not grant Claude code-write, push, merge, or approval permissions. The webhook verifies GitHub's signature and checks that the triggering user has write/admin-level repository access before spending Claude quota.
