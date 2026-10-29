# claude-review-bot

Account-wide bounded PR review service for GitHub: Gemini first, Claude where Gemini cannot, one session per PR.

## How a review works (the whole picture)

There is one session per PR, stored in a bot-authored **Independent Review Session** comment, and one rule for
every model and every PR size.

**Two kinds of review**

| Kind | What it looks at | Who runs it |
| --- | --- | --- |
| **Full review** | every file of the PR | the sharded engine: the diff is split by file into shards (~100 KB each, at most 20 per run, 3 at a time); each shard goes to Gemini first, and to Claude for whatever Gemini cannot finish |
| **Delta review** | only what changed since a reviewed state | the staged pipeline: *verification* (a repair against the open findings) and *incremental* (a small, low-risk change on a READY PR) |

A full review is used for: a PR's first review, the review after a big or risky change, `reset review`, and the
**final full review** (below). `@claude review` is the same review with Claude as the only model.

**The session status**

```text
 (new PR / @gemini review)
          |
   FULL REVIEW ---- nothing blocking, every file covered ------> READY
          |
          +--- P0/P1/P2 found ----> REWORK --- you fix, resolve threads --->  VERIFICATION (max 2 rounds)
          |                                                                      |        |
          |                                          findings fixed, none left   |        +-- still open: back to REWORK
          |                                                                      v           (after 2 rounds: HUMAN_REQUIRED)
          |                                                              AUDIT_PENDING
          |                                                                      |
          |                                                  FINAL FULL REVIEW (runs by itself, once)
          |                                                                      |
          +--- some files not reached ----> PARTIAL ---- continues by itself ----+--> READY (or REWORK for what it adds;
                                                                                        those are verified, no second full review)
```

* **READY** needs a complete pass over every changed file with no open P0/P1/P2 and nothing uncertain. It is the
  *review's* clearance; CI, approvals and branch protection still decide whether the PR can merge.
* **PARTIAL** means some files were not reached (time, budget). It is never READY. It continues by itself, up to
  3 more runs; `@gemini review` continues it by hand.
* **HUMAN_REQUIRED** means a person must decide: verification budget spent, an UNCERTAIN material candidate, or
  both providers unavailable. Use `@gemini dismiss F001` (with evidence) or `override review`.
* A new commit never inherits an old READY. A READY PR with a small, low-risk new commit gets an *incremental*
  review (at most 50 changed lines in at most 3 files; no workflow/security/schema/dependency paths; every 15th is
  a full refresh); anything else gets a full review.

## What you do

1. Open (or mark ready) a PR. A full review starts by itself. **Pushes do not trigger a review.**
2. Read the findings. Each one is a review thread pinned to a line.
3. Fix a problem, push, and click **Resolve** on its thread. Once *every* blocking thread is resolved and there is a
   new commit, the verification starts by itself and only its result decides READY; a finding that is not really
   fixed gets its thread reopened with the reason. P3 threads: Resolve closes the finding for good, no model run.
4. When everything is settled, the final full review runs by itself, and the session turns READY.
5. The newest comment at the bottom of the PR is always the session status: **when the status changes (or a new
   HEAD gets its result) it is posted as a new comment and the old one is removed**, so you do not have to look
   for it. If nothing visible changed it is edited in place.

**Commands** (the first non-blank line must be exactly one of these):

```text
@gemini review                          # review the latest HEAD: whatever the session calls for, Gemini first
@claude review                          # the same review, Claude only (no Gemini key needed)
@jiaze-claude-review-bot reset review   # discard the session and review from scratch
@jiaze-claude-review-bot override review  # a writer accepts the risk: waives open findings, READY (marked as manual)
@gemini dismiss F001                    # + Reason:/Evidence: lines, see below
```

`@gemini review` / `@claude review` are the same review; only the model differs. On a HEAD that is already READY
they do nothing. An unchanged HEAD never spends model quota.

## Money and models

* **Gemini** (`gemini-flash-latest`, its own API key) is tried first for every full-review shard and every delta.
  It is switched off for the rest of a run after a credit/rate-limit/outage/key error (HTTP 402/429/5xx/400/401/403/404)
  or two shard-level failures; the review says how much Claude took over and why.
