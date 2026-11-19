# Design — Drop all old-format compatibility (PR 101)

- **Plan**: `docs/remove-legacy-session-import/Plan.md` (Jack, 2026-11-19) · **policy_sha**: `7f01e5a3ff53ed13ba763d684a098c0989425ec4` · **Baseline**: `a831e92`
- **Goal / scope / non-goals**: exactly the Plan. Old hidden-state comments and earlier-import records are ignored; such a PR is "new". No budget, model, permission, interface, merge or deploy change.

## 1. Verified facts (file:line, excerpt)
- **F1** `scripts/review-ledger.mjs:425,433-435`: `buildLedger` collects every bot comment that does not parse as a ledger record but contains `<!-- jiaze-review-session:v1 -->` into `legacy[]`.
- **F2** The same marker is written by the CURRENT writer: `scripts/review-session-core.mjs:1155` `'<!-- jiaze-review-session:v1 -->'` is the first line of `renderSessionComment` (the editable summary/"projection"). So `legacy[]` also holds today's projection comment; `projection = legacy.at(-1)` (`review-ledger.mjs:506`) is how writers find it to edit (`session-store.mjs:148,168`, `plan-review-session.mjs:45`). **The marker and `projection` must stay.**
- **F3** `review-ledger.mjs:479-480,517-523`: with zero handoffs, the newest `legacy` comment returns `stopped(RECORD_UNRECOVERABLE)` when it has no `jiaze-review-state:` block or does not decode, else `{ state: 'needs_import', legacy: { session, commentId } }`. With no legacy comment it returns `{ state: 'new', session: null }`. `review-ledger.mjs:606` also exposes `legacyCommentId` (no other reader in `scripts/`, `tests/`, `.github/`).
- **F4** `review-ledger.mjs:7` imports `parseSessionComment`; `review-session-core.mjs:1215-1225` defines it (decodes `jiaze-review-state` base64). Its only non-test caller is `review-ledger.mjs:521`; tests import it in 5 files but call it once (`tests/review-session.test.mjs:109`, `assert.equal(parseSessionComment('ordinary comment'),null)`).
- **F5** `review-ledger.mjs:23` `STAGES = ['first','verification','audit','closing','import']`; `:343` rejects a handoff whose `Stage` is not in `STAGES` as `bad('handoff', ...)` (a stop). `:621-638` `renderImportParts` writes `### Review Handoff · Seq 1 · import` (header built at `:171`/`:198`) and is called only by `session-store.mjs:77` and tests.
- **F6** `session-store.mjs:59-66` `loadLedger(..., importLegacy = true)` calls `importLegacySession` (`:75-82`) on `needs_import`. Callers: `sweep-stale-deep-reviews.mjs:50` passes `importLegacy: true` (`:86-91` returns `ledger.legacy.session` on `needs_import`); `sync-commit-status.mjs:76-78` passes `false` and returns `ledger.legacy.session` on `needs_import`; `session-store.mjs:91` and `apply-dismissal.mjs:93` pass `false`.
- **F7** Tests: `tests/review-ledger.test.mjs:204-221` (import round-trip) and `:222-229` (damaged/stateless old comment must stop; its third assertion, a garbled `### Review Handoff`, is a current-format check); `tests/helpers/fake-pr.mjs:10-14` `legacyStateComment`, `:44-49` `seedImport`, `seedLegacy` (no caller outside the helper and the ledger test).
- **F8** Production data: `gh api repos/Jiaze-Li/SpinLab/issues/220/comments` shows only the old session comment and one dismissal-format comment from the bot; a search for the text "Import of an earlier review session" over PR comments returned 0 results. So no live PR carries import records.

## 2. Options
- **A (adopted): delete.** Remove the `needs_import` state and everything that produces/consumes it; keep the marker/projection. Old-only content then falls into the existing `new` branch with no new code.
- **B: keep the reader, make it return `new`.** Rejected: leaves a dead decoder and base64 parsing the Plan asks to remove.
- **C: an explicit "ignore records before cutoff" mechanism for imported chains.** Rejected: new machinery for a case F8 shows does not exist.

