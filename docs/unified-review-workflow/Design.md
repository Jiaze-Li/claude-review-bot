# Design: 统一审查工作流——审查事实全部落在 PR 评论/Thread（RB-UNIFIED-REVIEW-01）

- **policy_sha**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **Plan**：Plan v1.4（PR #97，分支 `plan/unified-review-workflow-20261118`，head `15fc207`），冻结，本设计不改其验收标准。
- **核查基线**：`Jiaze-Li/pr-bot` main `35c3927`（含已合并的 #96：dismiss 可跨 commit）。
- **本设计的名称约定**：下文“账本”= 仅由 PR 上可读评论按规则重建出的审查事实集合；“旧状态块”= 现有会话评论里 base64 编码的 JSON。

## 1. 目标、范围、非目标

**目标**：把唯一权威从“会话评论里的 base64 状态块”换成“PR 上人可读的 Finding 记录 + Verdict 记录 + 阶段 Handoff 记录”；修复与 dismiss 走同一核验；去掉固定验证轮数上限；逐问题计数并产生一次 REPEATED_REWORK 事件。
**范围**：状态读写层、核验层的合并、触发/幂等层。**非目标**（沿用 Plan §9）：不改模型执行/分片/预算引擎、不重做状态 UI、不迁移历史 PR、不实现自动修复。

## 2. 已核实事实（文件:行 + 原文摘录；Reviewer 无仓库访问，以此为准）

**F1 状态被编码在隐藏块里（违反 Plan §4.3）**
- `scripts/review-session-core.mjs:1337-1341`：`const json = JSON.stringify(session); if (Buffer.byteLength(json,'utf8') > 24_000) throw new Error('review session state exceeds 24KB'); return Buffer.from(json,'utf8').toString('base64url');`
- `scripts/review-session-core.mjs:1222-1233`：`parseSessionComment` 匹配 `<!-- jiaze-review-state:([A-Za-z0-9_-]+) -->` 后 base64url 解码为唯一会话状态。
- `scripts/review-session-core.mjs:52`：`const MAX_SESSION_FINDINGS = 64;`（`pruneFindingsToCap` 在超限时删除已结案问题，即旧结论会被丢弃）。
- `scripts/plan-review-session.mjs:29-40`：规划器取最新 `<!-- jiaze-review-session:v1 -->` 评论并 `parseSessionComment`，解析失败时 `throw new Error('Latest bot-authored review session comment is unreadable; refusing to discard durable state')`（已有 fail-closed 先例）。

**F2 会话评论被删除重建**
- `scripts/session-comment.mjs:30-36`：结果变化时 `post()` 新评论后 `request(.../issues/comments/${existingId}, ..., { method: 'DELETE' }, true)` 删除旧评论（旧事实随之消失，违反“评论替换不得丢事实”）。

**F3 问题身份只在状态块里；Thread 只靠哈希标记关联**
- `scripts/review-anchors.mjs:65-72`：`findingKey(path,title)` = sha1 前 10 位；`findingMarker` = `<!-- jiaze-finding:${key} -->`（隐藏 HTML 注释）。问题编号 `F001` 仅存在于状态块（`review-session-core.mjs:195-` `findingId(nextFindingNumber++)`）。
- `scripts/review-threads.mjs:7-12`：GraphQL 读取 `reviewThreads(first:100,after:$after)`，每个线程只取 `comments(first:1)`（只读第一条，读不到后续回复）；分页上限 `for (let page = 0; page < 20; page += 1)`。
- `scripts/review-threads.mjs:55-70`：`threadsByFinding` 只认“bot 开的线程且标记命中 session 中的 finding”。

**F4 两套核验、固定轮数上限**
- `scripts/review-session-core.mjs:31`：`export const MAX_VERIFICATION_ROUNDS = 2;`；`:132` `if ((session.verificationRound ?? 0) >= MAX_VERIFICATION_ROUNDS) return { mode: 'human_required', ... reason: 'verification budget exhausted' }`；`:336` 同一上限使状态变 `HUMAN_REQUIRED`。
- `scripts/review-session-core.mjs:283-300`（`applyVerificationResult`）：核验状态只有 `FIXED / STILL_OPEN / UNCERTAIN`，不含 dismiss。
- `scripts/plan-review-session.mjs:118-124`：`requested==='dismiss'` 走独立模式 `mode:'dismiss'`；`scripts/dismiss-verifier.mjs:44` `verifyDismissalWithModel`、`:240` `extractSameRepoEvidence`（证据路径经 `realpathSync` 容器检查）是单独一套。
- `scripts/review-session-core.mjs:32,785-` `MAX_DISMISS_ATTEMPTS_PER_HEAD = 2`；`dismissLedger` 存于状态块。
- `worker/src/review-trigger.js:109-119`（#96 后 `scripts/review-session-core.mjs:856-883`）：dismiss 仍要求 `Reason:`/`Evidence:` 字段、固定长度与条数。

