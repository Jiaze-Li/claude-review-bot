# Design — RB-AUDIT-CONTINUE-01：验证通过后，最终审查不能无声停住，也不能装作还在跑

- **Task**：`RB-AUDIT-CONTINUE-01` · **Plan**：`v1.0`（冻结，`docs/rb-audit-continue/Plan.md` @ `aabcac6`）· **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查基线**：Bot `main` = `a815484`；任务分支 `aabcac6` = main + Plan。
- **阶段**：Design。本文件不改代码；Code 阶段只用文末 Work Contract。

## 1. 目标 / 范围 / 非目标

**目标**：(G1) 验证通过、只剩最终全面审查时自动接力，不被上一轮提交遗留的“没审完”记录挡住；(G2) 没能接力时，评论与提交状态明说“现在没有在运行 + 该发的指令”；(G3) 真在跑时仍显示在跑。
**范围**：接力判断、会话评论的覆盖展示与“下一步”措辞、提交状态描述、接力步骤的结果传递、测试、一页说明。
**非目标**（沿用 Plan §3）：不改 READY/问题关闭权威；不改预算、模型、20 片、验证 2 轮、接力 3 次上限；不改 #86；不新增会话写入者；不改状态机的 `status` 取值。

## 2. 已核实事实（文件:行 + 摘录；Reviewer 无法读仓库，以此为准）

F1（根因 1）. `scripts/continue-review.mjs:46` — `if (session.status === 'AUDIT_PENDING' && !session.coverage && REVIEW_WORK.has(planMode)) {` 才返回 `continue:true`；任何 `coverage` 字段（不论属于哪个提交）都使接力返回 `nothing left to continue`（:50 一带）。
F2. 验证结果写会话时整体展开旧会话：`scripts/review-session-core.mjs:302-313` — `return { ...session, lastReviewedHead: headSha, status, verificationRound, … findings, lastSummary, updatedAt }`，**不触碰 `coverage`**。同类“只改 findings/status 的展开写入”还有：人工放行/驳回 `:~286-298`（`...session, findings, status`）。因此上一轮 PARTIAL 留下的 `coverage` 会跟着新提交走。
F3. `coverage` 的写入点只有深审结果一处：`review-session-core.mjs:542-543` — `if (coverage && !coverage.complete) completed.coverage = { ...coverage, head: headSha }; else delete completed.coverage;`。即**凡写入必带 `head`**（本次深审的 HEAD），完整通过会删除。`normalizeCoverage` 不产生 `head`（:549 起），所以不存在不带 `head` 的新记录；旧数据若无 `head` 视为未知。
F4. 评论展示不看 `head`：`review-session-core.mjs:953` — `...(session.coverage && !session.coverage.complete ? [ \`Review coverage: **PARTIAL** — …\`, …unreviewedPaths… ] : [])`，在任何 `status` 下都显示。
F5. 评论“下一步”承诺：`review-session-core.mjs:909-910` — `session.status === 'AUDIT_PENDING' ? 'The final full review runs automatically (Gemini first, Claude continues). If the workflow stops, comment \`@gemini review\` to resume it.'`。无条件承诺，渲染时不知道接力是否会发生。
F6. 提交状态：`review-session-core.mjs:595` — `case 'AUDIT_PENDING': return { state: 'pending', description: 'Final audit pending' };`；`:597` PARTIAL 是 `error`；REWORK 是 `failure`；`:589` 起非本 HEAD 或无会话是 `pending`。`pending` 与 begin 阶段写的“运行中”同色。
F7. 接力是尽力而为且无声：`.github/workflows/review-v2.yml:586-607` — step `Continue a big review in the next run`，`if: always() && … job.status == 'success' && inputs.source_kind != '' && steps.plan.outputs.mode != 'noop_waiting'`，`continue-on-error: true`，`run: node scripts/continue-review.mjs`；`continue-review.mjs:58-62` 判定为否时只 `log.log('No continuation: …')` 并返回；`:78` `if (!response.ok) throw new Error('Could not start the next review run (HTTP …)')` → `:88` `process.exitCode = 1`，被 `continue-on-error` 吞掉。该步骤**没有任何 step output**。
F8. 其后的状态镜像步骤：`review-v2.yml:636-653` — `Mirror review state to the required commit status`，`if: always()`，在 `Continue` 之后执行，调用 `scripts/sync-commit-status.mjs`，其 `syncCommitStatus` 从最新会话评论计算 `sessionCommitStatus(session, headSha)` 后再按 `JOB_FAILED`/`DEEP_REVIEW_ATTEMPTED` 覆盖（`sync-commit-status.mjs:21-30`）。同一 job，可读前序 step 的 outputs。
F9. 会话评论有 11 个受保护写入者（`docs/session-writer-matrix.md` §1，同一 concurrency 组串行，`review-v2.yml:89-92`）；渲染入口 `renderSessionComment` 有 11 处调用（`apply-override/apply-stale/apply-dismissal/apply-thread-resolutions/deep-review/publish-gemini-review(×2)/review-status/recover-review-session/stop-unavailable-review/sweep-stale-deep-reviews`）。新增第 12 个写入者需改矩阵并重审并发，代价大。
F10. 现有测试：`tests/continue-review.test.mjs` 用 `decideContinuation` 与注入 `fetchImpl` 的 `continueReview`（含 `partial` 夹具 `coverage.head === HEAD`、`awaiting` 夹具无 `coverage`），`tests/session-comment.test.mjs`、`tests/review-session.test.mjs`、`tests/review-status.test.mjs` 覆盖渲染与状态。
F11. 现场（Plan §1，未在本设计中重新联网核实）：SpinLab #195 会话 = AUDIT_PENDING 且带上一轮旧提交的 coverage。按 F3 该记录必带旧提交的 `head`。**本设计依赖“旧记录带 `head`”这一点；Code 阶段须用夹具验证，并对无 `head` 的旧记录采取保守处理（见 I2）。**

