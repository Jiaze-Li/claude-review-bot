# Design — RB-REBASE-BASELINE-01：PR 历史改写后的审查基线恢复

- **Task**：`RB-REBASE-BASELINE-01` · **Plan**：`v1.0`（冻结，PR #86 上 `Plan.md` @ `6f87fc6`）· **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查基线**：Bot `main` = `bde9656f447d500764579dabaa2869774157ff72`（任务分支 `6f87fc6` = main + Plan.md）
- **阶段**：Design。本文件不改代码；Code 阶段只用文末 Work Contract。

## 1. 目标 / 范围 / 非目标

**目标**：PR 历史被改写（rebase / force-push / 合并目标分支进 PR 分支 / 改 base）后，Bot 对“修复验证（verification）”不再使用失效的“旧审查 HEAD → 新 HEAD”两点 diff，而改用**当前 PR 相对目标分支的真实改动**，既不因无关历史撑爆 staged 上限，也不丢失/误关旧 Finding。

**范围**：仅 planner 对 `verification` 决策的范围选择（含手动重试 provider-unavailable 的 verification 与线程解决触发的 verification）。
**非目标**（沿用 Plan §5）：不改 incremental 分类器；不改 Finding/READY 权威（`seedSession` 仅增加一个默认关闭的 `carryOpen` 选项）；不调 20-shard 上限、预算、模型；不 rebase/push/merge；不改 `.reviewbotignore`；不新增 session 权威。

## 2. 已核实事实（文件:行 + 摘录；Reviewer 无法读仓库，以此为准）