**F5 并发/重复事件已有串行基础**
- `.github/workflows/review-v2.yml:89-95`：`concurrency: group: independent-review-${{ inputs.target_repo }}-${{ inputs.pr_number }}`、`cancel-in-progress: false`、`queue: max`（排队不丢请求）。
- `scripts/plan-review-session.mjs:118-119`：`alreadyHandled = ... session.dismissLedger.some(entry => String(entry?.commentId) === String(env.SOURCE_COMMENT_ID))`（幂等账本在状态块里）；`scripts/review-status.mjs:226` / `scripts/publish-review.mjs:191` 已写 `<!-- jiaze-review-source-comment:ID -->`（隐藏标记）。

**F6 可复用的覆盖与风险判定**
- `scripts/select-incremental-review.mjs:4-8,54-57`：`MAX_INCREMENTAL_FILES=3`、`MAX_INCREMENTAL_LINES=50`、`MAX_INCREMENTAL_REVIEWS=15`；`classifyIncrementalDelta` 要求“已完成且未 override 的 READY 审计”，否则 `full('...')`；另有 `if (session.findings.length > 48 || Buffer.byteLength(JSON.stringify(session),'utf8') > 16_000) return full('durable finding ledger is nearing its size limit')`（这条会随状态块消失）。
- `scripts/select-incremental-review.mjs:10` `HIGH_RISK_PATH`（`.github/`、`migrations?/`、`auth…/`、`security/` 等）与 `scripts/detect-review-risk.mjs` 的 synchronization/durableState/multiActor 信号：现成的“哪些改动使终审失效”判据。
- `scripts/review-session-core.mjs:70-76`：`DEEP_REVIEW_STALE_MS = 20*60*1000`；`:40-46` 预算常量（run $2 / manual $5 / PR $6）。

**F7 触发面**
- `worker/src/index.js:55-73`：只处理 `issue_comment`、`pull_request_review_thread`、`pull_request` 事件；没有 `pull_request_review_comment`。`worker/src/review-trigger.js:parseReviewTrigger` 仅看评论**第一个非空行**（`@gemini review|dismiss F###`…）。

**F8 GitHub 读写面（本次实测，只读）**
- 对 PR #97 执行 GraphQL：`comments{nodes{databaseId lastEditedAt includesCreatedEdit minimizedReason editor{login} author{login __typename}}}`、`reviews{nodes{… lastEditedAt editor{login} author{login __typename} body}}`、`reviewThreads{nodes{id comments(first:2){pageInfo{hasNextPage} nodes{databaseId lastEditedAt editor{login} minimizedReason}}}}` **全部被接受（无 schema 错误）**。结论：可以读到评论是否被编辑、被谁编辑、是否被折叠，可以对线程内评论分页。
- `scripts/github-review-api.mjs:6` `REVIEW_BODY_MAX_BYTES = 60000`；`scripts/review-threads.mjs:34-` `replyToThread` 使用 `POST /pulls/{n}/comments/{id}/replies`。
- 已实测 CI：PR #97 当前 `test` 失败，原因是 `tests/review-trigger.test.mjs:407-419` “V7: legacy spike and root plan/design files are removed” 断言根目录 `Plan.md` 必须不存在，而本任务分支按流程把 `Plan.md` 放在根目录。与本设计无关，但 Code 阶段必须先处理（见 §9）。

## 3. Options

**A（否决）：保留会话评论为权威，只把 base64 换成折叠明文 JSON。**
优点：改动最小。否决理由：Plan §4.3 禁止“与 Thread 分离的隐藏 Session 问题账本作为第二权威”；仍有 24KB/64 条容量限制与删除重建（F2），Thread 与账本仍可相互矛盾；用户必须读 JSON 才知道一个问题的历史。

