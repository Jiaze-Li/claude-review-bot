# Design — RB-CONVERGENCE-01：PR 机器人顶层收敛、P3 规则对齐与改名 `pr-bot`

- **Task**：`RB-CONVERGENCE-01` · **Plan**：`v1.0`（`docs/pr-bot-convergence/Plan.md`）· **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4` · **基线**：`e8128cd`

## 1. 目标 / 范围 / 非目标
- **目标**：按 Plan 3 个阶段依次完成：① 统一 P3 阻塞判定与提示词，清理 Override 及换提交后的残留临时状态；② 非 `reset` 跨提交保留问题账本（未决阻塞项 + 已结案项 + 驳回账本 + 花费），支持同/跨 HEAD 显式 `reset`，收口规划器为 `runSessionPlanner`；③ 控制仓库配置与文档改名 `Jiaze-Li/pr-bot`（`pr-bot`）并删除 7 个无用历史/试验文件。
- **非目标**：不改 `@jiaze-claude-review-bot` 命令、Worker 服务名 `claude-review-bot`、状态检查名 `claude-review-bot/review`；不改预算/分片/验证轮数/接力上限与 READY 权威；不在 Code 阶段执行远端改名、部署、改本机目录名或付费复测。

## 2. 已核实事实（文件:行 + 摘录）
- **F1** `scripts/review-session-core.mjs:2-7,849-857,1073-1077`：`isBlocking(finding)` 定义为 `MATERIAL_SEVERITIES.has(finding?.severity) || (finding?.severity === 'P3' && !finding.downgradedFrom)`，但未导出；`normalizeFinding` 仅对 `MATERIAL_SEVERITIES`（P0–P2）在 `failurePath !== null && failurePath.length < 30` 时置 `downgradedFrom`。
- **F2** `scripts/review-threads.mjs:15,82`（`blockingClaims`）与 `scripts/sync-review-threads.mjs:15,31`（`stillOpen`）写死 `MATERIAL = new Set(['P0', 'P1', 'P2'])`，漏掉原发 P3。
- **F3** `scripts/run-gemini-review.mjs:52-53` 写有 `"so use P3 when you cannot name one.\nP3 is non-blocking and should be rare."`，与 P3 阻塞规则矛盾。
- **F4** `scripts/review-session-core.mjs:786-812`（`applyOverride`）未删 `reviewFailure`、`coverage`、`deepReview`、`staleFor`/`staleHead`/`staleCommits`，而 `renderSessionComment`（`:919,974`）先于 `READY` 渲染 `reviewFailure`；`applyVerificationResult`（`:302`）、`applyIncrementalResult`（`:226`）、`completeDeepReview`（`:521`）换提交时也留有旧临时字段。
- **F5** `scripts/review-session-core.mjs:396-438`（`seedSession`/`beginDeepReview`）：换提交启动全量审查时丢弃了 `FIXED`/`DISMISSED`/`WAIVED`/`DEFERRED` 与 `previous.dismissed`（默认还丢 `OPEN`），导致 `findOrphanBotThreads`（`review-threads.mjs:162`）将历史线程当孤儿；同 HEAD 下 `reset review`（`deep-review.mjs:62`）因 `lastReviewedHead === headSha` 未调 `seedSession` 清空旧问题。
- **F6** `scripts/review-session-core.mjs:496-497`（`completeDeepReview`）去重仅跳过 `OPEN` 与 `CARRIED_OPEN`，未覆盖其它 `UNCERTAIN` 与 `matchesKnownDismissal`。
- **F7** `scripts/plan-review-session.mjs:385-406` 在 CLI 尾部拼装四步；`tests/rebase-baseline.test.mjs:220-221` 断言源码中 `plan.decision = await resolveVerificationScope` 位于 `plan.decision.mode === 'incremental_candidate'` 之前。
- **F8** `worker/wrangler.toml:6` 与 `worker/src/index.js:145` 为 `Jiaze-Li/review-bot`；根目录 `Plan.md`、`Design.md` 及 `scripts/spike-gptwb-fixer*.mjs`、`scripts/patch-gptwb-idempotency.mjs`、`scripts/test-gptwb-idempotency.mjs`、`docs/fixer-spike-status.md` 共 7 个文件全仓 0 引用。

## 3. Options（路线比较）
- **U1/U2 账本跨提交保留**：
  - **A（采用：复用 `session.findings` 单账本，按优先级保留未决阻塞项与最近已结案项）**：`seedSession` 在 `reset: true` 时清空 `findings` 与 `dismissed`（仅留花费）；在 `reset: false` 时先保留 `unresolvedMaterialFindings`（`CARRIED_UNCERTAIN`）与 `carryOpen` 下的 `openMaterialFindings`（`CARRIED_OPEN`，规划器对所有非 `reset` 新 HEAD 全量审查自动开启 `carryOpen: true`，阻塞项 >8 条则转 `human_required`），随后保留最近 32 条已结案记录（`FIXED`/`DISMISSED`/`WAIVED`/`DEFERRED`）及 `previous.dismissed`（≤20 条）。追加新问题超 64 条时按 FIFO 仅淘汰最早已结案项，绝不淘汰 `OPEN`/`UNCERTAIN`。理由：零新字段、兼容 `v1` 与既有测试（`T7c` 直接调 `beginDeepReview` 默认 `carryOpen=false` 仍通过），且根除自造孤儿线程。
  - **B（拆新顶层字段 `historyFindings`）**：否决，破坏 `v1` 兼容与上下游读取。
  - **C（分片内直接核实旧 `OPEN`）**：否决，单分片看不到全仓上下文，无法可靠判 `FIXED`。
- **U3 孤儿对账与规划器收口**：
  - **A（采用：保留 `reconcileOrphanThreads` 作为旧会话保底，收进统一导出函数 `runSessionPlanner`）**：保持 `planSession`、`resolveVerificationScope`、`reconcileOrphanThreads` 导出供单测调用，新增 `runSessionPlanner` 按固定顺序串联四步并供 CLI 调用。
  - **B（删除孤儿对账代码）**：否决，违反 AC6 且破坏旧 PR 兜底与现有测试。
- **U4 提示词与无用文件清理**：
  - **A（采用）**：修改 `run-gemini-review.mjs:52-53` 要求 P0–P3 均提供具体 `failurePath`，并在 `normalizeFinding` 中对显式带过短 `failurePath`（`<30` 字符）的 P3 同样置 `downgradedFrom = 'P3'`（状态 `DEFERRED`）；阶段 3 直接 `git rm` 上述 7 个无引用文件。
  - **B（仅改提示词不改 `normalizeFinding` / 归档旧文件）**：否决，空 `failurePath` 的 P3 会绕过证据门槛阻塞 PR，归档目录冗余。

## 4. Assumptions
1. 现有单测夹具省略 `failurePath` 字段（`undefined`）时，沿用既有规则视为有效原发问题；仅显式给出 `<30` 字符 `failurePath` 字符串时降级为 `DEFERRED`。
2. 保留最近 32 条已结案问题与 20 条驳回记录足以覆盖线程对账与去重，且远低于 24 KB 状态上限。
3. GitHub 远端仓库改名、Worker 部署与本机目录改名在 PR 合并后由用户确认执行，不在 Code 阶段执行。

## 5. 设计细节与不变量（I1–I6）
- **阶段 1**：① `review-session-core.mjs` 导出 `isBlockingFinding`（即 `isBlocking`），`review-threads.mjs:82` 与 `sync-review-threads.mjs:31` 改用它；② `run-gemini-review.mjs:52-53` 改为 `"Every finding (P0-P3) must include failurePath... P3 is a concrete low-impact defect that still blocks until fixed; a finding without a concrete failurePath is automatically demoted to a non-blocking note."`，`normalizeFinding` 对 `['P0','P1','P2','P3']` 且 `failurePath !== null && failurePath.length < 30` 置 `downgradedFrom = severity; severity = 'P3'`；③ 新增 `stripTransientState` 在 `applyOverride`、`applyVerificationResult`、`applyIncrementalResult`、`applyFindingDismissal`（清零阻塞时）、`completeDeepReview` 中清除过期 `staleFor`/`staleHead`/`staleCommits`、`reviewFailure` 及非当前 HEAD 的 `coverage`/`deepReview`。
- **阶段 2**：① `beginDeepReview` 支持 `reset = false`，当 `reset || !session || session.lastReviewedHead !== headSha` 时调 `seedSession`；`deep-review.mjs` 传入 `reset: ctx.plan.requestedMode === 'reset'`；② `completeDeepReview` 去重覆盖所有 `OPEN`/`UNCERTAIN` 同 `path+title` 及 `matchesKnownDismissal`，超 64 条时先 FIFO 淘汰已结案项；③ `plan-review-session.mjs` 对非 `reset` 新 HEAD 全量审查在阻塞项 >8 时返回 `human_required`，有 `OPEN` 时置 `carryOpen: true`，并导出 `runSessionPlanner`。
- **阶段 3**：`git rm` 7 个遗留文件；`worker/wrangler.toml:6` 与 `worker/src/index.js:145` 改为 `Jiaze-Li/pr-bot`；`package.json`、`README.md`、`scripts/notification-policy.mjs` 与测试改为 `pr-bot`。
- **不变量**：**I1** `isBlockingFinding` 为唯一阻塞标准；**I2** 阻塞项仅经显式 `FIXED`、`dismiss` 或 `override` 关闭；**I3** 非 `reset` 跨提交保留未决阻塞项（≤8）与已结案项（≤32）及花费，显式 `reset` 清空问题留花费；**I4** 临时状态不跨提交/Override 泄漏；**I5** 三个外部标识不变；**I6** `v1` 兼容且 ≤64 条 / ≤24 KB。

## 6. 验证表（声明 → 失效方式 → 证据）
- **V1（AC1）**：原发 P3 点 Resolve 不触发验证或提前触发 → `tests/thread-decisions.test.mjs` & `tests/review-session-planner.test.mjs` 正反向测试。
- **V2（AC1）**：验证未过原发 P3 不重开线程 → `tests/sync-review-threads.test.mjs` 断言 `unresolveReviewThread` 与回复。
- **V3（AC2）**：提示词仍写 P3 不阻塞或短 `failurePath` P3 未降级 → `tests/gemini-review.test.mjs` & `tests/review-convergence.test.mjs` 断言。
- **V4（AC3）**：Override/换提交后残留 `reviewFailure`/`staleFor`/`coverage` → `tests/unavailable-review.test.mjs` & `tests/review-session.test.mjs` 断言。
- **V5（AC4/AC5）**：跨提交丢 `FIXED`/`OPEN` 或同 HEAD `reset` 未清空 → `tests/deep-review.test.mjs` & `tests/rebase-baseline.test.mjs` 断言。
- **V6（AC6）**：`runSessionPlanner` 回归 → `tests/review-session-planner.test.mjs`、`tests/rebase-baseline.test.mjs`、`tests/orphan-thread-reconcile.test.mjs` 全绿。
- **V7（AC7/AC8）**：`pr-bot` 配置漂移或 7 个文件未删 → `tests/review-trigger.test.mjs` 防漂移与文件不存在断言，全仓 `npm test` 与 `node --check` 全绿。

## 7. Work Contract（Code 阶段直接使用，自包含）
- **可观察结果与边界**：实现 §5 阶段 1–3 全部行为，保持 I1–I6 与 Plan AC1–AC8（AC9 为合并后外部关口）。已授权分支修改/删除 7 个遗留文件/commit/push/更新草稿 PR；未授权 merge、远端改名、部署、改本机目录名、付费复测。
- **有序阶段（`phases`）**：
  1. `phase-1-p3-and-transient-cleanup`：objective=完成 §5 阶段 1 与 V1–V4 测试；exitCriteria=P3 线程认领/重开/提示词/降级与临时状态清理测试全绿；carryForwardInvariants=`["I1","I2","I4","I5"]`；verificationCommands=`["npm test","node --check scripts/review-session-core.mjs","node --check scripts/review-threads.mjs","node --check scripts/sync-review-threads.mjs","node --check scripts/run-gemini-review.mjs"]`。
  2. `phase-2-persistent-ledger-and-planner`：objective=完成 §5 阶段 2 与 V5–V6 测试；exitCriteria=非 reset 跨提交保留已结案与未决阻塞项、同/跨 HEAD reset 清空问题留花费、`runSessionPlanner` 全绿；carryForwardInvariants=`["I1","I2","I3","I4","I5","I6"]`；verificationCommands=`["npm test","node --check scripts/review-session-core.mjs","node --check scripts/plan-review-session.mjs","node --check scripts/deep-review.mjs"]`。
  3. `phase-3-pr-bot-rename-and-cleanup`：objective=完成 §5 阶段 3（删除 7 个文件、更新 `pr-bot` 配置/文档/测试与 V7 测试）；exitCriteria=7 个文件已删除、`CONTROL_REPO` 为 `Jiaze-Li/pr-bot` 且全量测试与语法检查通过；carryForwardInvariants=`["I1-I6 hold","7 legacy files removed"]`；verificationCommands=`["npm test","node --check worker/src/index.js","node --check worker/src/review-trigger.js","node --check scripts/review-session-core.mjs","node --check scripts/plan-review-session.mjs"]`。
- **全局验证命令**：`npm test` 及 `.github/workflows/test.yml` 中全部 `node --check` 命令。
- **停止条件**：遇 `HUMAN_REQUIRED` 或需突破 I1–I6 立即停下回报；Code 本地 `PASS` 并 push 后停下等用户验收。
