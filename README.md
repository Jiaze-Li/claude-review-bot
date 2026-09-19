# claude-review-bot

Account-wide Claude PR reviewer for GitHub.

Goal: install one GitHub App once, then use the same command in any authorized repository:

```text
@claude review
```

The comment is only a trigger. Claude reviews the actual PR diff and the checked-out repository code, then the bot publishes a GitHub PR Review back to that PR.

## Trigger format and trustworthy status

Use the dedicated command to distinguish this App from the separate official Claude App:

```text
@jiaze-claude-review-bot review
```

`@claude review` remains a compatible alias. The first nonblank line must contain
only the command. Matching ignores case, allows extra spaces/tabs between the
mention and `review`, trailing spaces/tabs, surrounding blank lines, CRLF, and
up to three leading spaces. Additional text on later lines is tolerated.
For example:

```text
@claude   review

Additional comment text can follow.
```

The comment remains only a trigger: extra text is not forwarded as reviewer
instructions. Put binding requirements in the PR description/repository contract;
the reviewer still inspects the actual exact-HEAD code and diff. Quoted commands,
fenced/indented code, lists, mid-prose mentions, and edited comments do not trigger.
Use a new comment to request another review; duplicate delivery of the same
comment retains the existing deduplication behavior.

This App never adds an eyes reaction on webhook receipt. Only after the central
workflow has actually started, passed deduplication and exact-HEAD preflight does
it post **Self-hosted Claude review**, with the run URL, attempt, source comment,
and target HEAD. The same status comment is updated after publication or failure
when workflow cleanup runs. If the runner is forcibly stopped or the status API
fails, follow the run URL for the authoritative outcome; a start notice is not a
completion certificate. Status is best-effort and never converts a failed review
into success. It uses the existing Pull requests write permission, without giving
Claude the GitHub token or requiring Issues write permission.

An eyes reaction from `claude[bot]` belongs to the separate official App, not
`jiaze-claude-review-bot[bot]`. This repository cannot prevent that other App from
reacting. Prefer the dedicated command, or remove this repository from the
**official Claude App's** repository access while keeping the self-hosted App
installed. Do not use another App's reaction as proof that this workflow ran.

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

## What V1 does

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
PR comment: @claude review
        |
        v
GitHub App webhook
        |
        v
Cloudflare Worker (small router)
        |
        v
this repo: review.yml
        |
        +--> checkout exact target PR SHA
        +--> build diff/context
        +--> Claude Code review
        +--> deterministic publisher
        |
        v
GitHub PR Review
```

## Review cost controls

The reviewer intentionally uses the Claude Code `sonnet` model alias rather than a version-pinned model ID. That keeps the reviewer on the current Sonnet generation as Claude Code updates its alias.

The trusted runner currently sets:

```text
model: sonnet
effort: medium
maxTurns: 24
```

`medium` effort reduces reasoning and tool-call token use relative to the default high effort. The turn ceiling prevents unusually large PRs from exploring indefinitely. Each successful review records the resolved model and the SDK-reported input, cache, output, and turn usage so expensive reviews can be identified from the PR itself.

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
- `CLAUDE_CODE_OAUTH_TOKEN`: Claude Code OAuth token

The OAuth token can be generated locally with Claude Code using `claude setup-token` if that authentication mode is available to your account.

### 4. Merge the V1 branch into `main`

The Worker dispatches `.github/workflows/review.yml` on `main`, so the workflow must exist on `main` before end-to-end testing.

### 5. Test

On a PR in any repository covered by the GitHub App, add:

```text
@claude review
```

Expected behavior: a central workflow starts in this repository and a Claude PR Review appears on the original PR.

## Security model

The GitHub App is intentionally review-only. V1 does not grant Claude code-write, push, merge, or approval permissions. The webhook verifies GitHub's signature and checks that the triggering user has write/admin-level repository access before spending Claude quota.