**B（选定）：评论即账本（append-only）。** 问题记录 = Thread 首条评论；核验结论 = bot 在该 Thread（或无法锚定时的独立评论）追加的 Verdict 记录；每一段审查以一份 Handoff 记录收尾；运行时从 PR 读取全部 bot 记录重建内存状态；状态评论降为“只读投影”。
理由：直接满足 Plan §4；GitHub 已提供评论/线程分页、`lastEditedAt/editor`（F8）；串行与排队已存在（F5）；不引入外部存储。

**C（否决）：账本放进仓库文件或 `docflow-state`/外部存储分支。**
否决理由：不在 PR 页面、用户看不到；需要新的写权限与凭据（Plan §12 禁止扩大权限）；违反“PR 评论区是唯一事实来源”。

**D（否决）：把问题全部改成 GitHub Review 的 Check Run/Annotations。**
否决理由：Annotations 不可回复、不可 Resolve，且没有“交接记录”的天然位置；重建 Thread 人机交互成本高。

## 4. Assumptions（未经用户确认的默认前提，大白话）

1. 仓库里有写权限的人才会手动编辑/删除 bot 的评论；bot 自己的记录**从不二次编辑**，所以“被编辑过的 bot 记录”一律当作被篡改处理并安全停止。
2. 评论被**删除**无法被检出；设计的防线是：Handoff 里列出它依据的全部问题与结论，下一段读取时对账；对不上或出现比最近 Handoff 更新的孤立记录就停止，而不是默认“没问题”。若所有 bot 记录都被删光，则视为一个全新的 PR，必须重新完整审查才可能 READY（不会因记录丢失而放行）。
3. 单条 GitHub 评论内容上限约 65,536 字符；设计按“超过 60,000 字节就拆成 `Part k/n`”处理。该上限在 Code 阶段要用真实写入验证一次。
4. 一次“修复尝试”＝同一问题在**一个新的、与上次核验不同的 HEAD** 上被核验；Worker 的无关推送若用户请求了核验，也会被计为一次尝试（宁可多计，REPEATED_REWORK 只是提醒信号，不阻断）。
5. 仍允许的“有成本的保护”（预算、20 分钟超时、Gemini 上下文上限）保持原值；去掉的是“固定 2 轮验证”和“每 HEAD 最多 2 次 dismiss 尝试”两个数字上限，后者由“相同主张去重 + 预算”替代。
6. 新增 `pull_request_review_comment` webhook（在线程里直接发命令）需要改 GitHub App 的事件订阅，属于权限变更，**本设计不依赖它**：自然语言 dismiss 的内容写在 Thread 里，由现有的 `issue_comment` 命令 `@gemini dismiss F001`（后面可附任意自由文字）或 `@gemini review` 触发读取。
7. 非阻塞的 P3（现状 `DEFERRED`）沿用现有“不阻断 READY”规则，记为 Verdict 之外的 `Blocking: no` 属性；人工 Resolve 只对非阻塞问题可结案，对阻塞问题永远只是“请求核验”的提示，不是结论。

## 5. 设计

### 5.1 记录类型（全部为 bot 发布的可读文字；每个事实在可见文字里出现，HTML 注释只能是可见内容的冗余副本）

