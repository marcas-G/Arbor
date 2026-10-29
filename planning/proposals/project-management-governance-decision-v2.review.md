# 项目管理治理提交 v2 — 审阅意见

日期：2026-09-30。

## 审阅对象与不可变版本

本审阅只针对以下字节内容：

- `planning/proposals/project-management-decision-draft-v2.md`  
  SHA-256 `2035300702F9BE8A3333786DFEA258CBD7F21C410434C6DD4BBE333FB3237DB9`
- `planning/proposals/project-management-governance-submission-v2.md`  
  SHA-256 `A5529F55C52713972431BF07A69EB33DC504C2C8E0D550D0D1C408E505F7D018`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
  SHA-256 `7672E7F6CFF3523B040D297331F54282EEBFAD198323DA2CCFA6DB1BA8F9FEE1`

任一对象发生字节变化，本审阅不自动适用于新对象。

## 结论

**REVISE — Blocking = 5。不得据此接受 v2，不授权实现，也不得将 DPM-DG-01 标为 RESOLVED。**

v2 已正确选择并明确了以下方向：独立且主体受限的 Project Directory、允许重名、`RenameProject` 的 CAS/审计语义、Close-as-archive、无 hard delete/Reopen、Closed 后不新 admission、已有 Execution 的恢复/settlement，以及 acceptance 必须固定哈希。这些内容与 Problem/Goals 的 G4/G6/G7、DID 的 Project terminal lifecycle、P2 admission 前置和 P14 durable conversation 协议方向一致。

但当前文本仍留下会改变状态机、一致性、权限和隐私结果的治理选择。尤其是 P14 的两个既有 crash/retry 语义与 DPM-3b 尚未闭合；按当前文字可以产生丢失已完成回复或 Closed 项目永久 Pending 的机械反例。以下五项必须在重新提交前修订。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-V2-R1 / P1：Close 判定只看 Active，破坏 settle→writeback 恢复窗口

位置：决策草案第 81–88 行；P14 `02-conversation-execution.md` §4.1/§4.2。

草案把 `Claimed` 分成“无 committed Active Execution”与“已成功 admission 为 Active Execution”。这不足以覆盖 P14 已冻结的两步协议：`SettleExecution` 提交后、HumanMessage 写回前，Execution 已经是 **Settled**，消息仍是 `Claimed`。若此时 Close 线性化，按第 84 行会被当作“无 Active Execution”而转为 `Declined(ProjectClosed)`，从而丢弃一个已经 durable 完成、等待确定性写回的回复；这直接违反 P14 的 exact-once logical response 与 G7 的恢复一致性。

另一个反例发生在 Close 前已 admission、Close 后 settlement 为 `Failed` 或 `OutcomeUnknown` 时。P14 §4.2 的既有规则是 `Pending(attempt_no + 1)` 后重新 admission；但草案同时禁止 Closed 项目的新 admission。第 85 行所称“由既有失败终态规则收敛”并不存在：这两个分支不是终态，会制造永久 Pending。

精确修订建议：

1. Close 判定必须依据 durable `claimed_by_execution_id` 对应的 **Execution 是否曾成功 admission 及其 settlement**，不能以“当前是否 Active”代替“是否已 admission”。至少冻结四类：无 Execution record、Active、Settled、引用不一致/未知。
2. `Claimed + Settled` 必须先按 settlement 幂等完成 P14 写回：Completed/Interrupted 依既有规则成为 Answered；不得因 Close 覆盖已经 durable 的结果。
3. `Claimed + Active` 在 Close 后继续原 Execution 的恢复/settlement；若最终为 Completed/Interrupted，按既有规则 Answered；若最终为 Failed/OutcomeUnknown，则必须冻结一个 **Closed 下不回 Pending** 的终态（若沿用本草案词表，应为 `Declined(ProjectClosed)` 并保存 execution/settlement reference）。
4. `Claimed + 无 Execution record` 才可在 Close 赢得 gate 后 Declined；恢复 sweep 在 Closed 下不得执行 P14 原有的 `Claimed → Pending` 回滚。
5. 加入不变量：不存在 `Declined` 消息对应一个后来成功 admission 的 Execution；不存在 Closed 项目的 Pending；不存在无可收敛路径的 Claimed。验收覆盖 Close 位于 claim、admission commit、settlement commit、conversation writeback 四个边界的每一侧。

## DPM-V2-R2 / P1：Submit、Inbox 投影与 Close 尚未共享完整线性化协议

位置：决策草案第 62、77–88 行。

第 79 行只规定 `CloseProject` 与 claim/admission 竞争，没有规定 `SubmitHumanMessage` 与 Close 的线性化关系。仅写“Closed 后新 Submit 终端拒绝”不足以排除 TOCTOU：Submit 可在事务外看到 Open，Close 先提交，Submit 随后仍写入 Pending/Event。必须明确两者使用同一 authoritative gate，并由提交顺序决定唯一结果：Submit 先提交则 Close 必须处置该消息；Close 先提交则 Submit 不得创建 message、event 或 Inbox entry。

