# claude-review-bot

Account-wide bounded PR review service for GitHub.

## Daily use

For normal work, remember one command:

```text
@jiaze-claude-review-bot review
```

That command is intentionally stateful and simple:

- First review of a PR/session: **Gemini 3.8 Flash, low thinking, one discovery pass**.
- If material P0/P1/P2 findings exist, push a repair and use the **same command** again.
- The next call becomes targeted **verification**, not another full PR discovery.
- At most **2 verification rounds** are allowed.
- P3 findings are non-blocking.
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
Gemini DISCOVERY (once)
        |
        +-- no P0/P1/P2 --> READY
        |
        +-- material findings --> REWORK
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

Verification is not allowed to reopen broad, unrelated discovery. A new finding is valid there only when it is a regression directly caused by the repair (except a catastrophic P0/security issue). This is the mechanism that prevents the endless “review → fix → fresh full review → new edge case” loop.

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

After deployment, use one fresh supported command on a PR and verify the matching
source-comment ID in the real central run and its bot-authored status. The new
`test.yml` workflow runs deterministic trigger/status tests without Claude calls
or Cloudflare deployment. No deployment or App installation is changed by those
tests.

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
PR comment: @jiaze-claude-review-bot review
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
model: gemini-3.8-flash
thinking: low
discovery passes: 1
verification passes: max 2
P3: non-blocking
same HEAD: no model call
```

Gemini receives bounded textual context rather than repository tools. Discovery
uses the exact PR diff; verification uses only the repair diff plus durable open
findings. The request has a hard output/thinking-token ceiling and the publisher
fails closed on malformed output or a moved PR HEAD.

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
- Pull requests: **Read and write** (to publish PR reviews)
- Metadata: read is implicit

Subscribe to the **Issue comment** event.

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

On a PR in any repository covered by the GitHub App, add:

```text
@jiaze-claude-review-bot review
```

Expected behavior: the first call runs a Gemini discovery review and creates an
**Independent Review Session** comment. If material findings exist, push a repair
and use the same command again; it automatically runs targeted verification.
The session eventually reaches READY or HUMAN_REQUIRED and does not loop forever.

## Security model

The GitHub App is intentionally review-only. V1 does not grant Claude code-write, push, merge, or approval permissions. The webhook verifies GitHub's signature and checks that the triggering user has write/admin-level repository access before spending Claude quota.