## 3. Options

**U1/U2 如何不让旧记录挡路**
- **A（选）读取处判定“当前覆盖”**：新增一个共用判断 `currentCoverage(session)` = `coverage` 且 `coverage.head === session.lastReviewedHead`（无 `head` 视为当前，保守）。接力判断与评论展示都只看它。不改任何写入点、不迁移旧数据，旧会话（#195）立即生效。
- B 在所有“展开写入”处清除 coverage（验证、放行、驳回、增量）：写入点多（F2），漏一处即复发，且要改被多个状态依赖的数据；否决。
- C 只在验证结果里清除：解决 #195，但放行/驳回/增量路径同样遗留（F2），且不修已存在的旧会话；否决。

**U3/U4/U5 如何“说实话”**
- **X（选）把“会不会自动接力”在写评论前算出来，状态镜像用接力步骤的真实结果**：
  1. 评论：`renderSessionComment` 新增可选入参 `finalReview: { startsByItself: boolean, reason }`。调用方已知 `planMode/sourceCommentId` 时，用与接力**同一个纯函数** `decideContinuation` 算出（保证评论与真实行为同源）；`startsByItself=true` 才写“最终全面审查正在自动启动”，否则写“**现在没有在运行**：<原因>。要继续请评论 `@gemini review`”。未传入（调用方不知道）时用**中性真话**：“最终全面审查是下一步，此刻不一定在运行；如果 PR 上没有新的运行，请评论 `@gemini review`”，不再写“会自动运行”。
  2. 接力步骤把结果写成 step output（`dispatched=true|false`、`reason`），失败也不再无声：捕获派发失败，输出 `dispatched=false` + 原因，打 `::warning::`，仍保持 best-effort（不令步骤变红、不拖垮运行）。
  3. 提交状态：镜像步骤读该 output。会话为 AUDIT_PENDING 且属于当前 HEAD 时：已派发 → `pending`「Final review starting automatically」；否则 → `error`「Final review is NOT running: comment @gemini review」。其它状态完全不变。
- Y 接力后再补写一次评论（把“在跑/已停”写进会话）：需要第 12 个写入者或让接力步骤调用 `saveSessionComment`，违反 F9，且多一次通知/写入；否决。
- Z 只改措辞不换状态：评论不再承诺，但状态仍是黄色 `pending`，用户在 PR 检查列表仍分不清（Plan U3）；否决。
- 残余窗口（诚实写明）：评论在接力步骤前发布，若评论判定“会自动启动”而后派发 HTTP 失败，评论仍写“正在启动”，此时靠提交状态变红 + 运行警告纠正；这是方案 X 为避免第 12 个写入者所接受的最小残余。

## 4. Assumptions

