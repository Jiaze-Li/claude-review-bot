# Plan — Review Bot Repository Rename and Safe Migration

Task: ENG-REVIEW-BOT-RENAME-20261117
Version: 1.0
Stage: Plan (Design and Code not yet authorized by stage gate)
Policy SHA: `7f01e5a3ff53ed13ba763d684a098c0989425ec4`
Source repository: `Jiaze-Li/claude-review-bot`
Target repository name: `Jiaze-Li/review-bot`
Plan baseline: `43e9e739e6b2b61358deaded414d5796179b8d8f`

## 1. Problem and outcome

The GitHub source repository is historically named after Claude even though the PR review service now supports Gemini and Claude. Rename the *existing* repository to `Jiaze-Li/review-bot` and migrate references so the deployed GitHub review service continues to operate and PR history, review sessions, and integrations are preserved.

Success means the real deployed reviewer functions on its new source-repository identity; a successful GitHub rename or passing unit tests alone do not constitute acceptance.

## 2. Users and failure impact

The owner and any repositories using the existing GitHub App rely on review triggers and independent PR review sessions. A broken control-repository reference or Worker deployment could silently disable PR review, leave review sessions stale, or misstate which HEAD was reviewed. Prefer fail-closed outcomes and explicit reporting over an unverified READY.

## 3. Confirmed hard constraints

- Rename the *existing* GitHub repository; do not create or migrate to a replacement repository.
- Preserve existing branches, PRs, Issues, commit history, and review-session evidence.
- Preserve the existing GitHub App identity, command compatibility, Webhook URL, Cloudflare Worker service name, authentication, permissions, and secrets. No App rename or Worker rename as part of this task.
- Update runtime control-repository references, code defaults, and relevant active documentation/integrations, including ReviewLoop references, where needed; distinguish live references from historical records.
- Keep the PR review behavior and review budget/policy unchanged; do not combine this rename with the proposed `dismiss` verification or `taskType: pr` work.
- Follow Plan → Design → Code stop points and applicable independent review; conduct no production cutover without a reviewed migration and a practical recovery path.
- No automatic merge, credentials/permission changes, destructive changes, or new services unless separately authorized.

## 4. Non-goals

No redesign of ReviewLoop, no refactoring of the review engine, no change to model selection or finding severity, no new ReviewLoop task types, no rewrite of historical PR comments, no new GitHub App, no new Cloudflare Worker identity.

## 5. Acceptance criteria (observable)

1. GitHub reports `Jiaze-Li/review-bot` as the canonical full name of the same repository ID, with existing branches/PRs/Issues/commits intact. Historical URLs are checked for appropriate redirects; Actions and reusable-workflow references are audited explicitly because redirects do not cover all integrations.
2. The deployed Webhook Worker still uses its existing service name and URL but dispatches review work to the renamed control repository. Its runtime configuration and fallback path agree, and its deployed identity is verified rather than inferred from committed config.
3. Active GitHub workflows and bot commands operate under the renamed repo; connected repository references in ReviewLoop and other identified active consumers are migrated or verified compatible. Historical evidence is preserved.
4. Relevant automated tests run and pass on the implementation HEAD; any unrun test is listed as NOT RUN.
5. On a real authorized test PR, the deployed bot receives a trigger, launches an actual review run, publishes the authoritative bot-authored Independent Review Session, and binds its review result to the current PR HEAD. Exercise a command-triggered review path at minimum; check automatic PR event path when safe/available.
6. No manual override, waiver, or fabricated review status is used to demonstrate success. Report repository SHA, PR links, runtime deployment evidence, actual end-to-end result, residual risks, and recovery instructions.

## 6. Verified inputs and unresolved prerequisites

Read-only source observations on 2026-11-17:
- `worker/wrangler.toml` has `name = "claude-review-bot"` and `CONTROL_REPO = "Jiaze-Li/claude-review-bot"`.
- `worker/src/index.js` has a hardcoded `CONTROL_REPO` fallback with the previous repository full name.
- ReviewLoop README and active architecture/roadmap references use the old repository name; distinguish documentation links from the existing `@jiaze-claude-review-bot` App command, which must stay unchanged.
- The connected GitHub toolset permits ordinary GitHub read/write operations but does not expose repository rename, GitHub App settings, or Cloudflare Worker deployment controls in this Chat mode.
- `Jiaze-Li/review-bot` did not resolve at read-only inspection time; this does not prove namespace availability at the later cutover moment.
- Runtime Webhook deployment, App subscription, target-repo installation, required secrets and the ability to execute the rename through an authorized computer remain to be verified.

## 7. Authority and change boundary

The owner has requested the rename, associated migration, deployment and verification, and subsequently authorized direct execution. This authorizes preparing and updating migration materials/branches, code/config changes, committing and pushing changes, and a production cutover limited to the stated goal **when the required stage gate has been reached and the necessary execution capabilities are available**. It does not grant unbounded permission to change secrets, App identity, destructive data, or to silently merge a PR. GitHub repository settings changes and deployment require an appropriate connected execution surface; the currently available Chat GitHub tool cannot perform them.

The approved Plan does not by itself authorize skipping Design, its independent review, the Design-to-Code stop point, or final owner acceptance. Mark skipped or unavailable operations accurately.

## 8. Deliverables and handoff

One primary draft PR in the bot repository contains this full Plan (not only a brief). On authorization to enter Design, a local Agent reads this Plan at the frozen policy SHA and produces a complete design with Options, Assumptions and a Work Contract, using ReviewLoop Design review. Stop after Design PASS, then enter Code only on the explicit stage instruction. Keep the renamed repository's relevant active dependencies consistent and report tested versus untested states separately.
