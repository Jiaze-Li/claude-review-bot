# Design — ENG-REVIEW-BOT-RENAME-20261117：把 `Jiaze-Li/claude-review-bot` 安全改名为 `Jiaze-Li/review-bot`

- **Plan**：`v1.0`（冻结，本分支 `Plan.md` @ `613399c`）· **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查基线**：Bot `main` = `bde9656f447d500764579dabaa2869774157ff72`；任务分支 `613399c` = main + Plan.md；GitHub 仓库 ID `1350391701`。
- **阶段**：Design。本文件不改任何运行环境；Code 阶段只用文末 Work Contract。

## 1. 目标 / 范围 / 非目标

**目标**：同一个仓库（同一 ID）改名后，已部署的审查服务无缝继续工作，并用一次真实 PR 审查证明。
**范围**：GitHub 仓库改名；Worker 的控制仓库配置与回退值；仍在使用的文档/链接；ReviewLoop 的活跃文档链接；端到端验证；回滚说明。
**非目标**（沿用 Plan §4）：不改 App 名与 `@jiaze-claude-review-bot` 命令、Worker 服务名与 Webhook 地址、密钥与权限、评审行为/预算/模型、历史评论；不做 `dismiss` 与 `taskType: pr`。

## 2. 已核实事实（文件:行 + 摘录；Reviewer 无法读仓库，以此为准）

F1. Worker 配置写着旧名：`worker/wrangler.toml:1` `name = "claude-review-bot"`；`:6` `CONTROL_REPO = "Jiaze-Li/claude-review-bot"`；`:7-8` `CONTROL_WORKFLOW = "review-v2.yml"`、`CONTROL_REF = "main"`。
F2. 运行时只有一处使用控制仓库：`worker/src/index.js:145` `const controlRepo = env.CONTROL_REPO || 'Jiaze-Li/claude-review-bot';`，随后用于 `GET /repos/${controlRepo}/installation`（:149）和 `POST /repos/${controlRepo}/actions/workflows/.../dispatches`（:158）。其余旧名只是标签：`:16` `service: 'claude-review-bot webhook'`、`:281` `'User-Agent': 'claude-review-bot'`。
F3. 合并到 main 会自动部署 Worker：`.github/workflows/deploy-worker.yml:8` `branches: [main]`、`:10` `- 'worker/**'`、`:53` `run: npx wrangler deploy`。Worker 服务名取自 `wrangler.toml` 的 `name`。
F4. 工作流本身不写死仓库名：`review-v2.yml:592` `GITHUB_REPOSITORY: ${{ github.repository }}`；检出用默认（`:107-110` `Checkout trusted control repository … uses: actions/checkout@v6`）。工作流内没有 `uses: Jiaze-Li/claude-review-bot`。
F5. 提交状态名带旧名且被目标仓库使用：`scripts/sync-commit-status.mjs:9` `export const STATUS_CONTEXT = 'claude-review-bot/review';`；`review-v2.yml:350,638` 通过 `vars.REQUIRE_STATUS_CHECK` 控制是否必需。改它会让依赖该状态名的目标仓库的必选检查永远等不到结果。
F6. 机器人命令正则写死 App 名：`worker/src/review-trigger.js:9-23` `/^ {0,3}@jiaze-claude-review-bot[ \t]+review…/i`；测试大量使用 `jiaze-claude-review-bot[bot]` 作为作者。App 名不变，故这些都不动。
F7. 其余旧名：`package.json:2` `"name": "claude-review-bot"`、`worker/package.json:2` `"name": "claude-review-bot-worker"`、`README.md:1` 标题、`scripts/notification-policy.mjs:2` 注释；测试里 `tests/review-status.test.mjs:11` `GITHUB_REPOSITORY: 'Jiaze-Li/claude-review-bot'`、`tests/review-trigger.test.mjs:162` `/repos/Jiaze-Li/claude-review-bot/installation`。
F8. ReviewLoop（`~/Downloads/scripts/ReviewLoop/reviewloop`，另一个仓库）：活跃链接 `README.md:7,167`、`docs/ARCHITECTURE.md:3`、`docs/CERTIFICATION.md:6`、`docs/ROADMAP.md:4` 指向 `github.com/Jiaze-Li/claude-review-bot`；`agent-policy/COMMON.md:52` 写 `claude-review-bot owns PR review.`；`src/mcp/reviewloopMcpServer.js:99`、`src/reviewloop/*.js` 的报错文字含 `claude-review-bot`。`COMMON.md` 同时是被拷进 `~/.claude/CLAUDE.md` 的 Worker 合同（受管块）。
F9. 现场只读核查（2026-11-17）：当前 GitHub 账号对该仓库有 `admin: true`；`Jiaze-Li/review-bot` 返回 404（名称当前可用）；`main` 无分支保护（404）；仓库 Actions 变量只有 `APP_ID`、`REQUIRE_STATUS_CHECK`；仓库 webhook 列表为空；对 `Jiaze-Li` 下其他仓库做 `gh search code "claude-review-bot"` 无命中（搜索索引可能不全，见假设）；本机其他仓库（SpinLab、DocFlow 等）无引用。
F10. 本机该仓库 `origin` 为 `https://github.com/Jiaze-Li/claude-review-bot.git`。

