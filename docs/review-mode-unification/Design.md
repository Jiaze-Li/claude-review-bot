# PR Bot 审查范围与模型选择收敛 — Design v1.0

**任务**：RB-REVIEW-MODE-UNIFICATION-01 · 仓库 `Jiaze-Li/pr-bot` · Plan v1.0（含 2026-11-19 确认：保留 `@claude review`，预算上限不变）
**policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4` · **核查基线**：`main` = `cc026828df58f681e6d1b9eebdb7c88adff85edc`（#97 已合并）

## 1. 目标 / 范围 / 非目标

- 目标：让“审查范围”（完整/针对性）与“模型提供方”（默认 Gemini 优先 / 人工指定 Claude）成为两个互不混用的显式概念；去掉“Deep”作为用户可见概念；范围只在规划处决定一次。
- 范围：规划器输出、四个读取 `requestedMode==='claude'` 的执行入口、用户可见文案、工作流分支条件、README、测试。
- 非目标：不改 #97 合同、不改持久化的审查记录格式、不改预算数额和检查阈值、不改分片引擎/客户端、不新增审查阶段、不合并/部署。

## 2. 已核实事实（`main@cc02682`，文件:行 + 摘录）

F1 范围已由单一规划器决定：`scripts/review-session-core.mjs:80` `export function planReviewSession(...)` 返回 `full_review` / `incremental_candidate`(:126) / `verification`(:134) / `noop_*` / `human_required`；`scripts/plan-review-session.mjs:144-146` 调用它，`:377` 把 `incremental_candidate` 解析为 `incremental` 或 `fullReviewDecision(...)`。
F2 “完整审查”的最终路由名叫 `claude`，与提供方无关：`plan-review-session.mjs:251` `return {mode:'claude',previousHead:null, reason:\`...: ${requested==='claude'?'Claude only':'Gemini first, Claude continues if Gemini cannot'}\`}`；注释 `:144` “One route for every full review, whatever its size, provider or purpose”。`review-session-core.mjs:146`、`:185` 另有两处直接返回 `mode: 'claude'`（部分覆盖续审、失败重试）。
F3 `@claude review` 解析成 `requestedMode:'claude'`：`worker/src/review-trigger.js:13`、`:32`；`@gemini review`/裸命令为 `auto`（:10、:29）。范围规划对二者一致：`plan-review-session.mjs:140-141` 只用 `requested==='reset'` 与 `['auto','claude'].includes(requested)`（重试）；`:111` 对 `['claude','reset']` 的“同 HEAD 运行中则等待”。
F4 提供方选择在四处各自判断 `requestedMode==='claude'`：`deep-review.mjs:38` `const explicitClaude = ctx.plan.requestedMode === 'claude'`；`run-gemini-review.mjs:140` `const claudeOnly=plan.requestedMode==='claude'`；`run-review.mjs:183` `const claudeOnly = sessionPlan?.requestedMode === 'claude'`；`continue-review.mjs:18` `return requestedMode === 'claude' ? 'claude' : 'auto'`。
F5 预算：`review-session-core.mjs:368` `isManualBudgetExemptReview`：`(sourceKind==='comment' && ['auto','reset','claude'].includes(requestedMode)) || requestedMode==='threads'`；`deep-review.mjs:38-41` 显式 Claude 视为 manual，`DEEP_REVIEW_MANUAL_RUN_BUDGET_USD` 为单次上限，`CLAUDE_AUTO_MIN_BUDGET_USD` 为自动下限。数值本任务不动。
F6 升级规则已存在：`select-incremental-review.mjs:5-8` `MAX_INCREMENTAL_FILES = 3`、`MAX_INCREMENTAL_LINES = 50`、`MAX_INCREMENTAL_PATCH_BYTES = 150_000`、`MAX_INCREMENTAL_REVIEWS = 15`；`:12` `HIGH_RISK_PATH`（`.github/`、`migrations/`、`auth*/`、`security/`、`permissions/`、`database/`、`storage/`、`package*.json` 等）；`:15` `HIGH_RISK_CHANGE`（mutex/lock/transaction/race/concurren*/migration/schema/credential/permission/webhook/token…，含被删行）；`:17` 不安全扩展名与重命名/二进制走 `full`。历史被改写则 `classifyReviewBaseline`（`plan-review-session.mjs:~175`）返回 `rewritten` 并扩大到整个当前 PR。
F7 “Deep”的出现面：持久化字段 `session.deepReview`（`review-session-core.mjs`、`session-store.mjs:146`、`session-comment.mjs:23-24`）；内部决策名 `deep_review_stale`（`review-session-core.mjs:102`、`review-status.mjs:15`、`notification-policy.mjs:54,73`）；用户可见文案：提交状态 `deep-review.mjs:70` “Claude deep review in progress”、`sync-commit-status.mjs:35` “Claude deep review did not complete: human judgment required”、`review-status.mjs:160` “Stale deep review cleanup…”；README `:243`；工作流 `review-v2.yml` 约 22 处（步骤名与 `steps.plan.outputs.mode == 'claude'`，如 :308、:317、:348）；`sweep-stale-deep-reviews.yml`。
F8 失败重试只记录两种范围：`review-session-core.mjs:161-171` `reviewFailure.mode` 校验为 `verification|incremental`，不存 `claude`。`session-plan.json` 位于单次运行的 `.review-context`，只在同一次工作流内由规划步骤写、执行步骤读。
F10 #97 合并后的线上状态（2026-11-19 核查，GitHub Actions）：`main@cc02682` 的 “Deterministic trigger and status tests” 与 “Deploy webhook Worker” 均 success；但 `main@cc02682` 上两次真实触发的 “Independent review …#99”（01:22Z）与 “…#100”（01:28Z）均 **failure**；#97 自身的 `claude-review-bot/review` 检查为 PENDING，机器人最近记录为“HUMAN_REQUIRED on an earlier commit”。本地另有一个未合并的分支 `fix/deep-review-bot-author-20261119`（改 `review-v2.yml`），其内容与原因本设计**未核实**。结论：#97 的线上验收**未确认完成**。
F9 对外调用契约：`review.yml:5` 的 `inputs`（含 `requested_mode`）经 `uses: ./.github/workflows/review-v2.yml`（:33）传入；`review-v2.yml:36,74` 声明 `requested_mode`。

## 3. Options

- **A 全量改名**：把 `deepReview`、`deep_review_stale`、预算常量一并改名并迁移持久化记录。否决：触碰 #97 冻结的持久化格式，需要迁移与回滚方案，收益只是内部命名；与 Plan“不重新设计历史记录持久化”冲突。
- **B（选定）在规划输出上显式拆成 `scope` 与 `providerPolicy` 两个字段；完整审查的路由名由 `claude` 改为 `full`；四处提供方判断收敛到一个解析函数；用户可见文案去掉 “deep”；持久化字段与预算常量原样保留并标注为历史存储名。**
- **C 仅改文案**：不改代码路径，只替换字符串。否决：不满足“只允许一处权威范围决策”和“提供方解耦可被测试证明”，四处 `requestedMode==='claude'` 继续各自为政。

## 4. Assumptions（大白话）

1. `@gemini review` 仍是日常入口；`@claude review` 保留且只指定模型；二者在同一 PR 状态下范围一致。
2. 提交状态的“上下文名称”（分支保护依赖的键）与描述文案是两回事，改描述文案不影响必需检查——**此点 Code 阶段第一步用代码核实**（读 `postCommitStatus` 的 context 常量），不成立则不改该描述。
3. 现有升级阈值（F6）作为“高影响改动”的**固定定义**，本任务不调整数值；Plan 要求的“共享状态/事务/权限边界”由 F6 的路径与内容规则覆盖，Code 阶段补测试证明。
4. 运行中的工作流不会跨部署读取旧 `session-plan.json`（F8）；仍让读取方接受旧值 `mode:'claude'` 作为 `full` 的兼容别名以防万一。
5. 真实 GitHub PR 端到端会产生模型费用，不在 Design 授权内（见 §9）。
6. #97 合并后的线上审查运行目前有失败（F10），其根因不在本任务范围；本任务的代码与本地测试不依赖它，但真实 PR 端到端验收依赖它先恢复。

## 5. 设计

**5.1 规划输出**：`planSession` 的 `decision` 增加两个字段，其余字段不变：
- `scope`：`'full'`（`full_review` 终态路由与 F2 的三处 `claude`）、`'targeted'`（`verification`、`incremental`）、`null`（`noop_*`/`human_required`/`recover` 等不审查的决定）。
- 路由名：F2 三处返回值由 `mode:'claude'` 改为 `mode:'full'`；读取方额外接受 `'claude'`（别名）。
- `plan.providerPolicy`：`requestedMode==='claude'` → `'claude_only'`，否则 `'default'`（Gemini 优先、Claude 后备）；由规划器写入一次。

**5.2 提供方解耦**：新增 `providerPolicyOf(plan)`（放在 `review-session-core.mjs`，与 `isManualBudgetExemptReview` 同处）。F4 四处改为调用它；`isManualBudgetExemptReview` 的判定与数值不变。`continue-review` 的续审仍沿用 `requested_mode` 输入（F9），行为不变。范围规划函数不得读取 `providerPolicy`。

**5.3 范围权威**：执行/发布/状态模块只读 `decision.scope` 与 `decision.mode`，不得再由 `requestedMode` 重推阶段。`@claude review` 与 `@gemini review` 唯一差别 = `providerPolicy`。F3 的 `plan-review-session.mjs:111`（同 HEAD 运行中则等待）**保持不变**：`auto` 在同样状态下已由 `review-session-core.mjs:98-104` 返回 `noop_waiting`（`REVIEW_IN_PROGRESS` 且同 HEAD），因此 `auto` 与 `claude` 的等待结果相同，`:111` 只是为 `reset` 与 `claude` 在规划前提前返回；本任务不改它，也不改变同 HEAD 去重行为（Plan AC 8），仅用测试证明二者一致。

**5.4 用户可见语言**：提交状态与报告文案改为“Full review in progress / did not complete”“Stale review cleanup…”（Assumption 2 成立时）；报告详情可写“分片/所用模型/覆盖”，并明确不是额外阶段；README 与 `review-v2.yml` 步骤名同步。`sweep-stale-deep-reviews.yml` 文件名不改（避免触发器与引用失效），仅改显示名。

**5.5 兼容**：不改 `session.deepReview`、`SESSION_VERSION`、`DEEP_REVIEW_*` 常量、`review.yml`/`review-v2.yml` 的 `inputs`；这些在代码注释中标为“历史存储名，非产品概念”。

## 6. 不变量

I1 同一 `(session, baseSha, headSha, 触发类型)`，`auto` 与 `claude` 的 `decision.scope` 与 `decision.mode` 逐一相同（含同 HEAD 运行中的 `noop_waiting`，无例外）。
I2 READY 判定、覆盖、终审、dismiss 与 #97 行为不变；指定 Claude 不降低任何检查。
I3 预算数值与 manual/自动规则（F5）逐字不变。
I4 仅 `providerPolicyOf` 读取 `requestedMode==='claude'`（除 F3 触发解析与 F9 输入透传）。
I5 持久化记录读写与旧记录解析零变化；不可解析仍 fail-closed（沿用 #97）。
I6 所有用户可见文案不含 “deep review”；日常无需选择范围。

## 7. 失败方式 → 检出证据

| 声明 | 可能失效 | 检出 |
|---|---|---|
| I1 范围一致 | 某分支仍按提供方分叉 | 新增矩阵测试：各 session 状态（无会话、同 HEAD 的 REVIEW_IN_PROGRESS、AUDIT_PENDING、READY 同/新 HEAD、REWORK、PARTIAL、HUMAN_REQUIRED+不可用重试、重写历史）× {auto, claude}，断言 scope/mode 相同、仅 providerPolicy 不同 |
| I3 预算不变 | 重构误改阈值 | 快照测试断言 `DEEP_REVIEW_*`、`CLAUDE_AUTO_MIN_BUDGET_USD` 及 `isManualBudgetExemptReview` 真值表与基线相同 |
| I4 单点 | 新增遗漏分支 | 静态测试：扫描 `scripts/`、`worker/`，除白名单文件外不得出现 `requestedMode === 'claude'`/`==='claude'` 提供方判断 |
| 兼容 | 旧值 `claude` 被拒 | 测试：读取方接受旧 `mode:'claude'` 的 `session-plan.json` |
| I6 文案 | 漏改 | 测试：渲染状态/报告/commit status 字符串不含 “deep review”（大小写不敏感）|
| 升级 | 大/高风险改动走窄增量 | 复用并扩充 `incremental-review.test.mjs`：改动落在 F6 路径/关键词、超 3 文件或 50 行、被改写历史时必须 `full` |
| 部分/恢复/重复 | 重命名破坏恢复 | 复跑现有 `deep-review.test.mjs`、`recover-review-session.test.mjs`、`review-orchestrator.test.mjs`、`production-runner-provider.test.mjs`；同 HEAD 重触发不重跑 |
| 工作流 | 分支条件漏改，完整审查不执行 | `workflow-*` 静态测试（读取 `review-v2.yml`，断言存在 `steps.plan.outputs.mode == 'full'` 且无遗留 `== 'claude'`）|

## 8. 实现顺序

1. 核实 Assumption 2；加矩阵测试、预算快照测试（先在现有代码上应当通过，证明基线）。
2. 规划器加 `scope`/`providerPolicy`，路由名改 `full`（读取方兼容 `claude`），`providerPolicyOf` 并收敛四处。
3. 用户可见文案、`review-v2.yml` 条件与步骤名、README；补文案/工作流静态测试。
4. 跑全量 `npm test`；真实 PR 端到端仅在获授权后执行，未执行则如实标“未执行”。

## 9. 人工关口与授权草案（均未授权，需用户另行确认）

- 修改代码/测试/工作流/README：Code 阶段开始时由用户说“Code”授权。
- commit/push 到本 PR 分支：需明确授权。
- 付费真实 GitHub PR 端到端（Gemini 与 Claude 各至少一次，沿用现有预算上限）：需明确授权，且以 #97 线上审查运行恢复正常为前提（F10）；无则标“未执行”，不得宣称 PASS。
- merge、部署、权限/密钥变更、改动历史数据：不在本任务内。

## Work Contract（Code 阶段直接使用）

**可观察结果**
1. 规划决定带 `scope`（full/targeted/null）；完整审查路由名为 `full`；`@gemini review` 与 `@claude review` 在同一状态下 scope/mode 一致，仅 `providerPolicy` 不同。
2. 提供方判断只在 `providerPolicyOf`；其余模块不读 `requestedMode==='claude'` 决定范围或阶段。
3. 用户可见文案、提交状态、README、工作流显示名不再出现 “deep review”；真实执行细节（分片/模型/覆盖）可保留且不暗示额外阶段。

**必需不变量与边界**：I1–I6；不改 `session.deepReview`、`SESSION_VERSION`、`DEEP_REVIEW_*`、`requested_mode` 输入、`review.yml` 契约；不改升级阈值数值；不改 #97 合同、READY 门槛、分片引擎、客户端、预算；不改 merge/部署/权限；不夹带无关文件（提交前 `git status --short` 逐项核对）。

**全局 AC**：①矩阵测试（I1）通过；②预算快照测试通过；③单点静态测试通过（`plan-review-session.mjs:111` 未改动，矩阵含同 HEAD 运行中状态）；④旧 `mode:'claude'` 计划文件兼容测试通过；⑤文案与工作流静态测试通过；⑥升级/增量、部分覆盖、恢复、同 HEAD 去重相关既有测试全部通过；⑦`npm test` 全绿；⑧Assumption 2 已用代码核实并记录结果；⑨开始 Code 前重新核查 #97 合并后线上审查运行状态并记录（F10 的失败是否已解决）。

**验证与证据**：本地命令输出（`npm test` 摘要、新增测试名与结果）作为本地证据；CI 结果作为 CI 证据；真实 GitHub PR 运行证据只有在用户授权并实际执行后才可写入，否则交付说明必须写“未执行”。

**阶段**：P1（步骤 1–2：规划字段、提供方收敛、矩阵/快照/单点/兼容测试）；P2（步骤 3–4：文案、工作流、README、静态测试、全量测试）。P2 须保留 P1 全部不变量。

**停止条件**：Assumption 2 不成立且无法在不改必需检查的情况下改文案 → 保留该描述并上报；发现 #97 合同与本设计冲突、需要改持久化格式或预算 → 停止并回到用户；#97 线上审查运行仍失败 → 本地部分可继续，真实 PR 端到端标“未执行/受阻”并上报；ReviewLoop 返回 `HUMAN_REQUIRED` → 停止。
