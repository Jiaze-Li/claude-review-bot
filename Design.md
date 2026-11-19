# Design: 全局统一两家模型执行路径与只读工具能力

- **policy_sha**: `305d9c0827c7bdce9a7604c516d1f617e0cd43b0`
- **Plan 基线**: PR #104 (`Plan.md` @ `bc942e9`)
- **核查仓库基线**: `bc942e92d8aeed7da78295351b971097a583ebc3`
- **目标**: 让全量、增量、修复复核、驳回/接受风险核验、发现校验等所有模型审查与核验流程，无论主用哪家模型或触发降级，都经由统一调度与适配器路径执行，并挂载同一套 `ReadOnlyToolGateway` 只读工具；同时在修复复核及核验提示词中明确要求：遇到复用既有函数时主动读取原函数实现后再下结论。
- **范围**: `scripts/provider-adapter.mjs`、`scripts/review-orchestrator.mjs`、`scripts/claude-fallback.mjs`、`scripts/run-gemini-review.mjs`、`scripts/dismiss-verifier.mjs`、`scripts/validate-gemini-findings.mjs`、`scripts/review-prompts.mjs` 及对应测试。
- **非目标**: 不改变各阶段业务判定标准、严重级别规则与合入拦截逻辑；不放开任何写操作、命令执行或越界访问；不重构评论发布、账本记账、权限校验或 GitHub Workflow 编排。

---

## Options（路线比较与取舍）

1. **Option A（采用）：全流程收敛至 `executeWorkUnit` + `ProviderAdapter` + `ReadOnlyToolGateway`**
   - 将 `run-gemini-review.mjs` 中的 `claude` 执行器与 `gemini`/其他 provider 执行器统一为同一套适配器调用逻辑，全部传入同一规则构造的 `ReadOnlyToolGateway`（当 `safeRoot` 可用时）及统一的 `maxTurns` / `timeoutMs` / `maxBudgetUsd`。
   - 将 `dismiss-verifier.mjs` 与 `validate-gemini-findings.mjs` 中手写的 Gemini `fetchImpl` 与 `runClaudeStructured` 双套调用，替换为复用 `executeWorkUnit` + `getProviderAdapter` + `ReadOnlyToolGateway`（基于已有的 `repoRoot`/`safeRoot`）。
   - 在 `claude-fallback.mjs` 中移除“禁用工具的降级专路”语义，仅保留状态判断与错误/常量导出（如 `isGeminiUnavailableStatus`、`GeminiUnavailableError`、`FALLBACK_UNKNOWN_COST_USD`），或让 `runClaudeStructured` 不再作为无工具分叉存在。
   - **优点**：消除全部平行执行通道；任何已注册模型在任意流程中均获得完全一致的工具边界、轮次、预算、熔断与遥测行为。
2. **Option B（否决）：仅在 `claude-fallback.mjs` 的 `runClaudeStructured` 内补挂 `toolGateway`**
   - **否决理由**：`dismiss-verifier.mjs` 与 `validate-gemini-findings.mjs` 的 Gemini 主路径仍在手写 `fetchImpl`（单轮无工具），且主路径与备用路径仍各自处理重试、超时、错误分类与成本结算，违反 Plan 硬性约束 #1（不允许因模型不同产生不同工具能力与分支逻辑）和 #3（不保留平行通道）。
3. **Option C（否决）：新建独立的统一核验执行器（如 `unified-verifier.mjs`）**
   - **否决理由**：在 `review-orchestrator.mjs`（`executeWorkUnit`）与 `provider-adapter.mjs`（`getProviderAdapter`）之外再造调度器属于新建平行执行通道，违反 Plan 硬性约束 #3。

---

## Assumptions（默认前提）