## 3. Options

**A（采用）—— 先改名，再合并配置 PR。** 顺序：①核对前置 → ②用 GitHub 改名（保留仓库 ID）→ ③旧名重定向期间 Worker 仍可用 → ④合并“新名配置 PR”，F3 自动把 Worker 以新 `CONTROL_REPO` 重新部署 → ⑤端到端真实审查。最简单：只改 1 处运行时配置 + 1 处回退值，复用既有部署流水线。改名到合并之间 Worker 靠 GitHub 对旧名的重定向工作；该窗口短，且失败方式是“触发失败/被拒绝”而非误报 READY（Plan §2 的 fail-closed）。
**B —— 先合并配置 PR、再改名。** 否决：合并会立刻部署指向尚不存在的 `Jiaze-Li/review-bot`，Worker 在改名前就会报 `GitHub App is not installed on control repository`，主动造成服务中断。
**C —— 只改名，不改 Worker 配置，永远靠重定向。** 否决：违反 Plan §5.2“配置与回退一致”，且重定向在有人新建同名旧仓库时会失效，属脆弱依赖。
**D —— 新建 `review-bot` 仓库并迁移。** 否决：Plan §3 明令禁止。
**E —— 连同 Worker/App/状态名/提交状态一起改名。** 否决：Plan §3/§4 明令保持，且 F5/F6 显示会破坏目标仓库的必选检查与命令。

## 4. Assumptions（Plan 没写，我默认的前提，请划掉不成立的）

1. 只有 `Jiaze-Li` 这个账号下的仓库和本机项目可能引用旧名；没有他人的外部仓库在用 `uses: Jiaze-Li/claude-review-bot/...`（F9 的代码搜索未覆盖私有/未索引仓库，Code 阶段会再查一遍并报告未覆盖范围）。
2. 本机登录的 GitHub 账号有改名权限（F9 显示 admin）；若改名接口被拒，由你在网页上点一次改名，我不绕过。
3. 改名到新配置部署之间有几分钟服务不稳定可以接受；在这段时间内不会有你关心的 PR 需要审查。
4. Cloudflare 部署凭据（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）已在仓库密钥里；不会、也不需要读取或修改它们。
5. 目标仓库里若有必选检查，其名字是 `claude-review-bot/review`（F5），所以保持不变。
6. `/` 健康检查返回的服务名字符串（F2 `:16`）和 `User-Agent`（`:281`）没有外部监控依赖；按“不改 Worker 身份”保持不变。

## 5. 设计