此外，`HumanMessageSubmitted → Inbox admitUpsert` 是 replayable/offset-driven 路径。即使 Close 已将 Pending 转为 Declined并“撤销”当前 Inbox entry，延迟或重放的 `HumanMessageSubmitted` 仍可能在 Close 后重新 admit 一个可处理条目。当前文本没有冻结 state-aware projection/reconciliation，因此“撤销”不是重启安全的不变量。

精确修订建议：

1. 把 Submit 明确纳入同一个 project closed-admission gate；Project lifecycle 检查必须在 Submit 的 authoritative transaction 内完成，不能是事务外 pre-check。
2. 冻结 `HumanMessageSubmitted` 与 `ProjectClosed` 任意消费顺序下的最终结果：若 canonical HumanMessage 已 Declined，Inbox admission 必须 no-op/立即 retract；投影 rebuild、事件重放、consumer crash 后都不得复活 actionable entry。
3. 明确 Close 对 Pending/未 admission Claimed 的状态更新与 Inbox 处置是同一可靠提交边界，或采用可确定重放的两步协议；若采用后者，必须像 P14 settle→writeback 一样声明 crash window、重发现、幂等键和最终不变量。
4. 验收增加 `submit commit ↔ close commit ↔ delayed inbox admission/replay` 的全排列与进程重启。

## DPM-V2-R3 / P1：Closed command matrix 未覆盖并发 canonical mutation 与新 Tool side effect

位置：决策草案第 60–67、88–90 行。

“Closed 后拒绝新的 business/governance mutation”只描述观察到 Closed 之后的行为，没有规定与 Close 并发、已经完成 Open pre-check 但尚未提交的命令。若跨 aggregate handler 在 Close 前读到 Open、Close 先提交、handler 后提交，仍可在 Closed 项目中扩张 Work/Workspace/Dependency/Permission/Policy。关闭线性化点只有对所有 Open-required mutation 共享 authoritative serialization 才成立。

同时，第 64 行仅列“已启动 tool 的结果接收”，第 65 行只禁止 business/governance mutation；没有决定 Active Execution 在 Close 后能否启动新的 executable tool side effect。Tool 外部副作用不是 canonical business mutation，但同样会改变现实；留给实现会违反 G7/AHT unresolved-side-effect gate 的治理边界。

精确修订建议：

1. 冻结竞态规则：所有要求 Project Open 的 canonical mutations 与 Close 在同一 authoritative project lifecycle gate 上线性化。mutation 先提交可被 Close 随后归档；Close 先提交则 mutation 终端拒绝。事务外 lifecycle read 不构成授权。
2. 列出 Closed 下允许的 mutation 白名单，而不是开放式“等”或风险描述。至少区分 canonical business/governance mutation、quiescence/control、runtime bookkeeping、session/observation append、projection/reconciliation。
3. 冻结 ToolRuntime 行为：Close 后不得启动新的外部写副作用；Close 前已开始或 outcome unknown 的 ToolInvocation 必须继续接收结果并 reconcile，未解决副作用仍受 AHT-5 gate。若允许新的纯 read-only tool，必须由受验证的 effect classification 明确限定，不能由模型文本自报。
4. 说明 Active Execution 如何在上述限制下确定性 settle，且禁令不等于强杀 Execution、自动 Cancel Work 或丢弃已开始副作用。

## DPM-V2-R4 / P1：同名判定限定“当前页”仍会产生无歧义失败

位置：决策草案第 52、94–96、109 行。

草案只在“当前目录页中”出现规范化同名时显示 discriminator。两个同名 Project 若落在不同页、不同筛选页或分页边界发生移动，各页都可能只显示裸名称，用户仍无法可靠区分；这没有完成旧 DPM-R4 要求的日常无歧义选择。

`displayDiscriminator` 的“稳定”范围也未定义。示例“scope 内项目序号”会因创建、revoke、排序或分页变化而不稳定，并可能通过序号/缺口泄露可见或不可见计数；未加 keyed/scope-local 约束的 ProjectId 派生值还可能跨 principal/scope 关联。与此同时，第 52 行声称存在“冻结的 Unicode 规范化规则”，第 109 行却把名称规范继续留给实施 phase；同名分组所依据的 comparison key 因而尚未冻结。

精确修订建议：

1. 重名判定作用域改为该 principal/scope 下当前授权目录 snapshot（或明确的查询结果全集），不得只看单页。跨页/筛选仍须对同一 Project 使用同一 discriminator。
2. 冻结 discriminator 不变量：在作用域内对规范化同名集合唯一；对同一可见 Project 在规定生命周期内稳定；非 raw ID、不可逆；principal/scope-specific、跨 scope 不可关联；不通过值、长度、序号或缺口泄露不可见对象/全局计数；并发 Create/Rename 后仍无碰撞。删除“项目序号”示例，除非其机制能机械满足这些不变量。
3. 冻结选择协议：客户端可以携带返回行中的 `projectId` 作为 opaque navigation target，但服务端每次选择仍重新鉴权；`name + displayDiscriminator` 只是人类识别，不是 authority。
4. 在治理/owning contract 而非实现自由选择中明确 `ProjectName` comparison key：至少 normal form、首尾/全空白处理、空字符串、长度上限与大小写/默认可忽略字符策略。Create、Rename、同名分组必须共用同一函数。