F1. 当前 PR 范围已被正确构造，且先于 planner 执行：`.github/workflows/review-v2.yml:242-252` — `merge_base="$(gh api "repos/${TARGET_REPO}/compare/${BASE_SHA}...${HEAD_SHA}" --jq '.merge_base_commit.sha')"` … `printf '%s\n' "$merge_base" > .review-context/merge-base.txt` … `git -C target diff --no-ext-diff --no-textconv --unified=80 "$merge_base" "$HEAD_SHA" > .review-context/pr.diff`。base 来自该 PR 的 `baseRefOid`（:236-240，base 与 head 任一移动即 fail），不写死 main。Plan 步骤 `Plan durable review session`（:266 起）排在其后。
F2. 缺陷点：`.github/workflows/review-v2.yml:303` — `git -C target diff --no-ext-diff --no-textconv --unified=80 "$PREVIOUS_HEAD" "$HEAD_SHA" > .review-context/repair.diff`（verification/incremental 步骤，:283 条件）。同步骤 `:292-294`：`if [[ -f .review-context/repair.diff ]]; then echo "Incremental delta already prepared by scope classifier."; exit 0` —— **已有 repair.diff 时整步跳过**。
F3. 旧会话在 REWORK 时必走 verification：`scripts/review-session-core.mjs:91-99` — `if (session.status === 'REWORK') { if (session.lastReviewedHead === headSha) return noop_waiting…; if (verificationRound >= MAX_VERIFICATION_ROUNDS) return human_required…; return { mode: 'verification', previousHead: session.lastReviewedHead, … } }`。READY 且 HEAD 变化 → `incremental_candidate`（:86-87）；AUDIT_PENDING 且 HEAD 变化 → `full_review`（:72）；PARTIAL 且 HEAD 变化 → `full_review`（:106-108）。HUMAN_REQUIRED 手动重试 verification 同样产生 `mode:'verification'`（:130-131）。
F4. `verification` 决策有三处来源，planner 有两个出口：`scripts/plan-review-session.mjs:130` `let decision=planReviewSession(...)`；`:82` threads 路径 `decision={...planned,reason:…}`（planned.mode==='verification'）直接 return，不经 CLI 尾部；CLI 尾部 `:205-223` 仅对 `plan.decision.mode === 'incremental_candidate'` 调 `prepareIncrementalDelta` 并改写 `plan.decision`，随后写 `session-plan.json` 与 `GITHUB_OUTPUT`（mode/previous_head/reason，:224-233）。`planSession()` 本身是可注入 `fetchImpl` 的纯函数，测试已用 `fetchState()` 假 GitHub（`tests/review-session-planner.test.mjs:17-25`）。
F5. incremental 路径对“树比较”有明确既有合同：`scripts/select-incremental-review.mjs:108` `// A comparison of exact trees covers even force-pushes or rebases: no ancestry assumption is needed.`，且 `classifyIncrementalDelta` 限 3 文件/50 行/150 KB（:6-9），超限即 `full(...)`；取不到旧 SHA → `full('prior SHA or exact delta unavailable')`（:139）。→ READY 后的 rebase 已走全量/小树差，本设计**不触碰**。
F6. staged runner 的容量判定：`scripts/run-gemini-review.mjs:156` `const diff=dropIgnoredFiles(rawDiff, …ignore-patterns.txt…)`；`:185` `if(Buffer.byteLength(diff,'utf8')+fixedBytes<=SINGLE_REQUEST_MAX_BYTES){ return reviewPart(...) }`（`:123` `SINGLE_REQUEST_MAX_BYTES=300_000`）；否则 `:189-191` `const chunks=splitDiffByFile(diff); const {shards:parts,deferred}=planShards({files,chunks}); if(deferred.length||!parts.length) throw new Error('The ${mode} diff spans too many parts (…)')`。`review-shards.mjs:4-5` `SHARD_TARGET_BYTES = 100_000; MAX_SHARDS = 20`；`planShards` 在 `:146`，`deferred` 即超出 20 片者。`fixedBytes`（:184）= `pr.json` + `JSON.stringify(session)` + risk-profile 的字节数。runner 读的文件名由 mode 决定：`:151` `diffName = ['verification','incremental'].includes(mode) ? 'repair.diff' : 'pr.diff'`。
F7. **全量审查会丢旧 OPEN Finding**：`scripts/review-session-core.mjs:426` `if (!session || session.lastReviewedHead !== headSha) session = seedSession(...)`；`seedSession`（:396-410）只携带 `unresolvedMaterialFindings(previous)`（定义 :825-827：仅 `status==='UNCERTAIN'` 且 blocking）并重编号为 `CARRIED_UNCERTAIN`；**OPEN 的 Finding 不被携带**。因此“REWORK 会话 + 新 HEAD → 全量 sharded 审查”会让旧 OPEN 无声消失，违反 R4/AC5。`completeDeepReview`（:460+）对同 HEAD 会话保留既有 findings，只追加新发现，不核实旧的。
F8. 可闭合旧 OPEN 的唯一机制是 verification：`applyVerificationResult`（`review-session-core.mjs:242-314`）：verifier 漏报某 OPEN → 保持 OPEN 并写 `resolutionReason: 'Verifier omitted this open finding; kept open fail-closed.'`；仅显式 `FIXED` 才关闭；`open.length===0` 时若仍有 UNCERTAIN → `HUMAN_REQUIRED`，否则仅 `session.auditCompleted===true` 才 `READY`，否则 `AUDIT_PENDING`；轮次达 `MAX_VERIFICATION_ROUNDS=2`（:9）仍有 OPEN → `HUMAN_REQUIRED`。runner 使用 `normalizeVerificationResult`（`run-gemini-review.mjs:545` 起）。
F9. 已有“用 GitHub compare API 判祖先/领先”的先例：`scripts/apply-stale.mjs:35` `compare/${session.lastReviewedHead}...${headSha}`，读 `ahead_by`；`rest()` 对非 2xx 抛 `GitHub API failed (HTTP n)`（:48-53）。workflow 的 `merge_base_commit.sha` 用法见 F1。
F10. `human_required` 是既有 mode：`review-status.mjs:14-17` 列入 `reviewModes`，runner 步骤均按 `steps.plan.outputs.mode` 条件执行，`human_required` 不匹配任何模型步骤（零模型花费）；原因通过 `REVIEW_REASON` 写入评论（`review-status.mjs:189`，`safeReason`）。`HUMAN_REQUIRED` 会话的既有人工出口是 dismiss/override（`plan-review-session.mjs:113-128`）。
F11. 全量审查的 begin 入口：`scripts/deep-review.mjs:32` `if (ctx.plan.decision?.mode !== 'claude') throw …`；`:62-63` `const session = beginDeepReview({ session: ctx.plan.session, baseSha: ctx.baseSha, headSha: ctx.headSha, runId: …` ；`:158` `plan: JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'))`——即 begin 读取 planner 写出的 `session-plan.json`，decision 附加字段可原样取到。`completeDeepReview` 在 `review-session-core.mjs:505` 有 `: unresolvedMaterialFindings(session).length > 0 ? 'HUMAN_REQUIRED'`（OPEN 为 0 时，存在 blocking UNCERTAIN 即 HUMAN_REQUIRED）。既有人工出口：`plan-review-session.mjs:114-115` dismiss 对 `HUMAN_REQUIRED` 且含 `OPEN/UNCERTAIN` 的会话开放。

