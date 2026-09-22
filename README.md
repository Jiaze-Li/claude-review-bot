# claude-review-bot

Account-wide bounded PR review service for GitHub.

## Daily use

Normal PR review is automatic once the GitHub App is subscribed to **Pull request**
events and the current Worker is deployed:

- opening a non-draft PR starts a bounded discovery session automatically;
- moving a draft PR to **Ready for review** starts it automatically;
- pushing a repair while the session is **REWORK** triggers targeted verification;
- pushing a new commit after **READY** starts a fresh bounded discovery session;
- repeated events for the same exact HEAD are idempotent and do not spend another reviewer call.

The manual command remains available as a retry/escape hatch:

```text
@jiaze-claude-review-bot review
```

The review session is intentionally stateful and simple:

- First review of a PR/session: **Gemini 3.8 Flash, low thinking, one discovery pass**.
- Any P0/P1/P2 discovery candidate gets one **targeted Gemini Flash / medium validation pass** over the candidate file, related symbols/guards, and matching tests.
- Only **CONFIRMED** material findings block. **REJECTED** and **UNCERTAIN** candidates remain visible in the review audit but do not enter REWORK.
- If confirmed material findings exist, push a repair; the new PR commit automatically triggers the next review step.
- A REWORK repair becomes targeted **verification**, not another full PR discovery.
- At most **2 verification rounds** are allowed.
- Once material findings converge, one independent final audit runs automatically on the final cumulative PR diff. It stays **Gemini Flash / low** for ordinary PRs; a deterministic state-integrity classifier escalates only shared-state/concurrency-sensitive PRs to **medium** with an explicit interleaving audit.
- Final-audit P0/P1/P2 candidates use the same targeted medium validator.
- The final broad audit runs **at most once per session**. If it finds a material bug, later calls are targeted verification only.
- P3 findings are non-blocking.
- A malformed/no-text structured Gemini review response is retried **once with the identical prompt, model, thinking level, and schema**; usage from both attempts is reported.
- Re-running on the same unchanged HEAD spends **no reviewer model quota**.
- If material findings remain after the verification budget, the session stops at **HUMAN_REQUIRED** instead of looping.
- Session state is stored in a bot-authored GitHub PR comment, so it survives new ChatGPT conversations, different agents, and local restarts.

You do **not** need to remember discovery, verification, round numbers, or provider selection.

Rare escape hatches:

```text
@jiaze-claude-review-bot claude review
@claude review
```

These request the existing explicit Claude deep review and do not replace the bounded Gemini session.

If the PR has changed so radically that the old review session should be discarded:

```text
@jiaze-claude-review-bot reset review
```

Reset is intentionally explicit; the normal review command never silently opens unlimited discovery rounds.

## Review policy

The automatic state machine is:

```text
NEW / changed-after-READY
        |
        v
Gemini DISCOVERY (once, low)
        |
        +-- no P0/P1/P2 --> FINAL AUDIT (once, low)
        |
        +-- material candidates
                |
                v
        targeted VALIDATOR (once, medium)
                |
        +-------+-------------------+
        |                           |
   no CONFIRMED                CONFIRMED
        |                           |
   FINAL AUDIT                    REWORK
   (once, low)                      |
        |                           v
        |                Gemini VERIFICATION
        |                (existing findings +
        |                 repair-caused regressions only)
        |                         |
        |              +----------+----------+
        |              |                     |
        |         FINAL AUDIT             still material
        |         (once, low)                  |
        |                              verification #2 max
        |                                      |
        |                           FINAL AUDIT or HUMAN_REQUIRED
        |                                     
        +------------------+
                           |
                 targeted validator if
                 audit finds P0/P1/P2
                           |
                  no CONFIRMED -> READY
                  CONFIRMED -> REWORK
                                    |
                                    v
                         Gemini VERIFICATION
                         (existing findings +
                          repair-caused regressions only)
                                  |
                     +------------+------------+
                     |                         |
                   READY                 still material
                                               |
                                      verification #2 max
                                               |
                                     READY or HUMAN_REQUIRED
```

Material validation is not a second discovery pass: it may only confirm, reject, or mark uncertain the candidates already produced by discovery, and must actively check downstream guards, fingerprints/scope filters, and relevant tests before confirming. Verification is likewise not allowed to reopen broad, unrelated discovery. A new finding is valid there only when it is a regression directly caused by the repair (except a catastrophic P0/security issue). After convergence, one independent final audit gets a fresh look at the final cumulative diff; it can run only once and any confirmed audit finding returns to targeted verification rather than reopening broad discovery. These bounds prevent the endless “review → fix → fresh full review → new edge case” loop.

Codex is deliberately **not automatic in v1**. At HUMAN_REQUIRED, use a targeted Codex or Claude review only when human judgment says the remaining issue is worth escalation. This keeps Codex and Claude usage low.

## Security and execution model

The GitHub comment is only a trigger. The central workflow pins the exact PR HEAD, builds trusted diff context, runs the reviewer without a GitHub write token, and re-checks HEAD before publication.

Default Gemini review is intentionally lightweight:

```text
model: gemini-3.8-flash
thinking: LOW
input: exact PR diff for discovery
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
central run and its bot-authored status. The manual review command should still
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
- Reports the resolved model, agent turns, and SDK token usage in each published review.

## Architecture

```text
PR opened / ready / synchronized
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
  model: gemini-3.8-flash
  thinking: low
  passes: 1

material validator:
  model: gemini-3.8-flash
  thinking: medium
  structured-output budget: 8k normally; 32k for state-integrity candidates
  passes: max 1 per discovery
  only CONFIRMED blocks

verification:
  model: gemini-3.8-flash
  scope: repair diff + open findings
  passes: max 2

final audit:
  model: gemini-3.8-flash
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

It is not part of the normal automatic loop, preserving Claude quota for Worker
tasks. Codex is also not called automatically; use targeted escalation only after
the bounded session reaches HUMAN_REQUIRED.

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
push a repair; the synchronize event automatically runs targeted verification.
After findings converge, the workflow automatically runs the one-time final audit
before READY. A later commit after READY starts a fresh bounded discovery session.

The manual command remains useful for retrying a stopped/no-op path:

```text
@jiaze-claude-review-bot review
```

## Security model

The GitHub App is intentionally review-only. V1 does not grant Claude code-write, push, merge, or approval permissions. The webhook verifies GitHub's signature and checks that the triggering user has write/admin-level repository access before spending Claude quota.
