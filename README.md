# claude-review-bot

Account-wide Claude PR reviewer for GitHub.

Goal: install one GitHub App once, then use the same command in any authorized repository:

```text
@claude review
```

The comment is only a trigger. Claude reviews the actual PR diff and the checked-out repository code, then the bot publishes a GitHub PR Review back to that PR.

## What V1 does

- Listens for `@claude review` on pull requests through one GitHub App.
- Works across every repository where that App is installed; target repos do not need their own Claude workflow.
- Rejects triggers from users without write/admin access.
- Pins the review to the exact PR head SHA that was current when the command was sent.
- Checks out the target repository and gives Claude the real PR diff plus read access to the repository code.
- Claude is review-only: it does not edit, push, merge, or approve code.
- Publishes actionable findings as inline PR review comments when they can be anchored to changed lines; otherwise includes them in the review summary.

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