## 3. 根因（与现场对应）

SpinLab#195：旧审查 HEAD 与新 HEAD 分叉，两点 diff 涵盖 204 个文件，而 PR 实际 11 个文件（Plan §3）。F2 把两点 diff 当 verification 范围；F6 的容量判定对其失败。对“旧 HEAD 仍是祖先、且 PR 的合并基点未变”的普通修复，两点 diff 正好等于“修复增量”，是正确的；其余情形（分叉、合并了目标分支、改 base）两点 diff 混入无关历史。

## 4. Options

**A（采纳为“装得下”分支）：历史改写时，把 verification 的范围换成“当前 PR 相对其目标分支的完整 diff”，仍走既有 verification 流水线。**
planner 判定“旧基线不可用”→ 把 `.review-context/pr.diff`（F1，已有且可信）作为 `repair.diff` 写出（F2 的跳过逻辑天然生效，workflow 无需改）→ 决策仍为 `verification`，旧 OPEN 逐条经 verifier 判 FIXED/STILL_OPEN/UNCERTAIN（F8），漏报即保持 OPEN。理由：唯一能**实质核实并合法关闭**旧 Finding 的既有路径（F8）；复用全部现有预算/状态/发布逻辑；改动面仅 planner。
**B：历史改写时一律改走 full sharded review，并让 deep review 逐条核实旧 OPEN。** 否决：F7——需改 deep-review 提示/schema/`mergeShardResults` 与会话写入路径，触及 Finding 权威，违反“不新增权威/不大改”。
**B'（采纳为“装不下”分支）：改走 full sharded review，但旧 OPEN 只**携带为 `UNCERTAIN`（待确认）、不在审查内核实**。** `seedSession` 已有 UNCERTAIN 携带机制（F7）与对应的 HUMAN_REQUIRED/dismiss 出口（F8、F10），只需让它在 planner 明确要求时也携带 OPEN——小而局部，不新增核实路径。
**C：reset 会话 / 提高 20 片上限 / 加 `.reviewbotignore`。** 否决：Plan §5/R8 明令禁止，且丢 Finding。
**D：在 workflow shell 里判断（`git merge-base --is-ancestor`）。** 否决：checkout 是 `fetch-depth: 1`（`review-v2.yml:220`），本地没有历史，无法可靠判祖先；且判定应在 planner 内以便单测。

## 5. Assumptions（Plan 没说，我默认的前提，大白话）