| 记录 | 位置 | 内容（可见字段，逐行 `键: 值`） |
|---|---|---|
| **Finding Record** | 行内 Thread 首条评论；无法锚定（文件不在 diff、无可用行）时为独立 PR 评论 | 标题行 `Finding F007 · P2 · <标题>`；`Location: path:line`；`First seen at: <40位sha>`；`Failure condition: …`；`Blocking: yes/no`；正文。编号由账本里已有的最大 F 号 +1 分配（运行被 §5.5 串行化）。 |
| **Verdict Record** | 该 Thread 内的 bot 回复；无锚定问题则为引用 `Finding F007` 的独立 bot 评论 | `Verdict: FIXED｜STILL_OPEN｜UNCERTAIN｜DISMISSED`、`Finding: F007`、`HEAD: <sha>`、`Kind: repair｜dismissal`、`Attempt: n`（仅 repair）、`Range: <上次核验head>..<本次head>`、`Reason:`、`Evidence:`、`Claims read: comment <id> @ <editedAt/created>`、`Run: <id> · <model>`。 |
| **Review Report** | PR Review 正文（有行内评论时）或独立评论（无行内评论时） | 默认展开：结论、需处理的问题、可否继续、下一步（谁做什么）。折叠 `<details>`（明文）：审查类型/目标 HEAD/base、覆盖范围与**未审文件清单**、模型与运行 ID、本次费用与累计费用、问题→结论表、引用。超过 60,000 字节拆为 `Part k/n`。 |
| **Handoff Record** | Review Report 的最后一部分（或紧随其后的独立评论） | `Handoff: COMPLETE`、`Stage: first｜verification｜audit｜closing｜import`、`Seq: n`、`Prev: <上一份 Handoff 的评论 id>`、`Reviewed HEAD`、`Coverage: complete｜partial(列出)`、完整“问题→当前结论→最近核验 HEAD→修复次数→是否阻塞”表、`Spend: this run / cumulative`、`Next: <谁>: <做什么>`、`Ready: yes/no + 依据`。**没有 `COMPLETE` 的 Handoff＝这一段没结束。** |
| **Event Record** | 问题 Thread（或独立评论） | `Event: REPEATED_REWORK`、`Finding`、`Attempt: 3`、`Key: F007#repeated-rework`；对每个问题只允许存在一条。 |
| **Receipt** | 对应命令评论下的 bot 回复，或汇入 Review Report | `Handled: comment <id> (version <editedAt|created>) → <结果>`。幂等账本。 |
| **Run Start** | 独立 bot 评论，模型调用**前**写 | `Run: <id> · reserved $X · stage · HEAD`。仅有 Run Start 而无报告且超过 20 分钟 ＝ 中断，按已预留金额计入累计花费（保守）。 |
| **Status（投影）** | 单条可编辑评论 | 当前结论 + 指向最新 Handoff 的链接；**恢复逻辑永不读它**，仅用于 UI 和提交状态镜像。 |

### 5.2 可信来源与重建规则（“账本”）

1. 只读取 **作者为期望 bot 登录名且 `author.__typename == "Bot"`** 的评论为权威；其余评论（含人）只是**输入/主张**。
2. 任一权威记录若 `lastEditedAt != null`（F8）或被折叠 `minimizedReason != null` ⇒ 账本 `INTEGRITY_FAILED`，停止并在 PR 上写出原因；唯一例外是 Status 投影评论。
3. 全量读取：issue 评论（REST 分页）、PR Reviews、`reviewThreads`（分页）且**每个线程的评论也分页**（现状只取第一条，F3）。设定显式上限（线程 ≤2000、每线程评论 ≤250、issue 评论 ≤2000）；**读到上限仍有下一页 ⇒ 停止，不当作“已读完”**。权限不足、GraphQL 报错同样停止。
4. 问题当前结论 = 该 Finding 的**最新** Verdict（按评论创建顺序）；没有 Verdict ⇒ `OPEN`。同一 `Key = Finding@HEAD/Kind` 重复出现取第一条；同 Key 结论冲突 ⇒ `INTEGRITY_FAILED`。
5. 对账：最新一份 `COMPLETE` Handoff 的“问题表”必须与其后账本一致（缺失 Thread、结论回退、出现比 Handoff 更新的 Verdict 却没有后续 Handoff＝上一段未收尾）⇒ 停止并说明缺什么。
6. `Seq/Prev` 链缺环 ⇒ 停止；没有任何 bot 记录且没有旧状态块 ⇒ 视为新 PR（必须完整审查才能 READY）。
7. READY ⇔ 最新 `COMPLETE` Handoff 写着 `Ready: yes`，其 `Reviewed HEAD` = 当前 PR HEAD，`Coverage: complete`，且账本里没有阻塞中的 `OPEN/UNCERTAIN`。旧 HEAD 的 Handoff 永不沿用到新 HEAD（沿用现有 `sessionCommitStatus` 的 HEAD 对应原则）。

### 5.3 一条核验路径（修复与 dismiss 合并）

