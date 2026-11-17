# Design — RB-THREAD-RECONCILE-01：每轮审查对账机器人自己发的评论区线程

- **Task**：`RB-THREAD-RECONCILE-01` · **Plan**：`v1.0`（冻结，`docs/rb-thread-reconcile/Plan.md` @ `6f3c1c6`）· **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查基线**：Bot `main` = `9f8e2b7`（含 #86、#89）；任务分支 `6f3c1c6` = main + Plan。
- **阶段**：Design。本文件不改代码；Code 阶段只用文末 Work Contract。

## 1. 目标 / 范围 / 非目标

**目标**：沿用 Plan G1–G3。会话里查不到的机器人旧线程（下称“孤儿线程”）在合适的付费审查里被识别、核实：修好才关，没修好重新计入未解决，并在评论里如实汇报。
**范围**：读取线程时多取几个字段、识别孤儿、把孤儿放进“已经要跑的那次验证”、评论汇报措辞、测试与一页说明。
**非目标**：沿用 Plan §3；另外**不新增会话字段、不新增会话写入者、不新增模型调用路径**，不改 `applyVerificationResult` 的判定。

## 2. 已核实事实（文件:行 + 摘录；Reviewer 无法读仓库，以此为准）

F1（线程现在读什么）`scripts/review-threads.mjs:9` — `nodes{id isResolved resolvedBy{login} comments(first:1){nodes{databaseId body author{login}}}}`。**没有取线程的 `path`/`line`/`isOutdated`**；首条评论 `body` 有。`fetchReviewThreads` 最多翻 20 页 ×100（:19 一带）。
F2（线程与问题怎么对上）`review-threads.mjs:59-76` `threadsByFinding`：`if (!first || first.author?.login !== botLogin) continue;` 然后 `idsByKey.get(markerKey(first.body))`——**只有会话里有同 key 的问题，线程才被归属**；其余线程被无声忽略。这就是孤儿线程的成因。
F3（线程正文长什么样）`scripts/github-review-api.mjs:107` — `body: render(finding) + snapNote(anchor) + '\n\n' + findingMarker(finding.path, finding.title)`；`publish-review.mjs:35` render 为 `` `**[${finding.severity}] ${finding.title}**\n\n${finding.body}` ``。即线程正文 = `**[P2] 标题**\n\n正文`（可能带一行 `_Pinned to the nearest changed line…_`）+ 隐藏标记。
F4（标记只是哈希）`scripts/review-anchors.mjs:65-72` `findingKey(path,title)` = `sha1(path\0 规范化后前140字标题)` 前 10 位；`findingMarker` = `<!-- jiaze-finding:<key> -->`。**标记不含标题/路径本身**，所以孤儿的路径、标题、正文必须从线程（GraphQL 的 `path` + 首条正文）重建；重建后用 `findingKey` 重算，**与线程标记相等才算识别成功**（可检验）。
F5（验证现在验什么）`scripts/run-gemini-review.mjs:84-88` — `const open=openMaterialFindings(session); … open.map(f=>({id,severity,title,body,path,line,riskClass}))`，提示词要求对**每个 OPEN id** 返回 FIXED/STILL_OPEN/UNCERTAIN。`openMaterialFindings`（`review-session-core.mjs:849-852`）= `status==='OPEN' && isBlocking`（P0–P2，及未降级的 P3：:5-7）。
F6（验证结果的落地）`review-session-core.mjs:242-314` `applyVerificationResult`：只对 `status==='OPEN'` 的问题；`FIXED` 才关；漏报 → `resolutionReason:'Verifier omitted this open finding; kept open fail-closed.'` 保持 OPEN；`verificationRound+1`；无 OPEN 时 `auditCompleted===true ? 'READY' : 'AUDIT_PENDING'`，否则 REWORK（第 2 轮仍开则 HUMAN_REQUIRED）。**不检查 `session.status`。**
F7（谁持久化）`scripts/publish-gemini-review.mjs:47-48` — `session = applyVerificationResult({ session: plan.session, result: normalized, headSha })`，随后 `saveSessionComment`（:1、:72 一带）。`plan.session` 来自 planner 写的 `session-plan.json`（`plan-review-session.mjs:~285-295` 的 CLI 尾部：`fs.writeFileSync(output, JSON.stringify(plan…))`）。**所以 planner 放进 `plan.session` 的内容，会由已有的验证发布步骤写入会话，无需新写入者。** `publish-gemini-review.mjs:75` `newFindings = session.findings.slice(plan.session.findings.length)`：只有验证新发现的才会被当“新问题”另发线程；planner 放进去的孤儿不会重复发线程。
F8（关线程/重开线程已是现成的）`scripts/sync-review-threads.mjs:29-31` — `const bounce = env.REVIEW_MODE === 'verification'; … stillOpen = findings.filter(MATERIAL && OPEN/UNCERTAIN)`；已修好（FIXED/DISMISSED/WAIVED）的线程被 `resolveThread`；`bounce` 时，**人点了 resolve 但问题仍开**的线程被 `unresolveThread` 并回复原因。它按 `threadsByFinding` 归属——所以只要孤儿作为会话问题入列且 key 对得上，AC2、AC3 的关/重开**零新增代码**。只碰 `first.author.login === botLogin` 的线程（F2），AC4 天然成立。
F9（验证范围的现成做法）`plan-review-session.mjs:171-203` `resolveVerificationScope`（#86）：旧基线不可用时把 `pr.diff`（当前 PR 相对目标分支的完整 diff）写成 `repair.diff`，返回 `{mode:'verification', previousHead, scope:'current-pr'}`；先用 `stagedReviewCapacity` 判断一次装不装得下，`capacity.kind !== 'too_large'` 才这么做；常量 `MAX_CARRIED_FINDINGS=8`（:12）。planner CLI 尾部（`:~262-290`）依次 `planSession` → `resolveVerificationScope` → 增量分类 → 写 `session-plan.json` 与 `mode`/`reason` 输出。
F10（会话容量）`review-session-core.mjs:1071` — `session.findings.length > 64` 抛错；`completeDeepReview` 一次最多 6 条新问题（:~485）。
F11（#89 接力）`continue-review.mjs:12,61` — `REVIEW_WORK = new Set(['verification','incremental','claude','dismiss','recover'])`；`session.status === 'AUDIT_PENDING' && !currentCoverage(session) && REVIEW_WORK.has(planMode)` → 自动接力最终全面审查。验证后若会话为 AUDIT_PENDING，最终审查会自动接上。
F12（现场）`full_review` 在 AUDIT_PENDING 且 HEAD 变化时：`review-session-core.mjs:~72-76` 返回 `full_review`（“PR changed before final audit; start a fresh bounded session”），而全面审查（`completeDeepReview`）**不核实任何旧问题**（只补新问题，:~491-505）。→ #195 里这 4 条旧线程在 full_review 路径里永远没人核实。
F13（#86 的取舍先例）`seedSession` 的 `carryOpen` 把旧 OPEN 携带为 `UNCERTAIN`（“需确认”，只有人工 dismiss 能关；`review-session-core.mjs:~413-419`）——这是“装不下一次验证”时的既有退路；本设计**不复用**它（见 Options）。

