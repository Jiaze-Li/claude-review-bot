# pr-bot

Independent, static pull-request review for Jiaze-Li's repositories. One path for every non-draft PR.

## Use

Nothing to configure per PR. A review starts when a non-draft PR is opened, marked ready, reopened or pushed to. To make sure the current commit has a result (also to resume a stopped review), comment on the PR:

```
@jiaze-claude-review-bot review
```

You get one bot comment (the only record) and the `claude-review-bot/review` commit status:

| Status | Meaning |
| --- | --- |
| IN_PROGRESS | the current round is being reviewed (sequential batches, with resumption) |
| CHANGES_REQUESTED | round 1 is complete and found P0/P1/P2: fix them together, push once |
| READY | the current commit is completely reviewed and has no unresolved P0/P1/P2 |
| STOPPED | automatic review cannot continue; the comment says why and what is unreviewed |

Two complete rounds per PR, P3 never blocks, and a hard cap on model executions per PR. Details: [docs/review-contract.md](docs/review-contract.md).

## Layout

- `worker/` Cloudflare Worker: verifies the webhook signature and trigger permission, ignores drafts, dispatches `review.yml`.
- `.github/workflows/review.yml` the one review workflow (plan -> exact-HEAD checkout and safe snapshot -> run).
- `scripts/review.mjs` the executor; `review-engine.mjs` pure decisions and transitions; `review-contract.mjs` the shared contract; `claude-provider.mjs` the single model call; `tool-gateway.mjs` read-only tools; `materialize-safe-tree.mjs` the sanitized snapshot.
- `scripts/migrate-v1.mjs` + `migrate-v1.yml`: one-time v1 -> v2 migration (delete after the cut-over).

## Configuration

Secrets: `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLOUDFLARE_*` (Worker deploy). Variables: `APP_ID`, optional `REQUIRE_STATUS_CHECK=true`, optional `REVIEW_MAX_TURNS` (14), `REVIEW_MAX_BUDGET_USD` (0.5), `REVIEW_TIMEOUT_MS` (480000) per model execution. A repository can skip files with a `.reviewbotignore` read from the PR's base commit.

## Develop

```
npm ci --legacy-peer-deps && npm test && npm run test:compat
npm run review:fixtures   # regenerate tests/fixtures/review-contract.json
```