输入：当前 HEAD；全部 `OPEN/UNCERTAIN` 的 Finding（含其 Thread 全部历史）；每个问题自上次 Verdict 之后、**有写权限的人**在 Thread 里新增或编辑的评论（作为“用户主张”，在提示里标注为未核实、有长度上限）；上次核验 HEAD→当前 HEAD 的全部 diff（用于发现新回归）。
输出：每个问题 `FIXED / STILL_OPEN / UNCERTAIN / DISMISSED` + 新问题。`DISMISSED` 必须通过现有 `extractSameRepoEvidence`/`verifyDismissalWithModel` 的证据检查（路径容器检查、不抓取远程 URL）——从**自由文字**里抽取路径/链接，不再要求 `Reason:/Evidence:` 字段、最少字数、固定条数；信息不足 ⇒ `UNCERTAIN` 并在该 Thread 回复“缺什么”，不因排版拒绝。
触发：`@gemini review`（全部问题）；`@gemini dismiss F001 [任意文字]`（只核验该问题的主张，不跑差异发现，是同一函数的缩小范围调用，不再是独立状态机）。命令只认评论**第一个非空行**（现状 F7 不变）、需写权限；Receipt 键为 `评论id + 版本(editedAt)`：已处理不重复；之后被编辑的命令评论不重新执行，但**主张文本**在下次核验时按最新版本读取并在 Verdict 的 `Claims read` 中记下所读版本。
解决 Thread：只在写下 `FIXED/DISMISSED` Verdict 后由 bot Resolve；人手动 Resolve 阻塞问题只作为“请求核验”提示（沿用现有 `threads` 模式语义，F3 的 `blockingClaims`）。

### 5.4 阶段与自动衔接

- 阶段：`first`（首轮全量）→`verification`→`audit`（终审）→`closing`（仅当终审后又有新提交）。每段以 `COMPLETE` Handoff 结束；规划器在开始下一段前检查上一段 Handoff（§5.2.5）。
- 首轮无阻塞问题且覆盖完整 ⇒ Handoff `Ready: yes`。
- verification 结束时若所有阻塞问题已结案、且无新阻塞回归 ⇒ Handoff 写 `Next: audit starts automatically`，复用现有 `continue-review` 的连锁触发（F: `MAX_CONTINUATIONS = 3`）启动终审；起不来则在 Handoff 写明原因。
- 终审后的修复：用现有 `classifyIncrementalDelta` + `detect-review-risk` 判断“增量核验是否足以覆盖最新 HEAD”：小、低风险、非 `HIGH_RISK_PATH`、且自上次全量终审以来增量次数 < 15（次数从 Handoff 重建，替代状态块里的 `incrementalReviewCount`）⇒ 增量核验即可 READY（不机械跑第三轮全量）；否则写明理由并升级为全量。`session.findings.length > 48 / 16KB` 判据随状态块删除。
- 删除 `MAX_VERIFICATION_ROUNDS`（F4 的两处）；不设轮数上限。其余停止条件（预算、超时、供应商不可用、HUMAN_REQUIRED 强制关卡）保持。

### 5.5 并发、幂等、预算

- 单写者：沿用 `queue: max` 的每 PR 串行（F5）。写入前再读一次最新 Handoff 的 `Seq`，与规划时不一致就放弃写入并重新规划（防外部并发/重复事件）。
- 幂等键：命令=评论 id+版本；Verdict=`Finding@HEAD/Kind`；Event=`Finding#repeated-rework`；Report=`Run 号`。所有写入先查账本再写；写入中途失败时下次运行按“有记录但无 Handoff”补写 Handoff（不重复模型调用，沿用现有 recover 思路）。
- 预算：累计花费 = 全部 Review Report 的 `this run` 之和 + 未完成 Run Start 的预留额。预算触发时写 `Paused for cost: 已花费 $X，停在 <步骤>，等待人决定是否继续`，不写失败/通过。人工 `override` 写成独立 Handoff 字段 `Risk accepted by @x`，与独立审查结论分开。

### 5.6 REPEATED_REWORK

对每个 Finding，按 `repair` 类 Verdict 的**不同 HEAD**依次编号 Attempt 1,2,3…（`dismissal` 类不计；同一 HEAD 的重复核验因 Key 相同不重复计）。写下第 3 个 repair Verdict 的同一次运行里追加唯一的 Event Record；该问题以后 `Attempt` 继续累加；Event 不阻断下一次修复。FIXED/DISMISSED 之后记录仍在 Thread 里。未来自动化消费边界＝读取 `Event: REPEATED_REWORK` 且 `Key` 未有 `Acknowledged` 回复的 Thread；本任务不实现消费者。