**权威与不变量**
- I1 仓库身份唯一权威是 GitHub 仓库 ID `1350391701`；改名前后必须相同。
- I2 App 名、命令、Worker 服务名与 Webhook 地址、`STATUS_CONTEXT`、密钥权限、评审逻辑全程不变（F5、F6）。
- I3 任何时候都不得新建名为 `claude-review-bot` 或已有同名占位的仓库（会破坏重定向）。
- I4 不得用 override/豁免/伪造状态证明成功；验收只认 bot 发布的 Independent Review Session 与其绑定的 PR HEAD。
- I5 运行时配置与回退值必须相同：`wrangler.toml:6` 与 `index.js:145` 同为 `Jiaze-Li/review-bot`，并加一条测试把两者对齐（见 §6）。

**代码/文档改动（最小集）**
- `worker/wrangler.toml` `CONTROL_REPO`、`worker/src/index.js:145` 回退值 → `Jiaze-Li/review-bot`。
- `README.md` 标题、`package.json` 的 `name`、`scripts/notification-policy.mjs` 注释 → 新名（仅标签）。
- 测试里的仓库名字符串同步为新名；`jiaze-claude-review-bot` 与 `claude-review-bot/review` 一律不动。
- README/文档新增一小节说明“改名历史与不改的三个标识（App 名/命令、Worker 服务、提交状态名）”。
- ReviewLoop（另一个仓库、另一个 PR）：只改 F8 里的活跃**链接**与文档措辞；`COMMON.md:52` 与 `src` 报错文字属服务名称而非链接，且 `COMMON.md` 是受管合同块，**不在本任务内改**（需你单独授权，见 §7）。

**失败与恢复**
- 改名失败/被拒：停止，状态不变，向你报告。
- 改名成功但配置 PR 未合并：Worker 经重定向仍用旧名；验证 `GET /repos/Jiaze-Li/claude-review-bot/installation` 重定向可用；若不可用立即改回名（见回滚）。
- 部署后审查失败：回滚 = 把 `CONTROL_REPO`/回退值还原为旧名（旧名重定向仍有效）并 `workflow_dispatch` 触发部署，或把仓库名改回；任何一步都不新建仓库。
- 回滚局限：改回旧名后，新名重定向同样依赖 I3；Plan 要求的回滚说明将写入最终报告。

## 6. 验证（声明 → 可能的失效 → 能检出的证据）

| 声明 | 失效方式 | 证据 |
| --- | --- | --- |
| 同一仓库改名 | 建了新仓库/ID 变 | 改名前后 `gh api repos/... --jq .id` 同为 `1350391701`；分支/PR/Issue 数量与最新 SHA 前后相同 |
| 重定向可用 | 旧链接 404 | 对旧 URL 请求 PR 页/API，记录重定向结果（`curl -I`/`gh api`） |
| App 安装保留 | 改名后 `/installation` 404 | 用 App 身份调用新名 `GET /repos/Jiaze-Li/review-bot/installation` 返回 id |
| 配置/回退一致 | 只改一处 | 新单元测试：读 `wrangler.toml` 的 `CONTROL_REPO` 与 `index.js` 回退字面量，断言相等且不含旧名；反向用旧值时测试必须失败 |
| 部署的是新配置 | 以为部署了其实没有 | `deploy-worker` 运行成功的 run 链接 + 部署后 Worker 日志/一次触发里实际打到的控制仓库；不能只看仓库里的 toml |
| 命令不变 | 误改正则 | 现有 `review-trigger`/`review-convergence` 等测试继续通过；`git diff` 中不得出现对 `jiaze-claude-review-bot` 与 `STATUS_CONTEXT` 的修改 |
| 端到端真实审查 | 只跑了单测 | 在真实测试 PR 评论 `@jiaze-claude-review-bot review`：Worker 接收（delivery/日志）→ 工作流运行 → bot 发布 Independent Review Session，`lastReviewedHead` = PR HEAD；再推一个小提交重复一次；检查自动 PR 事件路径是否适用并如实标注 |
| 无人为豁免 | 用 override 得 READY | 会话评论里无 `override` 记录；报告列出所用命令 |
| 回归 | 其他改动被带入 | `npm test`（仓库与 `worker`）全绿，未运行项标 NOT RUN |