1. **（用户已确认）** 与 Plan AC2 字面的差异：带未关闭问题的旧会话，历史改写后——当前 PR 改动**装得下**一次 staged 审查 → 对当前 PR 全部改动做修复验证（只有显式 `FIXED` 才关闭旧问题；验证通过后系统仍会走既有的完整审查才可能 READY）；**装不下** → 不停下，改走既有分片全量审查（含 continuation），旧未关闭问题携带为“待确认”。无未关闭问题的旧会话（READY/AUDIT_PENDING/PARTIAL）行为不变。
2. **（用户已确认）** 携带为“待确认”的旧问题继续挡住变绿，直到被人确认（既有 dismiss）或在后续既有流程中被明确核实；分片全量审查**不**自动关闭它们。代价：这类 PR 的审查结果最终为 `HUMAN_REQUIRED`（旧问题待人确认），不会 READY；这是有意的，换取“旧问题不会悄悄消失”。
3. 把“合并了目标分支进 PR 分支”也算历史改写（两点 diff 同样会混入目标分支的无关改动）。
4. GitHub compare 接口对已被 force-push 掉、不可达的旧 SHA 返回 404/422——按“旧基线不可用”处理；其他错误（5xx/超时/限流）则让规划步骤失败（零模型花费、可重试），不猜。此行为在 Code 阶段用假 GitHub 响应测试固定；真实接口行为不在本设计内宣称已验证。
5. 被改写后的验证仍计入既有的 2 轮验证预算（不为改写另开额外轮次）。

## 6. 设计

### 6.1 新判定（planner 内，仅对 `decision.mode==='verification'` 且有 `previousHead` 时）

`classifyReviewBaseline({ previousHead, headSha, baseSha, mergeBaseNow, fetchImpl, token, target })` → `{ kind: 'delta' | 'rewritten', reason }`：
- 取 `mergeBaseNow` = 读 `.review-context/merge-base.txt`（F1，当前 PR 的合并基点）；缺失/非 40 位 SHA → 抛错（不猜）。
- 调 `GET compare/{previousHead}...{headSha}`：`status==='ahead'`（或 `identical`）才说明旧 HEAD 是新 HEAD 的祖先；`diverged`/`behind` → `rewritten`；404/422 → `rewritten`（旧提交不可达）；其他错误 → 抛错。
- 祖先成立时再调 `GET compare/{baseSha}...{previousHead}` 取 `merge_base_commit.sha` = `mergeBaseOld`。`mergeBaseOld === mergeBaseNow` → `delta`（普通修复，沿用原两点 diff，AC3）；不等（PR 合并了目标分支、或改了 base）→ `rewritten`。
- 仅目标分支前进而 PR HEAD 未动：此时无新 HEAD，F3 已 `noop_*`；PR 分支新增提交但没合并目标分支：两侧合并基点相同 → `delta`（AC7）。

### 6.2 `rewritten` 的处理（唯一写入点：CLI 尾部，与 `incremental_candidate` 同位；threads 路径 `:82` 同样经过共用函数）

1. 读 `pr.diff`（F1）→ `dropIgnoredFiles`（用同一 `ignore-patterns.txt`，来源是 PR base，F1 注释 `:255-257`）→ 用与 runner **同一份**容量判定（把 F6 的“单次装下 或 `planShards` 无 deferred”抽成 `review-shards.mjs`/共享函数，runner 与 planner 共用，避免漂移；`fixedBytes` 用 planner 手上已有的 `session` 与 `pr.json`、`risk-profile.json` 估算，估算取上界）。
2. **装得下**：把 `pr.diff` 原样写成 `.review-context/repair.diff`（0600）；决策 `{ mode:'verification', previousHead, scope:'current-pr', reason:'PR history was rewritten since the last review (…); verifying open findings against the whole current PR diff (<N> files, base <base7>, head <head7>)' }`。`previousHead` 保留作溯源，不再用于取 diff。
3. **装不下**：决策 `{ mode:'claude'（即 `fullReviewDecision`）, previousHead:null, carryOpen:true, reason:'PR history was rewritten and the whole current PR diff is too large for one verification; reviewing every file in shards instead. Earlier open findings are carried as "needs confirmation": they keep blocking until a person confirms them, and this review does not close them. …' }`。`carryOpen` 仅存在于 `session-plan.json` 的 decision 中，由 `deep-review.mjs` 的 begin 步骤（F11）原样传给 `beginDeepReview`→`seedSession`。
   - `seedSession` 新增可选参数 `carryOpen`（默认 false，**所有既有调用行为不变**，含 `reset`）：为 true 时，除既有的 `UNCERTAIN` 外，也携带 blocking 的 `OPEN`，统一以 `status:'UNCERTAIN'`、`origin:'CARRIED_OPEN'` 记入，保留 `path/line/title/body/severity/riskClass/introducedHead`，并新增一个短字段 `carriedFromId`（原 Finding ID）以保证可追溯。携带上限沿用既有 8 条；**超过 8 条阻塞问题则不得截断**——planner 改为 `human_required`（零花费、会话不变、说明数量）。
   - 分片审查对携带条目不作核实；`completeDeepReview` 既有规则（:505）使存在 blocking UNCERTAIN 时结果为 `HUMAN_REQUIRED`，不会 READY；新发现的问题照常追加。coverage 不完整时的 `PARTIAL`/continuation 按既有语义（`HUMAN_REQUIRED` 优先于 `PARTIAL` 的既有顺序不变，但 coverage 仍如实展示未覆盖文件）。
   - 线程：携带条目沿用原 `path/title` 标记以便同一问题不重复发帖；不新增 resolve 路径（见 6.3）。