### 5.7 旧 PR 的最小过渡（Import）

规划器发现旧状态块、且账本里没有 `Stage: import` 的 Handoff ⇒ 先执行一次 `import` 阶段：解码旧状态（只读，保留代码），写一份 Import Report 逐条列出每个旧 Finding（编号、等级、标题、位置、状态、理由、旧哈希标记、对应 Thread 评论 id）、覆盖与累计花费，并以 `COMPLETE` Handoff 结束；之后旧评论只作历史证据（不删除，F2 的删除行为只保留给 Status 投影评论）。解码失败或不通过校验 ⇒ `RECORD_UNRECOVERABLE`，停止并说明。旧 Thread 靠 Import Report 的“旧哈希标记↔编号”表关联；没有对应的 bot 线程沿用现有孤儿线程回收（`adoptOrphanFindings`）。

### 5.8 复用 / 合并 / 替换

- **复用不动**：provider-adapter、分片、tool-gateway、`dismiss-verifier` 证据抽取与路径安全、`classifyIncrementalDelta`、`detect-review-risk`、预算常量、`review-anchors` 的锚定逻辑、Worker 触发解析与权限检查、`queue: max`。
- **合并**：`dismiss` 独立模式并入核验；`applyVerificationResult` 与 `applyFindingDismissal` 共用一个“结论落笔”函数。
- **替换**：`encodeSessionState/parseSessionComment/pendingSessionMarker`（仅保留只读解码给 Import）、`saveSessionComment` 的删除重建（改为只对 Status 投影）、`fetchReviewThreads` 的 `comments(first:1)`、`dismissLedger` 与隐藏来源评论标记（改为 Receipt）。

## 6. 不变量

1. 账本中每个问题有且只有一个当前结论，来自最新 Verdict；Status 评论、Resolve 状态、缓存都不是权威。
2. PR 上不存在只有隐藏标记才携带的事实。
3. READY 只对应与当前 HEAD 相同的 `COMPLETE` Handoff（`Ready: yes`、覆盖完整、无阻塞项）。
4. 读不全、读不懂、对不上 ⇒ 停止；永不把“没读到”当“没有问题”。
5. 同一命令版本、同一 `Finding@HEAD/Kind`、同一 Run 至多产生一份记录。
6. Dismiss 不增加修复次数；人工 Resolve 阻塞问题不改变结论。
7. 人看到的摘要与折叠详情来自同一份数据（同一次渲染函数，一份事实）。

## 7. 失败与恢复矩阵（声明 → 失效方式 → 能检出的证据）

| 场景 | 预期 | 证据 |
|---|---|---|
| 清除全部运行缓存/升级 Bot | 仅凭 PR 记录重建出同样的问题表、Seq、下一步 | 重建结果与最近 Handoff 表逐项相等的测试 + 真实 PR 验证 |
| bot 记录被编辑/折叠 | `INTEGRITY_FAILED`，不 READY | 注入 `lastEditedAt` 的夹具 |
| 线程评论超过分页上限 | 停止 | 夹具：`hasNextPage` 永真 |
| Verdict 已写、Handoff 未写（中途崩溃） | 下次补写 Handoff，不重复模型调用，不重复 Event | 故障注入 |
| 重复/并行同一命令 | 一份 Receipt，一次模型调用 | 并发夹具 |
| 强制推送改写历史 | 旧 HEAD Handoff 不适用于新 HEAD；Range 找不到则按全量核验并在 Report 写明 | 夹具 |
| 命令评论被编辑 | 不重复执行，主张文本取新版本并记录版本 | 夹具 |
| 旧状态块 PR | 先 Import；损坏则 `RECORD_UNRECOVERABLE` | 旧格式夹具 ×2 |
| 预算耗尽/模型失败/部分覆盖 | 写“因费用暂停”或“未完成”，不写通过 | 故障注入 |
| 第 3、4 次修复 | 仅一条 Event；第 4 次不再产生 | 序列夹具 |
| 终审后改动高风险路径 | 升级全量 | `HIGH_RISK_PATH` 夹具 |

## 8. 前提状态与实现顺序