## 7. 实施顺序、人工关口与授权草案

1. 前置核对（只读）：F9 全部重跑；确认 `review-bot` 名称仍可用；记录改名前基线（ID、分支/PR/Issue 数、各分支 SHA、已部署 Worker 的当前状态）。
2. 在本分支写好配置/文档/测试改动与新增测试，本地测试通过，ReviewLoop 本地审查通过；**暂不合并**。
3. **关口 G1：你确认可以改名。** 执行改名；立即做重定向与安装核查；更新本机 `origin`。
4. **关口 G2：你授权合并配置 PR。** 合并 → 自动部署 → 核实部署运行。
5. 端到端真实审查与回归；写最终报告（SHA、PR 链接、部署证据、结果、残余风险、回滚方法）。
6. ReviewLoop 仓库的文档链接改动走它自己的 PR；`COMMON.md`/受管合同块如要改，需你单独说“动这份规则”。

授权草案（未列出的一律视为未授权）：
- 修改本仓库文件、commit、push 本分支、更新 PR：**请求授权**。
- 改名 GitHub 仓库：**G1 单独确认**。
- merge 配置 PR 并触发 Worker 部署：**G2 单独确认**，不因 PASS 自动发生。
- 在 ReviewLoop 仓库改文档链接并开 PR：**请求授权**；改 `COMMON.md`/CLAUDE.md 受管块：**未授权**。
- 改密钥、权限、App 设置、Worker 名、新建服务、删除任何东西：**不授权**。

## 8. Work Contract（Code 阶段直接使用；自包含）

**结果**：`Jiaze-Li/review-bot` 是原仓库（ID `1350391701`）的新名字；已部署 Worker 沿用原服务名和地址，且运行时配置与回退值都指向 `Jiaze-Li/review-bot`；一次真实 PR 审查在新名下完整成功并绑定到当前 PR HEAD。

**必须保持**：I1–I5；评审行为、预算、模型、严重度、`jiaze-claude-review-bot` 命令与 App 名、`claude-review-bot/review` 状态名、Worker 服务名与 Webhook 地址、密钥与权限均不改；不新建任何仓库/服务；不合并未授权的 PR；不改 ReviewLoop `COMMON.md`/受管合同块。

**全局验收（对应 Plan §5）**
1. 改名后 `.id` 不变，分支/PR/Issue/提交与改名前基线一致；旧 URL 重定向已检查并记录；Actions 引用已审计（本仓库工作流无外部 `uses:`，其他 `Jiaze-Li` 仓库已搜索，未覆盖范围已声明）。
2. Worker 沿用服务名与地址；`CONTROL_REPO` 与回退值一致且测试守护；**已部署**状态被实际核实（部署运行 + 一次真实触发的证据），不是仅看提交的配置。
3. 活跃文档与 ReviewLoop 活跃链接已迁移或确认兼容；历史评论/记录保持不变。
4. 在实施 HEAD 上，仓库与 `worker` 的 `npm test` 通过；未运行项明确写 NOT RUN。
5. 真实测试 PR：用 `@jiaze-claude-review-bot review` 触发，Worker 接收，工作流运行，bot 发布 Independent Review Session 且 `lastReviewedHead` = 当前 PR HEAD；自动事件路径适用则验证，不适用则如实标注。
6. 不使用 override/豁免/伪造状态；最终报告包含：仓库 SHA、PR 链接、部署运行链接、端到端结果、残余风险、回滚步骤。

**证据义务**：改名前后基线对照；重定向检查输出；安装接口返回；新增对齐测试及其“旧值必失败”反例；部署运行链接与实际触发证据；端到端会话评论摘录（含 HEAD）。以上全部以内联摘要提交，不写“见文件”。

**停止条件**（遇到即停下报告，不自行绕过）：改名被拒或名称被占用；重定向或 App 安装核查失败；部署失败；真实审查不成功或绑定了错误 HEAD；任何步骤需要改密钥/权限/App 设置；任何需要 override 才能“通过”的情况。