1. **安全副本可用性**：在生产 CI 工作流中，`materialize-safe-tree.mjs` 会在审查与核验前准备好只读安全代码副本（`safe-target` 或 `SAFE_REPO_DIR` / `repoRoot`）。在未提供安全副本的单元测试场景下，`toolGateway` 为 `null`（两家模型对等无工具），不阻塞纯逻辑单测；只要安全副本存在，两家模型都必须获得相同的 `ReadOnlyToolGateway`。
2. **轮次与预算上限取舍（回应 Plan 未知前提）**：
   - 原 `claude-fallback.mjs` 固定 `maxTurns = 3` 过低，不足以在单次核验中完成“Glob/Grep 定位 + Read 原函数 + 输出结构化结果”；原 `GeminiProviderAdapter._executeMultiTurn` 默认 `maxTurns = 10`。
   - 设计取舍：对**增量审查与修复复核**统一使用 `maxTurns = 8`（可通过环境/选项覆盖），对**单点核验（驳回核验、发现校验）**统一使用 `maxTurns = 6`；单次预算上限仍沿用现有 `claudeFallbackCallBudget` / `BudgetManager` 算出的可用额度，不做额外放大。这样既留出读取 1-3 个复用函数的工具轮次，又防止单点核验无限探索。
3. **覆盖的模型范围**：当前指 `defaultProviderRegistry` 中已注册的模型实现（`gemini` 与 `claude`，以及按同接口注册的其他扩展 provider）。

---

## 已核实事实（Verified Facts）

- `scripts/run-review.mjs:238-386`：全量分片审查已使用 `executeWorkUnit`、`getProviderAdapter` 与 `ReadOnlyToolGateway`（含 `safeRoot`、`contextRoot`、`allowedContextFiles`），两家模型均通过 `adapter.execute({ ..., toolGateway })` 运行。
- `scripts/provider-adapter.mjs:437-442`：`GeminiProviderAdapter.execute(request)` 在 `if (request?.toolGateway)` 时走 `_executeMultiTurn(request)`（`scripts/provider-adapter.mjs:711` 默认 `maxTurns = 10`），否则走 `_executeSingleTurn(request)`。
- `scripts/provider-adapter.mjs:1168-1258`：`ClaudeProviderAdapter.execute` 默认 `maxTurns = 3`（第 1173 行）；当传入 `toolGateway` 时（第 1233-1258 行），自动将原生 `resolvedTools = []`、挂载 `toolGateway.createMcpServer('gateway')` 并通过 `createHostToolAuthorizer` 放行 `Read/Glob/Grep`。
- `scripts/claude-fallback.mjs:11,53-60`：`runClaudeStructured` 硬编码 `CLAUDE_FALLBACK_MAX_TURNS = 3`、`tools: []` 与 `canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available in fallback review.' })`。
- `scripts/run-gemini-review.mjs:247-390`：增量审查与修复复核通过 `executeWorkUnit` 调度，但 `claude` 执行器（第 314-359 行）调用 `runClaudeStructured`（无工具、3 轮），而 `gemini`（第 256-313 行）与其他 provider（第 360-390 行）均构建 `ReadOnlyToolGateway` 并调用 `adapter.execute`。
- `scripts/run-gemini-review.mjs:88-98`：`buildGeminiRequest` 的 `verification` 模式提示词仅要求核对 `OPEN FINDINGS` 与 `REPAIR DIFF`，未要求模型在看到复用既有函数时使用只读工具读取原函数实现，也未统一告知可用工具规则。
- `scripts/dismiss-verifier.mjs:240-347`：`runVerifierChain` 直接调用 `fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/...')`（无工具），在不可用时调用 `runClaudeStructured`（无工具），绕过 `ProviderAdapter` 与 `executeWorkUnit`；而 `verifyDismissalWithModel`（第 52、62 行）已持有 `repoRoot`。
- `scripts/validate-gemini-findings.mjs:146-234`：主函数直接循环调用 `fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/...')`（无工具），在不可用时调用 `runClaudeStructured`（无工具），绕过 `ProviderAdapter` 与 `executeWorkUnit`；而该模块已接收 `repoRoot` 与 `contextRoot`。
- `.github/workflows/review-v2.yml:325,443,473,528`：工作流在运行 `run-gemini-review.mjs`、`validate-gemini-findings.mjs` 和 `apply-dismissal.mjs` 前已先执行 `node scripts/materialize-safe-tree.mjs`。
- `tests/review-trigger.test.mjs:407-418`：当前基线运行 `npm test` 共 742 项通过 741 项，仅此 1 项因分支根目录尚有 `Plan.md` 而失败（预期在合入前按仓库规范清理或归档 `Plan.md`/`Design.md` 后恢复）。