4. 判定本身出错（缺 merge-base、compare 5xx）→ 规划步骤抛错，沿用现状的失败语义（run 失败/status error，零花费，可重试）。

### 6.3 Finding / READY 不变量如何保持
- 不改 `applyVerificationResult` / `completeDeepReview`；`seedSession` 仅增加一个默认关闭的 `carryOpen` 选项（6.2）。装得下分支：旧 OPEN 只有 verifier 显式 `FIXED` 才关闭，漏报保持 OPEN（F8）；UNCERTAIN 仍使 `HUMAN_REQUIRED`；READY 仍要求 `auditCompleted===true`。装不下分支：旧 OPEN 变为携带的 UNCERTAIN，全量审查不关闭它们，结果为 `HUMAN_REQUIRED`。
- 对**同一 HEAD** 的重复触发：F3 的 `noop_waiting` 不变（不花钱）。验证完成后 `lastReviewedHead=HEAD`，与普通 verification 一致，故 continuation/recover/stale 逻辑无需改。
- 线程：不新增任何 resolve 路径；`sync-review-threads` 仍只按验证结果处理。

### 6.4 用户可见信息（AC8）
`reason` 经 `REVIEW_REASON` 进评论（F10）；会话评论已展示 Mode/HEAD。reason 包含：为何改写（分叉/合并了目标分支/旧提交已不可达）、审查范围（当前 PR 相对 `<base7>` 的 N 个文件）、旧问题如何处理（装得下：逐条核实；装不下：携带为“待确认”，由人确认）、下一步（待确认时：说明用既有 dismiss 逐条处理）。不得出现“忽略测试文件”之类建议。

## 7. 不变量
I1. `delta` 与 `rewritten` 互斥且穷尽；`delta` 路径输出与改动前逐字节一致（AC3/AC4）。
I2. 任何 `rewritten` 结果都不会关闭或丢弃任何 Finding：装得下 → 只有 verifier 的显式 `FIXED` 经既有函数关闭；装不下 → 旧 OPEN 全部以 `UNCERTAIN`（保留原 ID 于 `carriedFromId`）携带，不被自动关闭。
I3. `rewritten` 且 staged 装不下 → 走分片全量审查（既有 coverage/continuation 语义，不截断、不略过文件）；携带的旧问题 >8 条 → `human_required`（不调用模型、不丢条目）；任何情形都不得 READY 而无视携带问题。
I7. `carryOpen` 默认关闭；`reset`、普通新会话、既有 full_review 路径的会话内容与改动前逐字节一致。
I4. 判定失败（无法确定）不降级为 `delta`；只会抛错或 `rewritten`。
I5. 不执行任何会修改被审查仓库的 git/GitHub 写操作；只读 `compare` 与本地已有文件（R6）。
I6. 同一 HEAD 的重复触发不产生新的模型调用。

## 8. 声明 → 失效方式 → 证据（Code 阶段测试）