- 旧提交遗留的“没审完”记录总带旧提交标记（F3）；无标记的极旧记录按“仍属当前”保守处理，宁可多挡一次也不把真没审完当成审完（R1）。
- 提交状态从黄变红只在“最终审查确实没在运行”时发生。红与黄对合并都是“未通过”，对必需检查的影响相同（都不是 success）；区别只是看起来是“还在等”还是“已停、需要你发指令”。**这是产品取舍，见 §9。**
- 接力被拒的“其它原因”（如纯记账运行：关闭 P3 线程、人工放行）按现有规则不启动付费审查；此时评论如实写“没有在运行 + 指令”。这与改动前的**行为**一致，只是**说明**变真。
- 不为已停的现场自动补跑；#195 的复测另行授权（Plan D3、AC8）。

## 5. 不变量

- **I1** 接力只在 `AUDIT_PENDING` + 当前 HEAD 已审 + 本次运行做了审查工作（`REVIEW_WORK`）+ 链长 < 3 时发生；预算、模型、分片、验证轮数不动。
- **I2** `currentCoverage` 只会比现状**少挡**“确定属于旧提交”的记录；`coverage.head === lastReviewedHead`（真实部分覆盖）与无 `head` 的记录行为与现状逐字一致（AC3、R1）。`PARTIAL` 状态的判断路径（planner、`decideContinuation` 的 PARTIAL 分支、`sessionCommitStatus`）**不使用** `currentCoverage` 之外的新逻辑，保持原样。
- **I3** 评论中出现“自动运行/正在启动”类措辞，当且仅当 `decideContinuation` 对同一输入返回 `continue:true`。
- **I4** 只有 AUDIT_PENDING 且属当前 HEAD 的提交状态可能从 `pending` 变 `error`；READY/REWORK/HUMAN_REQUIRED/PARTIAL/非当前 HEAD 的状态输出与现状逐项相同（AC6）。
- **I5** 接力步骤仍是 best-effort：任何失败不使运行失败、不重试派发、不新增写入者、不写会话。
- **I6** 不新增 session 字段、不迁移数据；旧会话无需转换。

## 6. 失败/转换与兼容

| 场景 | 改动后 |
|---|---|
| 验证通过 + 旧提交遗留 coverage（#195） | `currentCoverage=null` → 接力派发；评论不再展示旧“没审完” |
| 验证通过 + coverage.head == 当前 HEAD | 与现状相同：不接力、如实列出文件（AC3） |
| coverage 无 head（极旧） | 视为当前：与现状相同 |
| 接力已到 3 次 | 评论“没有在运行：已到自动接力上限”+ 指令；状态 `error` |
| 派发 HTTP 失败 | 步骤仍不拖垮运行；输出 `dispatched=false` + 警告；状态 `error`；评论按残余窗口规则 |
| 真在运行（`REVIEW_IN_PROGRESS`） | 状态/评论不变（AC5） |
| 新提交 / READY / REWORK 等 | 完全不变（AC6） |

## 7. 验证表（声明 → 失效方式 → 能检出的证据）

1. 旧 coverage 不再挡接力 → 仍被挡 → `decideContinuation`：AUDIT_PENDING + `coverage.head=旧` 返回 true；AUDIT_PENDING + `coverage.head=当前` 返回 false；无 head 返回 false；`continueReview` 夹具派发一次且入参不变（AC1/AC3）。
2. 评论不显示旧 coverage → 仍显示 → `renderSessionComment`：旧 head 不含“Review coverage”；当前 head 与 PARTIAL 状态含文件清单；既有快照不变（AC2/AC3/AC6）。
3. 评论措辞与行为同源 → 又写“自动运行”但没跑 → 对 `{到上限, 纯记账模式, 旧遗留已清且可接力, 状态非 AUDIT_PENDING}` 逐个断言措辞；未传入 `finalReview` 的渲染不含“runs automatically”；11 个调用点各自断言不含无条件承诺（AC4）。
4. 接力步骤不再无声 → 失败被吞 → `continueReview` 注入 500 的 `fetchImpl`：不抛出到进程失败、返回 `dispatched=false` + 原因；正常返回 `dispatched=true`（AC4/I5）。
5. 状态说实话 → 误伤在跑 → `sync-commit-status`：AUDIT_PENDING+当前 HEAD+`dispatched=false` → `error`；`dispatched=true` → `pending`；其它 5 种状态 × 有/无该 output 的输出与现状逐项相等；非当前 HEAD 仍 `pending`（AC5/AC6/I4）。
6. 回归 → `npm test` 全量通过，新增测试各含正向、负向、旧会话（无 head、旧 head、当前 head）用例（AC7）。
7. 步骤声明 → 工作流未传递 output → 对 `review-v2.yml` 做静态断言：`Continue` 步骤有 `id` 且输出 `dispatched`，`Mirror` 步骤读取它，且 `continue-on-error: true` 仍在（I5）。

