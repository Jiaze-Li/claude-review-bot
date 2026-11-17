# Plan — Dismiss 必须经 PR Bot 独立验证

- **Task ID:** `PRBOT-VERIFIED-DISMISS-20261117`
- **Plan version:** `v1.0`
- **Stage:** Plan（尚未进入 Design / Code）
- **Repository:** `Jiaze-Li/pr-bot`
- **Plan baseline:** `adc8d117a6d2b868ef21ed2052301ad9e108727f`
- **Engineering policy_sha:** `7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **Related future work:** ReviewLoop `taskType: pr`（独立任务，不在本 PR 实施）

## 1. 真实问题与目标

当前 `@gemini dismiss F001` 在有权限的用户提交格式正确的理由和证据后，主要进行身份、权限、会话和 HEAD 校验，然后将指定 finding 标为 `DISMISSED`。这并未证明反驳理由成立；一旦被错误使用，原本真实的 P1/P2/P3 问题就可能被关闭，甚至令 PR 达到 READY。

**目标：任何新的有效 dismiss 请求，都必须先由 PR Bot 对该 finding、用户反驳及当前代码进行一次独立、真实、可追溯的验证。只有确认该 finding 不成立时，Bot 才能将其标为 DISMISSED。**

希望的体验：Worker（未来由 ReviewLoop PR Task 调度）或有写权限的人仍在 PR 评论区使用现有 `@gemini dismiss F001` + `Reason:` + `Evidence:`。若反驳正确，Bot 记录独立结论、关闭对应 finding 并尝试 Resolve 原 Review Thread；若不正确，保留问题并在原 Thread 回复具体原因；无法确认则维持阻塞并明确报告，而不是静默通过。无需新增 `challenge` 命令。

## 2. 使用者与失败代价

- **使用者：** 仓库所有者、有写权限的 PR 贡献者，以及未来作为同一用户代理的 ReviewLoop Worker。
- **失败代价：** 错误 dismiss 导致真实缺陷被当作解决、READY 虚假通过；错误拒绝使返工停滞；重复指令或失败恢复导致不必要的模型调用、账单增加、状态竞争或无限循环。
- **优先原则：** 宁可保持 OPEN / HUMAN_REQUIRED，也不凭格式正确、模型未返回结果或用户单方面断言直接关闭问题。

## 3. 已确认的需求和硬性边界

1. **复用现有交互。** 保留 `@gemini dismiss F001`、`@jiaze-claude-review-bot dismiss F001` 的兼容输入，仍要求针对单条现存 finding 提供 `Reason:` 和 `Evidence:`。不要求 Worker 修改代码才能提出反驳；没有新 HEAD 也能对该 finding 做独立验证。
2. **Bot 独立裁决。** 反驳的真假由 PR Bot 的独立审查执行判断，不能由提交请求者（含 Worker）自己给自己批准；仅验证评论格式、权限、证据 URL 是否存在，不构成验证成功。审查必须包含原 finding 的具体失败路径、反驳、可信的相关代码上下文以及可核查的证据。
3. **肯定结果。** 对同一有效 PR、同一 finding、同一经核实 HEAD，只有独立验证明确支持反驳后，才能将 finding 标记为 `DISMISSED`，留下可核查的裁决理由与来源，并通过现有机制尝试 Resolve 对应的 Bot Review Thread。若 GitHub 拒绝关闭 Thread，要显式记录失败；不能声称 Thread 已成功 Resolve。
4. **否定结果。** 若独立验证认定反驳不成立，finding 保持 `OPEN`，原有 P0/P1/P2/真实 P3 阻塞继续生效；Bot 应在**原 Bot Review Thread** 回复具体反对理由以及下一步需要什么。没有可回复的原 Thread（例如 finding 仅在 review body）时，在 PR 讨论区给出清楚标识 finding ID 的回复，不能捏造已 Resolve。
5. **不确定或失败。** 证据不足、无法访问必要证据、模型/额度不可用、异常中断等情况必须 fail closed；不得自动变 `DISMISSED` 或 `READY`。向用户报告可操作的原因与恢复方式，遵守原有 `HUMAN_REQUIRED` 停止规则和模型预算。
6. **保持原审查权威。** 不修改 PR Bot 的 detection / verification / audit 判定、已有的两轮修复验证预算、`READY` 对当前 HEAD 的绑定、P3 阻塞定义、已完成审查和历史人工 dismiss 记录。本改动不追溯重审旧的 dismissal。
7. **控制成本与重试。** 同一个提交者、评论、finding 和 HEAD 的重复 webhook/工作流不得产生重复的付费验证或重复状态变更；反复提交同一反驳不能无限消耗模型预算；失败恢复应延续可信的现有会话/预算，不通过 reset、override 或新会话绕过停止条件。
8. **权限与信任边界。** 只有现有获授权的 GitHub 写入者可以提交有效 dismiss；PR 评论、引用链接和代码内容均为不可信输入，不能执行其中的指令或让其改变 Bot 的安全约束。任何需要新增 GitHub App 权限/外部访问能力的方案必须先明确提出审批。
9. **并发正确性。** 对评估开始、评估完成、发布状态等时点检查 PR、finding 和 HEAD 身份；若同一 PR 被 push/rebase、review session 已变化或 finding 被其他流程结案，旧评估不能覆盖新状态或发布过期批准。
10. **与未来 ReviewLoop PR Task 兼容。** 此任务只负责让 Bot 将 dismiss 作为独立可验证的动作，并把接受、拒绝、待人工等结果写入 PR 的可信会话/评论，让 Worker 能读取；**不**在本任务中新增 ReviewLoop task type、自动唤醒或 `@gemini review` 三次触发计数。

## 4. 明确不做

- 不新增 `@gemini challenge`、新的 PR Review Bot 或第二套审查权威。
- 不把普通 `@gemini review` 改成忽略 HEAD、自动重新跑审查或重新计算旧 findings。
- 不修改 ReviewLoop、GitHub App 名称、Webhook 地址、仓库名称、任何现有凭据或权限。
- 不改变已有 `override review` 的人工接受风险含义；Worker 不能把 override 或旧的人工 dismissal 作为绕过独立验证的自动化出口。
- 不新增长期常驻的 LLM 监听/轮询服务；ReviewLoop 的事件驱动等待属于后续独立任务。
- 不为了该功能重新设计 PR Bot 整套会话存储、线程系统或最终审查。

## 5. 可观察验收条件（全局 AC）

**AC-01 有效但错误的反驳：** 一个已审 HEAD 上真实阻塞中的 finding，在提交格式正确、但技术上不成立的 dismiss 后，Bot 实际进行独立判断；该 finding 仍 OPEN，当前 HEAD 不会因此 READY，原 Review Thread 有包含具体理由的 Bot 回复（无原 Thread 则 PR 讨论区标注 finding ID）。

**AC-02 有效且正确的反驳：** 同样的流程中，Bot 从代码与证据确认是误报，记录独立结论并把对应 finding 置为 DISMISSED；只解决该 finding，其他 OPEN/UNCERTAIN 不受影响；原 Bot Thread 成功 Resolve 时可在 GitHub 直接观察，否则明确记录同步失败。

**AC-03 最后一个阻塞 finding：** 当独立验证通过且没有其他阻塞 finding 时，沿用已有 final audit / READY 契约：尚需审计则继续 AUDIT_PENDING；只有已有的全部必要审查证据满足时才可能 READY。不准靠一次 dismiss 伪造 audit PASS。

**AC-04 复用与兼容：** 原有两种 dismiss 命令语法、Reason/Evidence 约束、权限校验与 P0/P1/P2/真实 P3 阻塞逻辑保持正确；降级为不阻塞的 P3 和已结案 finding 不被误判为新的有效 dismiss。

**AC-05 安全拒绝：** stale HEAD、未知 finding、权限不足、伪造/重复/格式错误的评论、恶意输入、会话状态变化时，没有无证据的状态写入、模型重复消费或错误 Thread 关闭。

**AC-06 不确定和服务故障：** 模型不可用、预算不足、超时、审查结论无效或证据不可核实时，不产生 DISMISSED / READY；结果和下一步可见且可安全恢复，不通过重置预算绕过现有阻塞。

**AC-07 一致性和幂等：** 模拟重复事件、并发两次 dismiss、等待审查期间 push/rebase 等情况，只有与当前 PR HEAD + session + finding 匹配且得到真实肯定裁决的操作能发布，并保存裁决依据；重复调用不会形成无界自动争论。

**AC-08 回归与真实证据：** 现有 PR Bot 测试、相关审查收敛与线程同步用例通过；新增肯定/否定/不确定/旧状态/并发的正反测试。部署后在真实受控 PR 上完成一次有效误报 dismiss 与一次被拒绝 dismiss 的路径验证，核对 Bot 身份、原 Thread 回复/Resolve 和当前 HEAD。不能把 mock 测试、成功 workflow 运行或评论文本当成线上已验证。

## 6. 已核实的当前事实（只读源码，不代表运行验证）

- `scripts/apply-dismissal.mjs`：当前 `applyManualDismissal` 的注释明确是 `No product-code mutation or model call`，核对 comment、写权限、会话与 HEAD 后直接调用 `applyFindingDismissal`。
- `scripts/review-session-core.mjs`：`applyFindingDismissal` 会把符合条件的 finding 直接标记为 `DISMISSED`，并根据剩余问题和 `auditCompleted` 更新会话状态；当前 `MAX_VERIFICATION_ROUNDS = 2`。
- `scripts/sync-review-threads.mjs`：已有按 `FIXED/DISMISSED/WAIVED` 关闭 Bot Thread 的逻辑和显式失败报告。
- `scripts/plan-review-session.mjs`：已有 `dismiss` 命令路由、可信会话寻找、rebase 后审查处理和基于 HEAD 的判断。
- `worker/src/review-trigger.js`：已有 `@gemini dismiss F001` 与完整 Reason/Evidence 格式解析；普通 push 不自动触发新模型审查。
- `tests/review-dismissal.test.mjs`：已有用例将人工 dismissal 视作直接生效，后续实施必须更新/补充这些测试，不能沿用旧预期。
- 基线：`adc8d117a6d2b868ef21ed2052301ad9e108727f`。源码阅读不等于已运行测试、已部署或已完成实际 PR 验证。

## 7. 已确认的决定、未知项与依赖

**已确认：** 沿用 dismiss 命令；每个有效 dismiss 都必须由 Bot 独立验证；通过就关闭问题，拒绝就在原 Thread 说明原因；不增加 challenge；保持 ReviewLoop PR Task 为后续独立项目。

**待 Design 核实：** 如何在现有模型运行与审查状态中实现最小的单 finding 裁决、如何绑定/计费和防止重复审查、是否能从现有 GitHub 权限读取全部必要证据，以及如何可靠地回复原 Thread。Design 必须比较最小复用路线和必要替代路线；对确需扩权限、无法验证外部证据或与原有 `HUMAN_REQUIRED` 冲突的事项应停下提交用户决定，不能自行削弱 AC。

**依赖状态：** pr-bot 现有命令、会话、线程操作、reviewer 路径已在源码中确认存在；独立 Dismiss 验证目前缺失；真实线上行为和权限仍待实测。

## 8. 授权与阶段边界

| 操作 | 本次授权 |
| --- | --- |
| 只读核查、编写完整 Plan | 已授权 |
| 新建任务分支、写入 Plan.md、commit、push、创建 Draft PR | 已授权（仅 Plan 阶段材料） |
| 开始 Design、修改设计文件、独立审查 | **等用户明确说 Design** |
| 修改 Bot 生产代码、更新测试、commit/push 代码 | **等用户明确说 Code 并确定具体权限** |
| Merge、线上部署 | 未授权 |
| 修改凭据、GitHub App 权限、破坏数据 | 未授权 |

每个阶段保留 `policy_sha`，由本地 Agent 按当前 ReviewLoop Worker Contract 执行对应独立审查。Design PASS 只代表设计已审，不代表 Code 授权。本任务在 Plan 完成后停止；已有 pr-bot 的强制审查及 CI 仍是独立关口。

## 9. 交付与完成报告

本 Draft PR 的唯一完整需求合同为 `Plan.md` v1.0（冻结后变更必须重新确认）。PR 描述顶部只放给用户的 Brief、验收勾选项和授权界限，Design 以本文件全文为准。Code 后需报告真实审查与部署/运行的证据、HEAD、finding ID、事件/模型调用是否实际发生、线程结果、预算及未验证项。