| # | 声明 | 可能失效 | 证据（确定性测试，假 `fetchImpl` + 临时 `.review-context`） |
|---|---|---|---|
| T1 | 分叉场景旧逻辑会把无关历史带入（AC1） | 夹具不足以证明 | 构造“旧 HEAD 与新 HEAD 分叉、两点 diff 含 ≥ 21 个分片文件，而 PR 自身 diff 仅 11 个文件”的 `pr.diff`/模拟两点 diff，断言：改动前路径下 `planShards` 的 `deferred.length>0`（复现 20+）；用真实 `planShards`，不 mock |
| T2 | 分叉→改用当前 PR diff，装得下时仍是 verification（AC2/AC5） | repair.diff 写错/仍含无关文件 | 断言 `decision.mode==='verification'`、`repair.diff` 与 `pr.diff` 逐字节相等、reason 含 base7/head7/文件数；且 session 的 OPEN Finding 原样保留 |
| T3 | 普通修复（祖先且合并基点相同）行为不变（AC3） | 误判 rewritten | compare 返回 `ahead` 且两侧合并基点相同 → `verification`，`repair.diff` 不由 planner 写出（交给 workflow 原步骤），输出与旧版快照一致 |
| T4 | 合并了目标分支（祖先但合并基点不同）→ rewritten | 漏判 | 两侧合并基点不同 → 走 6.2 |
| T5 | 仅目标分支前进、PR 分支只新增提交 → 仍 delta（AC7） | 误判 | base 前进但两侧 `merge_base` 相同 → `delta` |
| T6 | 旧 SHA 不可达（404/422）→ rewritten；5xx/超时 → 抛错，不降级（AC6/I4） | 误降级为 delta | 假响应分别断言 |
| T7 | 装不下 → 分片全量审查，旧 OPEN 携带为 UNCERTAIN（AC2/AC5/AC6） | 旧问题丢失 / 被关闭 / READY | 生成 >20 分片的 `pr.diff`（真实 `planShards`），断言 decision `mode:'claude'`、`carryOpen:true`、reason 清楚；经 `beginDeepReview`+`completeDeepReview`（mock provider 返回 0 新发现）后：旧 F001 以 `UNCERTAIN`/`CARRIED_OPEN`/`carriedFromId:'F001'` 存在，会话 `HUMAN_REQUIRED`，不是 READY；coverage 如实 |
| T7b | 携带上限 | 超 8 条被截断丢失 | 9 条阻塞 OPEN → planner 返回 `human_required`，会话不变，无模型调用 |
| T7c | `carryOpen` 默认关闭（I7） | 影响 reset/既有路径 | 不带 `carryOpen` 调 `seedSession`/`beginDeepReview`：与改动前快照逐字节一致；`reset` 路径仍丢 OPEN（既有行为） |
| T8 | 共享容量判定与 runner 一致（防漂移） | 两处各算各的 | 同一份 diff 同时喂 runner 判定函数与 planner，结论一致；`run-gemini-review` 既有测试全绿 |
| T9 | 非 main 目标分支 / threads 路径 / 手动重试 verification 路径均走同一判定（R1） | 漏路径 | base 用非 main SHA 的 `BASE_SHA`；threads 与 retry 入口各一条用例 |
| T10 | 端到端模拟 SpinLab#195（AC9） | 与真实不符 | 以 Plan §3 的 SHA/文件数缩小还原的夹具：REWORK 会话（F001 OPEN）+ 分叉 + 11 文件 PR diff → `verification`；用 mock provider 返回 `FIXED`/`STILL_OPEN` 分别断言 Finding 状态、会话 status，且不出现 `READY` 越权 |
| T11 | 既有回归全绿 | 回归 | `npm test` 全量通过（planner、incremental、verification、sharding、convergence、status、budget） |
| — | **真实 PR#195 付费复测** | — | **不在 Code 内；需你另行授权，不标 PASS**（Plan §8） |

## 9. 失败 / 恢复边界
- 判定阶段无状态副作用（只写 `session-plan.json` 与 `repair.diff` 于临时 context 目录）；规划失败可原样重跑。
- 验证阶段的失败、provider 不可用、预算：完全沿用既有路径（`stop-unavailable-review`、`reviewFailure`、手动重试，F3 `:122-138`）。重试时 `reviewFailure.previousHead` 仍是旧值，再次经同一判定，结果一致、不叠加花费。
- 旧会话与新逻辑兼容：不新增、不重命名任何会话字段（`scope` 只存在于 planner 输出的 decision，不写入会话）。