## 8. 实施顺序、人工关口、授权草案

最小顺序：①`currentCoverage` + 接力与评论展示改用它 + 测试 → ②`finalReview` 入参与措辞（含中性默认）+ 调用点接线 + 测试 → ③接力步骤输出/失败不无声 + 状态镜像 + 工作流静态测试 + 一页说明（更新 `docs/session-writer-matrix.md` 的“无新增写入者”备注）。可同一提交序列完成，无需分阶段合同。
人工关口：Design PASS 后停；用户说“Code”才实施。
授权（用户已确认，见 §9，待说“Code”后生效）：修改 review-bot 脚本/测试/文档；commit/push 到 `fix/audit-pending-continue`；**不**授权 merge、标记 Ready、部署、对 SpinLab #195 发付费触发评论、改权限/凭据/模型/费用上限。

## 9. 用户已拍板的产品取舍

用户已确认（原话“可以”，回应的是上面的推荐）：停住时提交状态用**红色**「最终审查没有在运行，请发 @gemini review」，真在跑时保持黄色。红与黄对合并都是“未通过”，不新增阻挡。
用户同时确认 Code 阶段可修改 review-bot 的脚本、测试与文档，并 commit/push 到 `fix/audit-pending-continue`；**仍不授权**：merge、标记 Ready、部署、对 SpinLab #195 发付费触发评论、改权限/凭据/模型/费用上限。Design PASS 后仍停下，等用户明说“Code”再实施。

## 10. Work Contract（Code 阶段直接使用，自包含）

**可观察的结果**
- 验证通过且只剩最终全面审查时（含上一轮旧提交遗留“没审完”记录），机器人自己派发最终审查；评论不再展示属于旧提交的“没审完”记录；当前提交真实没审完的文件仍如实列出且行为不变。
- 没能自动接力（上限、派发失败、纯记账运行等）时，评论写明“现在没有在运行 + 原因 + 用户该发的一句话”，提交状态为 `error`（文字同义）；真在跑时显示在跑。其它状态的评论与提交状态与改动前逐项一致。

**必需不变量与边界**：I1–I6；不改预算/模型/分片/验证轮数/接力上限/#86 逻辑/READY 与问题关闭规则；不新增会话写入者与字段；接力步骤保持 best-effort 且不无声；不发付费触发，不碰 SpinLab。

**全局 AC**（对应 Plan AC1–AC7）
- AC1 旧 head 的 coverage + AUDIT_PENDING + 验证类运行 ⇒ `decideContinuation().continue === true` 且 `continueReview` 派发一次。
- AC2 评论仅在 `coverage.head === lastReviewedHead`（或无 head，或 status 为 PARTIAL 的既有路径）时展示覆盖清单。
- AC3 `coverage.head === 当前` ⇒ 不接力、清单照列；PARTIAL 路径原样。
- AC4 评论“自动运行”类措辞仅在 `decideContinuation` 为 true 时出现；否则含“没有在运行”、原因、`@gemini review`；未传入 `finalReview` 的渲染不含无条件承诺；派发失败不再无声（输出 + 警告），步骤仍不拖垮运行。
- AC5 AUDIT_PENDING 且当前 HEAD：`dispatched=true` ⇒ `pending`；`dispatched=false`/缺失（接力步骤未跑）⇒ `error`；`REVIEW_IN_PROGRESS` 状态不变。
- AC6 READY/REWORK/HUMAN_REQUIRED/PARTIAL/非当前 HEAD 的评论与状态逐项相同（回归测试）。
- AC7 `npm test` 全部通过；新增测试覆盖 AC1–AC5，各含正向、负向、旧会话数据（无 head / 旧 head / 当前 head）；工作流静态断言见 §7-7。

**验证与证据**：`npm test` 输出；新增测试名单与断言；工作流静态断言结果；`git diff --stat` 显示未触及预算/模型/分片常量与 #86 文件。AC8（SpinLab #195 真实复测）**不属于 Code 阶段**，需用户另行授权，未授权不标记通过。

**阶段**：无（单阶段，内部顺序见 §8）。

**停止条件**：本地 ReviewLoop `PASS` 后停；若需要新增会话写入者、新增会话字段、改状态机 `status` 取值或改任何上限才能满足 AC，立即停下回到用户，不自行扩范围。