* **Claude** (subscription OAuth token) takes what Gemini cannot. Its spend is a per-PR ledger:
  automatic reviews share a **$6 per-PR allowance** (a call does not start below $0.50); a person's command
  (`@gemini review`, `@claude review`, `reset review`, or resolving threads) may exceed it, each Claude call being
  capped at **$5**. Gemini is billed to its own key and never to this ledger. A dismissal or override is not a
  request for more review: what follows it obeys the automatic allowance.
* If neither provider can run, the session records **HUMAN_REQUIRED / reviewer unavailable** for that HEAD;
  `@gemini review` retries.
* The review of a very large PR is split over several runs: each run reviews up to 20 shards within a 16-minute
  deadline and remembers which files it covered; the next run (automatic, up to 3 more) takes the rest. The review
  lists reviewed/assigned files per shard.
* Binary assets are skipped. A repository can skip more (lockfiles, generated code) with a `.reviewbotignore` at its
  root (gitignore-style patterns); it is read from the PR's **base** commit, so a PR cannot exempt its own files.

## Findings

* Every finding is an inline review thread, pinned to its own line when that line is part of the diff, else to the
  nearest changed line (with a note). Only a finding about a file the PR does not touch, or a file that is deleted
  entirely, stays in the review body ("Findings without an inline anchor") and cannot be resolved by a click.
* At the end of every run the bot resolves the threads of findings that are now FIXED, DISMISSED or WAIVED. It only
  touches threads it opened, and never undoes a person's own resolve or unresolve.
* Convergence: only 2 verification rounds; each finding needs a concrete `failurePath` (trigger state → wrong result)
  or it is demoted to non-blocking P3; concerns already dismissed or settled are shown to every reviewer and an exact
  repeat is not reported again; a delta's P0-P2 candidates get one targeted validation pass that can confirm, reject
  or mark them UNCERTAIN (UNCERTAIN blocks READY; silence from a later review never clears it).
* A PR the deterministic classifier marks as touching shared durable state gets an explicit concurrency procedure
  (stale snapshots, lost updates, TOCTOU, two-actor interleavings) in every full-review prompt.

### Dismiss a disproven finding

An authorized writer can dismiss **one** open or UNCERTAIN P0/P1/P2 finding on the exact reviewed HEAD:

```text
@gemini dismiss F001
Reason: The report mixes exact Git reference lookups with matching-refs; the exact endpoint does not return arrays.
Evidence: https://docs.github.com/en/rest/git/refs
```

`Reason:` 30-400 characters and 1-3 credential-free HTTPS `Evidence:` lines. The evidence is attributed to the
person, not certified by the bot. The other findings stay blocking; when none is left the session goes to
AUDIT_PENDING and the final full review runs by itself. Resolving a thread alone is not a dismissal.

## Security and execution model

The GitHub comment is only a trigger. The central workflow pins the exact PR HEAD, builds trusted diff context,
runs the reviewer without a GitHub write token, and re-checks HEAD before publishing. A review published against
a HEAD that moved is refused. Gemini gets no tools; Claude has Read/Glob/Grep over a sanitized snapshot only
(no symlinks, submodules, `CLAUDE.md`, `.claude/`, `.mcp.json`) under host-enforced tool policy. The bot only trusts
session comments authored by its own GitHub App identity. Only commands from users with write access count, in
the first non-blank line (quoted, fenced, edited or mid-prose mentions do not).

Concurrency: the workflow is serialized per PR. A run that ends with work left starts the next run of the same
workflow itself (the `actions: write` permission is used only for that).

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

Expected behavior: the PR event automatically runs a full review and posts an **Independent Review Session**
comment. If it finds problems, fix them and resolve their threads; the review that checks the repair starts by
itself once every blocking thread is resolved (or comment `@gemini review`). Pushes do not trigger a review.

The manual command remains useful for retrying a stopped/no-op path:

```text
@gemini review
```

## Security model

The GitHub App is intentionally review-only. V1 does not grant Claude code-write, push, merge, or approval permissions. The webhook verifies GitHub's signature and checks that the triggering user has write/admin-level repository access before spending Claude quota.