前提均已核实可用（F5、F8）；缺口：线程内评论分页读取（需新增）、`import` 阶段（需新增）。顺序见 Work Contract 阶段。人工关口：不新增 webhook；真实 PR 端到端验收（AC16）由用户确认。

**授权草案（Code 阶段，未获你确认前视为未授权）**：修改本仓库代码与测试＝需授权；commit＝需授权；push 到任务分支＝需授权；创建/更新 PR＝已有 Draft PR #97 的更新需授权；**merge、部署 Worker/Workflow、改 GitHub App 权限或 webhook 订阅、在目标仓库做破坏性操作＝均未授权**。

## 9. Work Contract（Code 阶段直接使用本节）

**目标**：按 §5 让 pr-bot 的审查事实完全来自 PR 上可读、可信的 bot 记录，并满足 Plan v1.4 §10 的 16 条验收。不改模型引擎/预算引擎/UI/权限。

**预检（开工前）**：① 记录工作区与基线；② 分支 CI 目前红灯：`tests/review-trigger.test.mjs` “V7 …root plan/design files are removed” 与根目录 `Plan.md`/设计文件冲突。须在不削弱其余断言的前提下处理（把该断言限定为“仅禁止遗留的旧 spike 文件与 main 上的 Plan/Design”，或把任务文件放入子目录），并在最终报告里写明如何改、为何不影响原保护；若无法在不弱化保护的情况下解决 ⇒ 停下报告。

**必需不变量**：§6 全部；Plan §8 的认证、权限、可信来源、模型隔离、预算、fail-closed 保护逐项回归；账本读取失败一律停止。

**阶段**
- **P1 读取层与 Import（不改变任何审查决策）**：新增账本读取/重建（§5.2）、线程评论分页、完整性与对账检查、旧状态块 Import。退出条件：对一组固定夹具，重建出的问题表与旧 `session` 等价；§7 中“编辑/折叠/分页上限/缺 Handoff/Seq 缺环/旧块损坏”全部停止且信息可读；全部既有测试通过。带入后续的不变量：§6.1、6.4。
- **P2 写入层**：发布者改写为 Finding/Verdict/Report/Handoff/Receipt/Run Start/Status；移除 base64 状态块写入与会话评论删除重建（Status 除外）；规划器、提交状态镜像、continue/sweep 改读账本；预算与幂等改由账本推导；每段写完 `COMPLETE` Handoff 后下一段才开始。退出条件：§7 中“缓存清除重建、崩溃补写、重复/并行命令、强制推送、预算/模型失败、部分覆盖”通过；人读摘要与折叠详情一致性测试。
- **P3 统一核验**：合并 dismiss 入核验；自由文字主张；去掉 `MAX_VERIFICATION_ROUNDS` 与每 HEAD dismiss 次数上限；Attempt 计数与 REPEATED_REWORK Event；自动衔接终审；终审后增量充分性判定。退出条件：§7 剩余项通过；dismiss 不因格式被拒；第 3 次恰好一条 Event。
- **全合同集成**：全部既有与新增测试通过；对一个真实 Draft PR 做 AC16 的端到端清单（首审通过、多问题修复、部分修复、自然语言 dismiss、修复回归、终审、收尾、第 3 次修复事件、缓存清除后恢复、失败阻塞），每项保存 PR 链接作为证据；**未运行的项必须标 NOT RUN，不得写 PASS**。

**验收 → 证据（摘要）**：AC1/6/7 → 首审、自动终审、增量/全量分流夹具 + 真实 PR；AC2/3/5 → 多问题核验夹具含回归；AC4/8 → 自由文字 dismiss 夹具与复发夹具；AC9/12/15 → 缓存清除重建与 §7 故障注入；AC10 → Attempt/Event 序列夹具；AC11/14 → 渲染一致性与“缺 Handoff 不开始下一段”；AC13 → 既有权限/预算/安全测试全绿且新增拒绝路径测试；AC16 → 真实 PR 链接。

**停止条件**：任何需要 merge/部署/改 App 权限或 webhook 订阅/破坏性操作；`HUMAN_REQUIRED`；发现 Plan 与现实矛盾；单条评论 65,536 字符上限与 `Seq` 并发假设在真实写入验证中不成立；预检 CI 问题无法在不弱化保护的前提下解决。