## 3. Options（U2/U5/D4）

- **A（选）孤儿“领养”进计划里的会话，借用已经要跑的验证**：planner 在**本来就要跑验证类付费审查**的那些运行里，取线程、识别孤儿，把它们作为 `OPEN` 问题（`origin:'THREAD_ORPHAN'`，同一字段的新取值，不是新字段）放进 `plan.session`，范围切到“整个当前 PR diff”（F9 现成），由现有验证逐条判 FIXED/STILL_OPEN/UNCERTAIN；落地、关线程、重开、接力全部沿用现有机制（F6–F8、F11）。零新模型路径、零新写入者。
- B 单独一个“对账”步骤自己调模型判定再关线程：新增模型调用与费用控制，并要自己写回会话（第 12 个写入者，违反 Plan §4）；否决。
- C 只汇报、不核实、不关（Plan D4 的“第一步”）：最安全但 G2 不成立，用户仍要手工关 4 条；否决为唯一方案，但**保留为部分运行的行为**：不跑验证类审查的运行里只汇报（见 §6）。
- D 孤儿一律按 #86 的 `CARRIED_OPEN` 变成“需确认”（只有人工 dismiss 能关）：不核实、噪音最大、与 R4 冲突；否决。
- **D4 推荐**：不按“先汇报后放开”分两个版本，而是按运行类型分：**验证类运行（含 AUDIT_PENDING 的最终审查前）核实并可关；其它付费运行只识别汇报**。原因：核实本身要付一次验证的钱，只在那一次钱已经要花的地方搭车，不增加无谓花费（U5）。

