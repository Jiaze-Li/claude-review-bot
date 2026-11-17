# Plan — RB-CONVERGENCE-01：PR 机器人顶层收敛、P3 规则对齐与改名 `pr-bot`

- **状态**：Plan v1.0（等待 Design 审查） · **仓库**：`Jiaze-Li/review-bot`（目标 `Jiaze-Li/pr-bot`），基线 `main` = `e8128cd99794bd8be8d558f5fa008b1cebc08135` · **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`

## 1. 要解决的真实问题与已核实源码摘录（已内联关键代码，无需额外读取大体积脚本）

1. **P3 阻塞规则前后不一致（现存卡死漏洞）**：
   - `scripts/review-session-core.mjs:2-7`：`const MATERIAL_SEVERITIES = new Set(['P0', 'P1', 'P2']); function isBlocking(finding) { return MATERIAL_SEVERITIES.has(finding?.severity) || (finding?.severity === 'P3' && !finding.downgradedFrom); }`（原发 P3 状态为 `OPEN` 且阻塞，缺少 30 字符 `failurePath` 的降级项带 `downgradedFrom` 为 `DEFERRED`；但 `isBlocking` 未导出，且 `:1074` 仅对 `MATERIAL_SEVERITIES` 判 `failurePath` 降级）。
   - `scripts/review-threads.mjs:15,82`（`blockingClaims`）与 `scripts/sync-review-threads.mjs:15,31`（`stillOpen`）仍各自写死 `const MATERIAL = new Set(['P0', 'P1', 'P2']);` 并用 `MATERIAL.has(finding.severity)` 过滤。导致仅剩原发 P3 时点 Resolve 不触发复查也不关闭（`apply-thread-resolutions.mjs:52` 只关 `DEFERRED`），复查未过也不重开 P3 线程。
   - `scripts/run-gemini-review.mjs:52-53` 提示词仍写 `"A P0/P1/P2 without a concrete failurePath is automatically demoted to non-blocking P3, so use P3 when you cannot name one.\nP3 is non-blocking and should be rare."`，与阻塞规则直接矛盾。
2. **跨状态/跨提交的旧临时状态残留**：
   - `scripts/review-session-core.mjs:786-812`（`applyOverride`）返回 `{ ...session, status: 'READY', ... }` 时未清除 `reviewFailure`、`coverage`、`deepReview`、`staleFor`/`staleHead`/`staleCommits`；而 `renderSessionComment`（`:919,974`）优先于 `READY` 判断 `session.reviewFailure`，导致 Override 后顶部显示 `READY`，底部却显示 `Review stopped` 和重试提示。`applyVerificationResult`（`:302`）、`applyIncrementalResult`（`:226`）、`completeDeepReview`（`:521`）换提交时也未统一清理旧提交的上述临时字段。
3. **跨提交清空问题账本自造“孤儿线程”，且规划器尾部碎片化**：
   - `scripts/review-session-core.mjs:396-438`（`seedSession` / `beginDeepReview`）：当 `!session || session.lastReviewedHead !== headSha` 时，只携带 `unresolvedMaterialFindings`（及 `carryOpen` 时的 `openMaterialFindings`），丢弃了所有已结案记录（`FIXED`/`DISMISSED`/`WAIVED`/`DEFERRED`）与 `previous.dismissed`，導致 `findOrphanBotThreads`（`review-threads.mjs:162`）把历史线程误判为孤儿；同时同 HEAD 下发 `reset review` 因 `lastReviewedHead === headSha` 根本未调 `seedSession` 清空旧问题。
   - `scripts/plan-review-session.mjs:385-406` 在 CLI 尾部串联 `planSession`、`resolveVerificationScope`、`prepareIncrementalDelta`、`reconcileOrphanThreads`，缺少统一导出入口。
4. **命名与无用历史文件清理**：
   - `worker/wrangler.toml:6`（`CONTROL_REPO = "Jiaze-Li/review-bot"`）、`worker/src/index.js:145`（`|| 'Jiaze-Li/review-bot'`）、`package.json:2`、`README.md:1`、`scripts/notification-policy.mjs:2` 及测试需改为 `Jiaze-Li/pr-bot` / `pr-bot`。
   - 根目录 `Plan.md`、`Design.md`（PR #87 遗留）及 4 个冻结无引用的试验脚本（`scripts/spike-gptwb-fixer.mjs`、`scripts/spike-gptwb-fixer-stage2.mjs`、`scripts/patch-gptwb-idempotency.mjs`、`scripts/test-gptwb-idempotency.mjs`）和 `docs/fixer-spike-status.md` 需清理删除。

## 2. 谁用与失败代价
- 仓库维护者及所有接入该 App 的 PR。失败会导致 P3 点 Resolve 卡死、Override 后提示矛盾、换提交丢失问题或已修好线程关不掉。坚持 fail-closed，绝不把未核实改动标为 `READY`。

## 3. 目标（同一任务内按 3 个有序阶段完成）
- **阶段 1（修 P3 与残留状态）**：导出唯一阻塞判定并在会话、线程认领、线程重开中统一使用；修正增量/验证 P3 提示词并对无有效 `failurePath` 的 P3 同样降级为 `DEFERRED`；在 Override 及换提交状态流转中清除旧 `reviewFailure`、`staleFor`/`staleHead`/`staleCommits`、过期 `coverage` 与 `deepReview`。
- **阶段 2（持久账本与规划收口）**：非 `reset` 跨提交启动全量审查时保留已结案记录、驳回账本、未决阻塞记录与累计花费，不再自造孤儿线程且不重复发帖；显式 `reset`（含同 HEAD）清空问题与驳回账本但保留累计花费；规划器收口为统一导出函数 `runSessionPlanner`。
- **阶段 3（改名 `pr-bot` 与清理无用文件）**：控制仓库配置、回退值、文档、包名与测试统一改为 `Jiaze-Li/pr-bot` / `pr-bot`；删除根目录旧 `Plan.md`、`Design.md` 及上述 5 个 `gptwb` 试验文件。

## 4. 非目标与硬性约束
- **三个外部标识绝不改动**：GitHub App 名与 `@jiaze-claude-review-bot`/`@gemini`/`@claude` 命令、Worker 服务名 `claude-review-bot` 与 URL、提交状态名 `claude-review-bot/review`。
- **不改上限与权威**：$6/$5 预算、模型、20 分片、2 轮验证、3 次接力、64 条问题与 24 KB 编码上限、READY 与问题关闭权威、`v1` 会话兼容性、并发写入边界均不变；不碰非机器人手写评论。
- **外部动作后置**：Code 阶段不改 GitHub 远端仓库名、不触发线上部署、不改本机目录名、不跑付费真实 PR 复测。

## 5. 可观察的验收条件（AC1–AC9）
- **AC1**：存在未解决原发 P3 时，必须所有阻塞问题（含原发 P3）线程被写权限者点 Resolve 且有新提交才触发验证；验证后仍未修好的原发 P3 自动重开线程并回复原因；降级 P3（`DEFERRED`）点 Resolve 仍直接记 `WAIVED`（零花费）。
- **AC2**：增量、验证与全量提示词一致要求 P0–P3 给出具体 `failurePath`，不再写“P3 不阻塞”；带过短 `failurePath` 的 P3 降级为 `DEFERRED`。
- **AC3**：对失败会话执行 `override review` 或换提交审查后，不再残留旧 `reviewFailure`、旧 `staleFor`、旧 `coverage` 或旧 `deepReview`。
- **AC4**：非 `reset` 跨提交启动全量审查保留历史已结案问题、驳回账本、未决阻塞问题与花费，不再自造孤儿线程，且不对已开启/待确认或已驳回的同路径+同标题问题重复入账。
- **AC5**：跨提交保留的未解决阻塞问题未经验证 `FIXED`（或人工 `dismiss`/`override`）持续阻挡 `READY`；显式 `reset review`（含同 HEAD）清空问题从零开始并保留花费。
- **AC6**：规划器 `runSessionPlanner` 统一串联规划步骤，普通修复、改写历史、增量、孤儿保底对账、自动接力零回归。
- **AC7**：`worker/wrangler.toml` 与 `worker/src/index.js` 一致为 `Jiaze-Li/pr-bot`（有防漂移测试），`package.json`、`README.md` 及测试更新为 `pr-bot`，7 个历史临时/试验文件已删除，三个外部标识不变。
- **AC8**：仓库与 `worker/` 自动化测试及 `node --check` 全部通过。
- **AC9（合并后外部关口，不在 Code 内）**：合并后经用户确认执行 GitHub 仓库改名、Worker 部署验证与本机目录改名。

## 6. 已确认决定、未知前提与授权
- **已确认决定**：D1 走 `Plan → Design → Code` 阶段停点；D2 分三阶段在同一任务完成；D3 已授权分支修改/commit/push/更新草稿 PR；D4 确认删除 7 个历史临时/试验文件。
- **Design 需明确事项**：U1 跨提交全量审查时旧 `OPEN` 与已结案问题的保留形式；U2 64 条上限下的 FIFO 裁剪规则；U3 孤儿对账在统一规划器中的保底位置；U4 7 个无用文件的删除验证。
- **未授权操作**：合并 PR、标记 Ready、GitHub 远端改名、线上部署、改本机目录名、触发付费复测。