---

## 详细设计与不变量

### 1. 统一执行与工具装配
- 在 `scripts/review-orchestrator.mjs` 或共用执行辅助函数中提供统一的适配器执行构造逻辑，供 `run-gemini-review.mjs`、`dismiss-verifier.mjs`、`validate-gemini-findings.mjs` 复用（与 `run-review.mjs` 对齐）：
  - 若 `safeRoot`（或 `repoRoot`）存在，一律构造同一配置的 `ReadOnlyToolGateway({ safeRoot, contextRoot, cwd, allowedContextFiles, maxCalls: maxTurns * 4 })`，不得因 `provider === 'claude'` 或处于降级分支而跳过或禁用工具。
  - `run-gemini-review.mjs` 的 `claude` 执行器改为直接使用 `getProviderAdapter(PROVIDER_KINDS.CLAUDE, ...)`（与 `gemini` 及扩展 provider 一致），统一传入 `toolGateway`、`maxTurns`、`maxBudgetUsd`、`timeoutMs`、`isolateEnv: true`、`requireAuthToken: true`、`fallbackUnknownCostUsd: FALLBACK_UNKNOWN_COST_USD`、`allowZeroCost: false`。
  - `dismiss-verifier.mjs` 与 `validate-gemini-findings.mjs` 改用 `executeWorkUnit` + `getProviderAdapter`（默认 `providers = ['gemini', 'claude']`，或尊重 `REVIEW_PROVIDERS`），并传入基于各自 `repoRoot`（以及 `validate-gemini-findings.mjs` 的 `contextRoot`）构造的 `ReadOnlyToolGateway`。
  - 保留原有的熔断（`CircuitBreaker`）、预算预留与结算（`BudgetManager` / `claudeFallbackCallBudget` / `FALLBACK_UNKNOWN_COST_USD`）、降级停止记录（`fallback-unavailable.json`）及输出结构归一化不变。

### 2. 复核与核验提示词增强
- 在 `scripts/review-prompts.mjs` 提取共用的只读工具查证指引（或直接在 `buildGeminiRequest` 的 `verification`/`incremental` 及 `dismiss-verifier.mjs`、`validate-gemini-findings.mjs` 中引用），当 `hasTools === true` 时明确告知模型：
  - 可用 `Read`、`Glob`、`Grep` 只读工具检查安全仓库快照。
  - **修复复核硬性要求**：当修复代码调用或复用了未完整出现在当前 diff 中的既有函数/辅助方法/常量时，**必须先使用 `Read`/`Grep` 读取该被复用函数的实际实现与边界检查**，再判定 `FIXED`、`STILL_OPEN` 或 `UNCERTAIN`；不得仅因“diff 中未展开被调用函数内部”而直接判为 `UNCERTAIN`。

### 3. 核心不变量（Invariants）
- **I1（工具对等）**：在同一流程与同一 `safeRoot` 条件下，任意注册模型（`gemini`、`claude` 及扩展 provider）获得的 `ReadOnlyToolGateway` 权限、允许文件集合与禁用原生工具边界完全一致。
- **I2（路径统一）**：增量审查、修复复核、驳回/接受风险核验、发现校验均通过 `executeWorkUnit` + `ProviderAdapter` 执行，不再存在绕过 `ProviderAdapter` 的直连 `fetch` 或禁用工具的 `runClaudeStructured` 平行通道。
- **I3（安全只读不变）**：所有模型仅通过 `ReadOnlyToolGateway` 访问 `safeRoot` 与白名单 `contextRoot` 文件，不开启原生写工具、Shell 执行或越界读取。
- **I4（预算与失败闭环不变）**：降级触发条件（`isGeminiUnavailableStatus`）、未知成本兜底（`FALLBACK_UNKNOWN_COST_USD`）、预算不足 fail-closed 与 `INCONCLUSIVE` / `HUMAN_REQUIRED` 策略保持原样。