## 4. Assumptions

- “孤儿”= 作者是本机器人 + 首条评论带标记 + 标记 key 在当前会话里找不到对应问题 + 线程未被**机器人自己**关闭（人关的算，因为人关只是声明）。机器人自己关的线程当作已核实过，不再碰。
- 路径取线程的 `path`；若 `path` 为空或重建后 `findingKey` 对不上标记，视为**无法识别**，不领养，只计数汇报（宁可少关，不错关；R1）。
- 孤儿的原严重级别取自线程正文 `[P0..P3]`；解析不出视为无法识别。
- 单轮领养上限取 **8**（与 #86 的 `MAX_CARRIED_FINDINGS=8` 一致，也是验证提示词能稳妥承载的量级）；优先级 P0–P2 先、P3 后，同级按线程创建顺序。**多出的不丢**：它们仍是 GitHub 上的线程，下一轮对账会再取到；评论如实写“还有 N 条没处理，下一轮继续”。
- 孤儿所指文件已不在当前 PR 的 diff 里：**不核实、不关、不计入阻塞**，只汇报“N 条指向已不在本 PR 的文件，需人工处理”。理由：无代码可核实，按 Plan“必须核实才算修好”不能当修好；也不为它们复活阻塞（R4）。
- 一次核实占用一轮验证（`verificationRound+1`，见 F6）。孤儿仍开时会话进入 REWORK，修复后再验证；与真实问题处理完全一致。**这是用户可感知的取舍，见 §9。**

## 5. 不变量

- **I1** 只读取线程并识别作者=本机器人且带标记者；非机器人线程不读正文、不改、不回复（AC4）。识别在代码里是纯函数，可单测。
- **I2** 孤儿只在“当前 PR 整个 diff 一次装得下”时才被领养；装不下则一条也不领养，只汇报“本 PR 太大，N 条旧线程这次没能核实”，线程保持原样（不关、不阻塞、不新开）。
- **I3** 领养不写 `session.status`、不新增字段；只在 `plan.session.findings` 追加条目（`origin:'THREAD_ORPHAN'`，`status:'OPEN'`，`introducedHead`=当前 HEAD），总数不超过 `64`（超限则少领养并计入“没处理”）。
- **I4** 只有一种情形会改变现有运行的类型：planner 原决策为 `verification`（范围可保持原样，或因孤儿切到 current-pr），或会话为 `AUDIT_PENDING` 且原决策为最终审查 `full_review`。**READY 后的增量审查、`@claude review`、reset、dismiss/override/threads/stale/recover、noop*、human_required 不改类型，只汇报。** 理由：READY→增量若改成验证，F6 会在 `auditCompleted===true` 时直接给出 READY，跳过新改动的增量审查（R1 级错误）。
- **I5** 任何未经验证者不得变为 FIXED；FIXED 只来自 `applyVerificationResult` 对 `FIXED` 的显式判定（F6）。验证漏报/不确定 → 保持 OPEN（fail-closed）。
- **I6** 无孤儿时（含无会话、无线程、线程全可对上）planner 输出、评论、状态、花费与改动前逐项一致；多出的只有一次只读 GraphQL（AC5）。取线程失败 → 当作“无孤儿”继续，log 一条警告，不使运行失败。
- **I7** 评论汇报文字出自会话里 `origin==='THREAD_ORPHAN'` 的条目（已修好数、仍开数）加 planner 传来的渲染入参（没处理数、无法识别数、太大未核实数），不新增会话字段。