## 3. Assumptions
1. No live PR has import-stage records (F8, verified for SpinLab #220 and by search; other private repos not individually listed). If one appeared, see I3.
2. A PR whose only bot comment is today's own summary comment (marker, no records) is also "new". Today it stops; that stop only protected old state it could not read, so it is dropped with the rest.
3. The old comment may be edited by the next run (the summary comment is reused as `projection`); the Plan allows this.

## 4. Design
1. `buildLedger`: delete `legacyHasState`, the `needs_import` return, the `stopped` returns for stateless/undecodable legacy comments, and `legacyCommentId`. Keep `legacy[]` renamed `summaries` only as the source of `projection`. Zero-handoff, no-record case returns `new`.
2. `parseRecord`: a head matching `### Review Handoff · Seq <n> · import` returns `null` (not a record, not a stop), so import-stage comments are ignored like any other unknown comment. Remove `'import'` from `STAGES`.
3. Delete `parseSessionComment` (+ its 5 test imports and the one assertion), `renderImportParts`, `importLegacySession`, and the `importLegacy` parameter of `loadLedger` and its 4 callers; delete the `needs_import` branches in `sync-commit-status.mjs` and `sweep-stale-deep-reviews.mjs` (they then get `ledger.session ?? null`).
4. Tests: remove the import round-trip and the two old-comment "must stop" assertions; add the new tests in §6. Remove `legacyStateComment`, `seedImport`, `seedLegacy` from the helper (keep `seed`). Keep the garbled-handoff assertion.

## 5. Invariants
- **I1** Only the marker-bearing summary comment and unknown comments are ignored; every parseable current-format record keeps its existing checks (edited/collapsed → stop, incomplete read → stop, Seq/Prev chain, unclosed stage, table/snapshot mismatch).
- **I2** Records exist with zero handoffs and no run snapshot → still `STAGE_NOT_CLOSED` (unchanged branch, F3 before the legacy test).
- **I3** An import-stage comment is ignored; if later current handoffs chain to it (`Prev` = its id), the existing chain check stops loudly. Not reachable in production per F8.
- **I4** The workflow guard test (every ledger-reading step names the bot account) is untouched.

## 6. Verification (claim → how it could fail → evidence)
- **V1 (AC1)** old comment readable / undecodable / stateless / import-stage-only → still stops or imports → `tests/review-ledger.test.mjs`: each of 4 inputs gives `state: 'new'`, `session: null`.
- **V2 (AC2)** sync/sweep read old state → `tests/review-status.test.mjs` and the sweep test with a fake PR holding only an old comment: status path gets no session, sweep returns false, no import comment is posted (assert on fake-PR POST calls).
- **V3 (AC3 / I1)** damaged current records ignored by accident → existing tests (edited, collapsed, incomplete read, broken chain, garbled handoff, unclosed stage) pass unchanged; one new test: a stage-closed-less finding record next to an old comment still stops.
- **V4 (AC4/5)** `npm test` fully green; the guard test still present; `grep -rn "needs_import\|importLegacy\|renderImportParts\|parseSessionComment\|jiaze-review-state" scripts tests` finds only the "no hidden state" negative assertions.
- **V5 (AC6)** SpinLab #220 real check: NOT RUN until Jack triggers a review after merge.

## 7. Work Contract (used verbatim by Code)
- **Outcome**: §4 implemented; I1–I4 hold; Plan AC1–AC5 pass; AC6 reported as NOT RUN.
- **Authorized**: edit, commit and push on branch `cleanup/remove-legacy-session-import-20261119`; update PR 101. **Not authorized**: merge, deploy, edits to other repositories, budget/model/permission/interface changes.
- **Global verification**: `npm test`; `node --check` on `scripts/review-ledger.mjs`, `scripts/session-store.mjs`, `scripts/sync-commit-status.mjs`, `scripts/sweep-stale-deep-reviews.mjs`, `scripts/review-session-core.mjs`, `scripts/apply-dismissal.mjs`.
- **Stop conditions**: `HUMAN_REQUIRED`, or any need to change behaviour for current-format records (I1) → stop and report. After local PASS and push, stop for Jack's acceptance.
