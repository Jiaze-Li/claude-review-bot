# Review Bot：PR Rebase 后审查基线恢复

- **Task ID**：`RB-REBASE-BASELINE-01`
- **Plan 版本**：`v1.0`
- **阶段状态**：`PLAN_READY`；仅提交需求，尚未进入 Design / Code
- **目标仓库**：`Jiaze-Li/claude-review-bot`
- **Plan 分支起点（Bot main）**：`bde9656f447d500764579dabaa2869774157ff72`
- **冻结规范 policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`（`Jiaze-Li/personal-skills` 的 `engineering-lead/skill.md` v1.1.0）
- **问题现场**：[SpinLab PR #195 触发评论](https://github.com/Jiaze-Li/SpinLab/pull/195#issuecomment-6935682173)；[失败的 Workflow Run #44000477320](https://github.com/Jiaze-Li/claude-review-bot/actions/runs/44000477320/attempts/1)

## 1. 要解决的问题

当 PR 被 rebase、force-push，或以其他方式改写提交历史后，Review Bot 过去审查过的 commit 可能已不属于当前 PR HEAD 的祖先历史。这时若继续将“旧审查 commit → 新 HEAD”的差异视为普通修复差异（verification diff），就可能把与当前 PR 无关的大量历史变更纳入审查，触发单次 staged review 上限，并在模型实际审查前失败。

**目标结果**：Bot 能理解 PR 当前的目标分支及 HEAD，自动选择与**当前 PR 实际提出的变更**对应的可信审查范围，完整而受限地完成审查，同时保留历史 Findings、状态及安全门槛。不要求用户重新 rebase、隐藏相关测试文件，或通过 reset/override 规避失败。

**关键边界**：Bot 只读取 PR base/HEAD 和历史；**绝不替用户执行 `git rebase`、修改目标 PR 分支或 push**。PR 的目标分支可能是 `main`，也可能是其他分支，不写死 `main`。

## 2. 用户与失败代价

- **直接用户**：PR 作者、维护者；典型操作是在修复或 rebase 后输入 `@gemini review` / `@claude review`。
- **下游消费者**：依赖 `READY`、`REWORK`、`PARTIAL`、`HUMAN_REQUIRED`、review threads 和 required commit status 的仓库维护者及合并规则。
- **失败代价**：PR 无法完成独立审查，可能浪费模型额度并诱导用户忽略必要的测试文件；更严重的是无证据误判 `READY`，或自动关闭尚未核实的 P1/P2/P3 Finding/thread。

## 3. 已核实的事实（均为只读调查，不是测试 PASS）

1. 调查时 `SpinLab#195` 的 HEAD 为 `051633ee4a89e075300cb284c6d991340da579ec`，base 为 `main`（SHA `42215137d14712b91449ba41915c5b35786e8df0`），GitHub PR Diff 涉及 **11 个文件**。
2. Bot 的旧审查 HEAD 为 `01e19d823829fbf5f6bf6b224fd95e861e0ceaea`。两者历史**分叉**：当前侧领先 151 commits，旧侧仍有 5 commits；两个快照比较涉及 **204 个文件**，并非此 PR 实际提出的 11 个文件。
3. [Run #44000477320](https://github.com/Jiaze-Li/claude-review-bot/actions/runs/44000477320/attempts/1) 进入 `verification`，执行 `git diff --no-ext-diff --no-textconv --unified=80 "$PREVIOUS_HEAD" "$HEAD_SHA"`，随后在 staged runner 处出现 `The verification diff spans too many parts (20+)` 并以 exit code 1 结束；**模型没有完成本次审查**，required commit status 为 `error`。
4. 2026-11-16 的 Run `43900292889` 同样失败。旧 Session 中存在待处理 Finding，不能靠清空账本直接获得绿色结果。
5. Bot 已具备 Full Sharded Review、Verification、Incremental、持久化 Session、Finding ledger、Provider fallback、coverage 及 continuation；应优先复用，避免建立平行审查系统。

**未核实**：旧 Finding F001 在最新 SpinLab HEAD 上是否真正修复，以及 SpinLab#195 是否可合并。作者描述不替代独立审查证据。

## 4. 需求（完整 Plan，不锁死实现路线）

**R1 — 正确的事实来源。** 读取当前 PR base/HEAD；Full Review 针对当前 PR 相对目标分支提出的实际改动。不能拿 Bot 自身 `main`、开发者本地分支或已失效的历史审查 commit 代替当前 PR base；支持非 `main` 目标分支。

**R2 — 区分普通修复和历史改写。** 若上次审查的 HEAD 仍在当前 HEAD 祖先历史中，且符合原 delta 条件，保持既有 verification/incremental 行为；若旧基线已失去适用性，不得继续将跨分叉的 diff 当作普通 staged delta，必须选择可信、完整的审查范围。

**R3 — 覆盖完整性。** 恢复后的审查复用现有受限 Full Sharded Review/Continuation 语义，或提供同等完整性保证；不得截断、静默略过需要审核的源码/测试、因 shard 上限直接 `READY`。未覆盖的文件必须如实呈现 `PARTIAL` 或失败状态。

**R4 — Finding 守恒。** 原 Finding ID、证据、状态、出处保持可追溯。旧的 `OPEN` / `UNCERTAIN` 必须在当前代码上得到实质核实，或继续阻塞/等待人工判断；不能仅因 commit 消失或审查模式切换，自动改成 `FIXED`、`DISMISSED`、`WAIVED`，也不能自动 resolve thread。对于已审查的重复问题，不无意义地重复发帖。

**R5 — 人工关卡不被绕开。** 已有 `HUMAN_REQUIRED`、未知执行状态、未证实的严重 Finding，不能仅因为 rebase、模式切换或新建审查记录就变成 `READY`；继续采用既有的人工决策与证据门槛。

**R6 — 被审查仓库只读。** Bot 不修改 SpinLab 等被审查仓库的代码、HEAD/base、分支、权限或正式数据；不自动 rebase、push、merge。

**R7 — 可理解、可恢复。** 输出清楚说明为何切换审查范围、审查的 base/HEAD、覆盖情况、旧 Finding 处理和下一步；未变化的 HEAD 重复触发不得无理由消耗额度或伪造审查状态。无法可靠判断历史关系时 fail closed，并说明原因。

**R8 — 兼容并受限。** 不为规避故障而简单调高 20-shard 上限、提高模型预算、放松 snapshot/provider/thread 安全防护、隐藏必须审核的测试，或重新定义状态。与既有 Session 和 continuation 兼容。

## 5. 不做什么

- 不让 Bot 替被审查 PR rebase、merge、push、修改产品代码或分支。
- 不大规模重构编排层，不新增平行 session 权威。
- 不将 `LibraryMutationSafetyTests.swift` 或必须审查的源码/测试加入 `.reviewbotignore`。
- 不借机改 Gemini/Claude 模型、费用上限、超时或凭据。
- 不处理 SpinLab#195 的业务缺陷，不将 Bot 修复等同于该 PR 已验收。
- 不自动 merge、部署、变更权限或凭据，不追溯改写旧任务的冻结合同。

## 6. 验收标准（全部满足才能判完成）

- [ ] **AC1｜故障复现。** 确定性测试复现“旧审查 HEAD 与当前 HEAD 分叉、但当前 PR Diff 较小”的场景，证明旧逻辑会将无关历史纳入 staged delta。
- [ ] **AC2｜Rebase 恢复。** 上述场景自动选择可信且覆盖完整的当前 PR Full Review/分片继续流程，不再因为无关的 20-part verification diff 而预先失败。
- [ ] **AC3｜普通修复不回归。** 旧审查 HEAD 仍是祖先时继续 verification，且覆盖原有 Open Findings；不会误升级全量。
- [ ] **AC4｜READY 后增量不回归。** 已 `READY` PR 的普通小型后继提交仍按原增量条件审查；较大/高风险 delta 仍按规则走全量。
- [ ] **AC5｜Finding 守恒。** Rebase 后旧 `OPEN` / `UNCERTAIN` 可追溯，未经当前 HEAD 的可信核实不能自动关闭或丢失；只有满足全部覆盖和 Finding 门槛才可重新 `READY`。
- [ ] **AC6｜失败安全。** 未覆盖文件、shard/provider 失败、历史无法确定、预算/分片超限或 `HUMAN_REQUIRED` 均不能误报审查完整或绿色 required status；重试/continuation 受限且可恢复。
- [ ] **AC7｜目标仓库只读。** 审查运行时不修改被审查 PR 分支；仅目标 `main` 前进、PR HEAD 未改动时，不误判为 PR 历史重写。
- [ ] **AC8｜用户信息正确。** 报告审查模式切换原因、HEAD/base、coverage、旧问题处理以及下一步，不诱导忽略必须审查的测试。
- [ ] **AC9｜真实证据。** 现有 session planner、verification、full sharding、Finding、预算、status 的回归测试通过；有端到端模拟 SpinLab#195 的测试证据。实际调用 PR#195 的付费模型作复测，需要用户另行授权，不提前标 PASS。

## 7. 已确认决定、未知前提及设计边界

### 已确认决定

- 目标是 Bot 独立修复，不改 SpinLab 业务代码。
- Bot 观察 PR 历史并确定正确审查范围，**不主动 rebase** 被审查 PR。
- 不能以跳过代码、测试、Finding 或人工关卡换取 `READY`。
- 阶段流程为 `Plan → 停 → 用户说 Design → Design/独立审查 → 停 → 用户说 Code → Code/独立审查 → 用户验收`。

### Design 阶段需要只读核实的未知事项

- 对 ancestry、base 更新、force push、历史重写及特殊拓扑的可靠判断方法。
- 旧 session、Finding ledger 与 Thread 在新的 Full Review 基线上如何继承、去重和核实；什么证据足以关闭旧 Finding。
- 已有 continuation、resume、预算逻辑的兼容边界与恢复能力。
- 如何用最小 fixture 重现 PR#195，同时保证每项 coverage 声称有证据。

若 Design 发现需要改变 Finding/`READY` 权威、历史兼容、预算、权限、任务范围等重大决定，必须交用户确认；不得在代码阶段悄然扩大。

## 8. 依赖与验证状态

| 依赖 | 当前状态 | 后续门槛 |
| --- | --- | --- |
| Bot 的当前 main 与现有测试 | **已只读核查**：`bde9656f...` | Design 确定复用点和回归范围 |
| SpinLab PR #195 失败现场 | **已只读核查**：PR 元数据、Git diff、Workflow 日志 | 自动化测试可稳定复现 |
| Finding/session 与重建审查的安全关系 | **未知，需只读审计** | Design 明确且经独立审查 |
| 对 PR #195 的真实 Gemini Review | **尚未运行** | 消耗额度前单独获授权 |

静态查看仓库不代表测试已运行；Plan 阶段所有 AC 均未宣称 PASS。

## 9. 授权范围、阶段停点与交接

| 操作 | 已明确授权的边界 |
| --- | --- |
| 准备并发布完整 Plan、PR Brief | **已授权** |
| 在 `Jiaze-Li/claude-review-bot` 新建本任务分支 | **已授权，仅本 Plan 任务** |
| 将 `Plan.md` 写入任务分支并 commit、push | **已授权，仅 Plan 文档** |
| 创建 Draft PR（不标记 Ready） | **已授权** |
| 修改 Bot 实现或测试、执行 Code | **未授权**，必须等用户明确说 `Code` 并核对写入范围 |
| 启动 Design | **未授权**，必须等用户明确说 `Design` |
| 实际触发消耗额度的 PR #195 Review | **未授权** |
| merge / deploy / 破坏性操作 / 凭据与权限变更 | **未授权** |

**交接**：Plan v1.0 是本任务冻结的完整需求；后续 Design/Code/独立 Reviewer 均使用 `policy_sha=7f01e5a3ff53ed13ba763d684a098c0989425ec4`，引用本 Draft PR 上固定版本的 Plan。PR 描述只作为 Brief，不代替 Plan。完整 Plan 已提交后，在 Plan 阶段停下，等待用户的 `Design` 指令。

**注意**：这是一个新的 Bot 修复任务，不追溯改写 SpinLab#195 的既有任务合同。