---

## 失效模式与验证映射

| 声明 | 可能的失效方式 | 可检出证据（测试） |
|---|---|---|
| 增量/复核时 Claude 降级不再禁用工具 | `claude` 执行器仍走旧 `runClaudeStructured` 或未传 `toolGateway` | 单测 mock `queryImpl` 验证 HTTP 402 降级到 Claude 时传入了 `mcpServers.gateway` 且 `allowedTools` 含 `Read/Glob/Grep`、`maxTurns = 8` |
| 单点核验（驳回/发现校验）双模型均可用工具 | `dismiss-verifier.mjs` 或 `validate-gemini-findings.mjs` 仍直连 API 或降级时 `tools: []` | 单测验证 Gemini 主路径（多轮 tool_use -> JSON）与 Claude 降级路径（`mcpServers.gateway`）均能通过工具读取 `repoRoot` 中未出现在上下文里的既有函数并给出 `DISMISSED`/`CONFIRMED` |
| 修复复核遇到复用既有函数能主动查证 | `verification` 提示词未包含查证指引，或模型轮次不足以读函数后输出 | 单测检查 `hasTools: true` 时 `verification` 提示词含查证指令；集成单测模拟修复 diff 调用未改动 helper，验证复核流程先触发 `Read` 工具再返回 `FIXED` |
| 安全边界与现有契约不回退 | 放开原生工具或破坏预算/失败闭环 | `npm test` 全部既有测试（含 `mcp-tool-gateway.test.mjs`、预算/失败闭环测试及更新后的降级工具测试）通过 |

---

## 授权与人工关口
- **当前已授权**：仅完成 Design 与 ReviewLoop 设计审查；**未授权**修改业务代码、提交、推送或合并。
- **进入 Code 前需用户确认的授权**：修改业务代码与测试、提交并推送到 `plan/unify-model-paths-20261119`（合并永远由用户单独决定）。

---

## Work Contract（Code 阶段直接执行）

### 可观察结果
1. 全量、增量、修复复核、驳回/接受风险核验、发现校验五个流程全部通过 `executeWorkUnit` + `ProviderAdapter` 运行，并在 `safeRoot`/`repoRoot` 存在时挂载同一 `ReadOnlyToolGateway`。
2. 消除 `runClaudeStructured` 禁用工具的平行执行分叉；增量/复核统一 `maxTurns = 8`，单点核验（驳回核验、发现校验）统一 `maxTurns = 6`。
3. `verification` 与核验提示词在挂载工具时明确要求：遇到复用未改动既有函数时先用只读工具读取原函数实现再下结论。

### 必需不变量与边界
- 遵守上述不变量 I1-I4；不修改业务判定门槛、严重级别定义、账本记账结构或评论发布格式。
- 不放开任何写权限、命令执行权限或 `safeRoot` 之外的文件访问。

### 全局验收标准（AC）
- [ ] `run-gemini-review.mjs`、`dismiss-verifier.mjs`、`validate-gemini-findings.mjs` 均已收敛到 `executeWorkUnit` + `ProviderAdapter` + `ReadOnlyToolGateway`，无绕过适配器的直连 `fetch` 或禁用工具分支。
- [ ] `run-gemini-review.mjs`（`verification` 模式）及核验提示词在 `hasTools` 为真时包含读取复用既有函数的明确指令。
- [ ] 补齐并更新单元测试：覆盖跨模型（Gemini 主路与 Claude 降级/`@claude review`）在增量、修复复核、驳回核验、发现校验中工具挂载一致、主动读取既有函数及原有预算/失败闭环。
- [ ] 运行 `npm test`，除根目录临时 `Plan.md`/`Design.md` 检查项外（或按流程移至 `docs/` 后）全量测试通过，并保留完整测试输出作为证据。

### 停止条件
- 遇到需要更改阶段判定标准、放宽预算上限、修改 GitHub Workflow 权限或超出本合同范围的需求时，立即停止并向用户报告。
- 本地 ReviewLoop Code `PASS` 后停止，按授权范围决定是否提交/推送。