## 6. 数据流与失败/兼容

1. **planner**（`planSession` 之后、写 `session-plan.json` 之前）：
   - 条件：`REQUESTED_MODE==='auto'`，且（原决策 `verification`，或会话 `AUDIT_PENDING` 且原决策 `full_review`），且有 `GH_TOKEN` 与会话。
   - 取线程（F1 的查询多取 `path`、`line`、`isOutdated`）→ 取机器人首条评论带标记、key 不在会话、未被机器人关闭者 → 重建 {path,title,severity,body,line}，重算 key 比对（F4）。
   - 判定：无孤儿 → 不动。有孤儿但属于“只汇报”的运行类型 → 只给渲染入参。否则按上限与 I2/I3 领养，用 `resolveVerificationScope` 同款的“整个 PR diff”判断与 `repair.diff` 写法（F9）把决策定为 `{mode:'verification', scope:'current-pr'}`（原本是 AUDIT_PENDING 的 full_review 也在此改为验证，最终审查随后由 F11 接力自动跑）。
2. **验证**（现有）逐条判；**发布**（现有）写会话；**同步线程**（现有）关已修好的、重开人手关但仍开的并回复原因（F8）；**接力**（现有）若 AUDIT_PENDING 且无当前覆盖则启动最终审查（F11）。
3. 评论多一块“旧线程对账”：`发现 N 条旧线程：已核实 X 条已修好并关闭、Y 条仍存在；另有 A 条没处理（下一轮继续）/ B 条无法识别 / C 条指向已不在本 PR 的文件 / 本 PR 太大这次没能核实 D 条`，按有值才写。

失败：取线程/解析出错 → 等同无孤儿（I6）；验证因模型不可用 → 走现有 `stop-unavailable-review` 路径，会话里领养的孤儿**随该次失败一并不持久化**（未发布）→ 下一轮重新对账，不会残留半状态；预算/模型/分片/轮数全部沿用，验证类运行的单次费用上限不变。
旧会话/旧数据：不需要任何迁移；孤儿本来就不在会话里。已被领养并持久化的孤儿，下一轮就是普通会话问题（key 对得上），不再是孤儿，不会重复领养。
改写历史（U6）：领养后的验证强制用“整个当前 PR diff”，不依赖旧位置；孤儿不用行号定位，只用路径+标题+正文给验证者（F5 的字段），行号仅作提示。

## 7. 验证证据（声明 → 失效方式 → 能检出的证据）

| 声明 | 失效方式 | 证据（测试） |
|---|---|---|
| AC1 孤儿被识别并汇报 | 标记/author 判断漏掉；汇报数字与会话不一致 | 夹具：会话无记录 + 4 条机器人线程 → 领养 4 条，评论渲染含 N/X/Y |
| AC2 修好关、没修好重计 | 把 UNCERTAIN/漏报当 FIXED | 验证夹具：FIXED→线程被 resolve；STILL_OPEN/漏报→保持 OPEN、状态 REWORK；断言**无** FIXED 来自非显式判定 |
| AC3 人关的仍开则重开 | bounce 仅对已知问题生效 | 夹具：孤儿线程被他人 resolve + 验证 STILL_OPEN → `unresolveThread` + 回复被调用 |
| AC4 非机器人线程不碰 | 作者判断被标记伪造绕过 | 夹具：他人线程带伪造标记 → 不领养、不 resolve、不回复 |
| AC5 无孤儿回归 | 多了写入/改了决策 | 现有全部用例不变；无孤儿夹具下 `session-plan.json` 与改动前逐字节相同 |
| AC6 上限与如实汇报 | 静默丢弃或超预算 | 夹具：20 条孤儿 → 领养 8、评论“还有 12 条”，下一轮取到后 8；领养不超 64 |
| AC7 既有状态不变 | READY/增量被改成验证（I4） | 夹具：READY+新 HEAD+孤儿 → 仍是 incremental，仅汇报；PARTIAL/HUMAN_REQUIRED 同样 |
| I2 太大不领养 | 装不下仍领养导致验证被截断 | 夹具：超 `stagedReviewCapacity` → 零领养、评论说明 |
| F4 key 对不上 | 错领养后线程永远关不掉 | 夹具：标题含 `**`/换行 → 视为无法识别，不领养 |
| U3 文件已不在 PR | 当修好关闭 | 夹具：孤儿路径不在 pr.diff → 不领养、不关、汇报 |
| 取线程失败 | 运行因此失败 | 注入 GraphQL 错误 → 等同无孤儿，运行不失败 |