## DPM-V2-R5 / P1：目录 token 仍被表述为 capability，缺少逐页再授权与无 oracle 合同

位置：决策草案第 14、28–34、96、109 行。

principal/scope 绑定、visibility 变化失效和 fail-closed 已明显优于旧稿，但“opaque capability”容易把分页 token 解释为 bearer authority。当前文字没有明确每一页请求都必须重新认证 principal、重新验证当前 visibility revision，并在同一一致性边界内完成 token 检查与行读取。若实现只在第一页授权并让 token 持有旧 snapshot，revoke 后仍可能读出旧页；若 principal mismatch、伪造、过期、revoke 分别返回可区分错误，还会形成 scope/visibility oracle。

精确修订建议：

1. 将其定义为 opaque continuation/snapshot token，明确 **不是授权事实或可委托 bearer capability**；每次请求都必须有 authenticated principal，并重新绑定 principal/scope/current visibility state。
2. token 验证、visibility revision 校验与返回行的 authorization 必须在一个一致性边界内，保证 revoke 赢得线性化后不再返回被撤销行。
3. token 必须不可伪造、不可枚举且不携带可解码隐私数据；principal mismatch、签名/查找失败、过期等对未授权调用方使用不泄露对象存在性的统一失败语义。`DirectorySnapshotExpired` 只表示该已授权目录读取需从第一页重启，不暴露具体哪个项目或变更导致失效。
4. 明确 `visibility revision` 是 principal/directory-scope 语义，不得由 scope 外 Project 活动推动或通过 token/错误/时序暴露全局序列。

## 接受链 / SHA 审计

当前 submission 中 decision draft、Design Gap 与旧 review 的三个 SHA-256 均与磁盘字节一致；这一点通过。

但 submission 第 11、22–23 行固定的是旧 `project-management-governance-decision.review.md`。该旧 review 自身明确审阅的是旧 draft，且记录的 Design Gap SHA 为 `C86008A6...02FA8`，不是当前 Gap 的 `7672E7F6...FEE1`；它只能作为 R1–R4 的历史输入，不能充当 v2 与当前 Gap 的独立审阅证据。当前 submission 自身也未进入其列出的不可变对象集合。

重新提交时建议采用无循环的接受链：

1. 先修订并冻结 decision draft、Design Gap、submission；
2. 新 review 明确固定这三个对象的 SHA-256；
3. 最终人工 `ACCEPT/REVISE/REJECT` 记录同时固定 draft、Gap、submission 和新 review 的 SHA-256，并明确旧 `project-management-governance-decision.md` 仅为已被新裁决 supersede 的历史记录；
4. 任何被接受对象的语义变化都要求新 review 与新治理记录，不能沿用旧 ACCEPT。

Design Gap 第 7 行“已接受完整产品规则”也应收窄为“已接受产品方向/初始规则但未形成可实施闭合”，避免与其 OPEN 状态和旧 review 的四项 Blocking 自相矛盾。修订后的 Gap 应把本审阅 R1–R5 纳入“需治理裁决的最小合同”和验收证据，而不是只保留旧版三项概述。

## 已确认可保留的边界

- Project 与 Workspace/责任树继续分离。
- `Closed` terminal；无 hard delete、级联删除、Reopen、自动 Work cancel 或强杀 Active Execution。
- Rename/Close 是授权、revision-CAS、审计化、幂等 canonical commands；`projectPolicyRevision` 不因 Rename 改变。
- ProjectDirectory 不伪装成 project-scoped `ViewId`/watermark；浏览器不决定 visibility/scope，也不直读 SQLite。
- 不可见项目的名称、数量、顺序、时间和活动不得经目录 token/discriminator/错误语义泄露。
- DPM-DG-01 在 accepted semantics 写入 owning `docs/design/**` 并记录 resolving revision 前保持 OPEN；实现继续未授权。

## 最小再审证据

下一版至少应携带：

1. Close × Submit/claim/admit/settle/writeback 的完整线性化表，含 Failed/OutcomeUnknown 与 delayed Inbox replay；
2. Closed command/action/tool 白名单，以及所有 Open-required mutation 与 Close 的统一 gate；
3. directory token 的逐页鉴权、revoke 线性化、无 oracle 不变量；
4. 跨页同名、discriminator 稳定/不可关联和名称 comparison key；
5. 新 submission/new review/final acceptance 的四对象 SHA 固定链。

## 审阅范围

本次对照了 `AGENTS.md`、冻结 Problem/Goals、DID Project/Execution transition 与 authority/transaction 边界、P2 `AdmitExecution` 前置、P6 Inbox projection 语义、P14 HumanMessage DDL/claim/retry/settle→writeback/AgentLoopStep recovery 合同，以及旧治理决定和旧 review。未运行实现测试；未修改 `docs/design/**`、实现代码或三个被审阅对象。