## 10. 最小实现顺序（Code）
1. 把 F6 的容量判定抽成共享纯函数，runner 改用它（行为不变，先过既有测试）。
2. 新增 `classifyReviewBaseline`（planner 内，注入 `fetchImpl`）。
3. CLI 尾部与 threads 出口接入 6.2：`verification+repair.diff`、`claude+carryOpen`、`human_required(>8)` 三个分支；`deep-review.mjs` 透传 `carryOpen`；`seedSession` 增加 `carryOpen`。
4. 测试 T1–T11（含 T7/T7b/T7c）；文档（`docs/` 简述该行为）与 README 一句话。

## 11. 人工关口与授权草案（逐项；未列出视为未授权）
| 操作 | 本设计建议的授权 |
|---|---|
| 修改 Bot 实现与测试（`scripts/`、`tests/`、`docs/`；含 `seedSession` 的 `carryOpen` 选项与 `deep-review.mjs` 透传；不动 `.github/workflows` 除非 Code 阶段证明必需，且需先回报） | **待你说“Code”时授权**，仅限本任务分支 `fix/rebase-aware-review-baseline` |
| commit / push 到该分支 | 建议随“Code”一并授权，仅限上述文件 |
| 将 PR #86 标记 Ready / merge / 部署 | **不授权** |
| 触发消耗额度的 PR#195 真实复测 | **不授权**，需你单独说 |
| 修改 SpinLab、权限、凭据、模型/费用/超时 | **不授权** |

人工关口：Assumption 1、2 已由用户确认（见 §5）；Code 阶段若发现必须改 workflow、`completeDeepReview`/`applyVerificationResult` 或超出 `carryOpen` 的 `seedSession` 改动，先停下回报。

## 12. Work Contract（Code 阶段直接使用）

**可观察结果**
- PR 历史被改写（分叉 / 合并了目标分支 / 改 base / 旧提交不可达）且存在待核实的旧问题时：
  - 当前 PR 改动装得下一次 staged 审查 → 对**当前 PR 相对其目标分支的完整 diff**做 verification，旧 OPEN 逐条核实；
  - 装不下 → 改走既有分片全量审查（含 continuation），旧未关闭问题携带为“待确认”继续挡住变绿（结果 `HUMAN_REQUIRED`，由人用既有 dismiss 处理）；携带的阻塞问题超过 8 条则停在需要人工（零模型花费）。
- 普通修复（旧 HEAD 是祖先且合并基点未变）、READY 后增量、无未关问题的会话（READY/AUDIT_PENDING/PARTIAL）的行为与改动前**逐项一致**。

**必需不变量**：I1–I7（§7）。
**边界**：只改 planner、共享容量判定、`deep-review.mjs` 的 `carryOpen` 透传与 `seedSession` 的默认关闭 `carryOpen` 选项（及其测试/文档）；不改 `applyVerificationResult`/`completeDeepReview`/`classifyIncrementalDelta`；不改预算/模型/20 片上限/超时；不新增会话字段；不写被审查仓库；无新增 `.github/workflows` 变更（如证明必需，先回报用户）。

**全局 AC**：继承 Plan §6 的 AC1–AC9，并以 §8 的 T1–T11 作为逐项证据；AC9 的“真实 PR#195 付费复测”明确**不属于 Code**。

**验证与证据**：`npm test` 全量通过（输出贴入 review 证据）；T1–T10 为新增确定性测试，各含正向、负向与旧数据（既有会话夹具）用例；T8 证明共享判定与 runner 一致；贴出新增测试名与通过数。

**停止条件**：需要改 workflow、`completeDeepReview`/`applyVerificationResult`、超出 `carryOpen` 的 `seedSession` 改动、预算/模型/上限，或发现 Plan 与仓库矛盾 → 停止并回报；`HUMAN_REQUIRED` → 停止；本地 PASS 后停，不自行 merge。