AC9 真实复测（SpinLab #195 的 4 条）花钱，不在 Code 阶段做。

## 8. 最小实现顺序

1. 线程读取多取 `path/line/isOutdated`（向后兼容，缺则当未知）+ 纯函数“识别孤儿并重建 + 重算 key 校验”+ 单测。
2. 领养纯函数（上限、优先级、64 上限、非 diff 内文件分流）+ 单测。
3. planner 接线：按 I4 的条件与 I2 的容量判断改决策；无孤儿零差异回归。
4. 评论渲染入参与措辞；`publish-gemini-review` 把 planner 传来的汇报入参带给渲染（沿用 #89 `finalReview` 的传参方式）。
5. 一页说明（README 或 docs）。

## 9. 需要用户确认的产品取舍与授权草案

- **取舍 T1**：核实孤儿占用一轮验证次数（共 2 轮）。孤儿仍开时用户要先修再过验证。推荐接受（与真实问题一致）。
- **取舍 T2**：READY 之后的增量审查**不核实**孤儿，只汇报（I4）；孤儿在下一次验证类/最终审查前保持原样。推荐接受（避免跳过增量审查的风险）。
- **取舍 T3**：PR 太大一次验不完时旧线程不核实、不阻塞（I2）；不用 #86 的“需确认”式阻塞，避免复活老问题噪音（R4）。如你更想让它们阻塞，请告知。
- 授权草案（未列出视为未授权）：Code 阶段——修改 review-bot 的脚本、测试、文档；commit/push 到任务分支 `feat/reconcile-bot-threads`。始终不授权：合并、标记 Ready、部署、触发付费复测（含对 SpinLab #195 发触发评论）、改权限/凭据/模型/费用上限。

---

## 10. Work Contract（Code 阶段直接使用）

**结果**：每个会触发验证类审查的运行，会把评论区里机器人自己发的、会话里没有记录的旧线程识别出来，核实后修好的关闭、没修好的重新计入并（人手关过的）重开说明原因，评论如实汇报；其余运行与改动前一致。

**必需不变量**：I1–I7（§5）；不新增会话字段/写入者/模型路径；`applyVerificationResult`、READY/REWORK/HUMAN_REQUIRED/PARTIAL/AUDIT_PENDING 判定、预算、模型、分片 20、验证 2 轮、接力 3 次、#86/#89 逻辑不变。

**全局 AC**：Plan AC1–AC8（AC9 不在代码阶段）。具体：
- 识别条件：作者=本机器人 + 标记 + 会话无同 key + 非机器人自关；重建后 `findingKey` 必须与标记相等，否则不领养（计入“无法识别”）。
- 领养仅在 I4 列出的运行类型；上限 8，P0–P2 优先，领养后会话问题总数 ≤ 64；未领养的如实计数汇报。
- 当前 PR 整个 diff 装不下 → 零领养、汇报。路径不在 PR diff → 不领养、汇报。
- 无孤儿时输出与改动前逐项一致。
- 取线程失败不使运行失败。

**验证与证据**：`npm test`（项目现有 runner）全绿；新增测试覆盖 §7 表的每一行（正向、负向、旧会话数据、线程很多 20 条、READY 不改类型、非机器人伪造标记、key 对不上、文件不在 diff、GraphQL 失败）；回归断言无孤儿时 `session-plan.json` 与改动前相同。

**阶段**：不分阶段（单一完成关卡）。

**停止条件**：发现必须新增会话字段/写入者、必须改 `applyVerificationResult` 判定、或必须改变 I4 以外运行类型才能满足 AC → 停下回用户确认；任何付费复测、合并、部署均不在授权内。
