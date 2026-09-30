# 项目管理决策草案 v3

## 状态

**DRAFT — 尚未接受，不授权实现。**

本草案取代 v2，逐项处置 project-management-governance-decision-v2.review.md 的 DPM-V2-R1…R5。任何接受必须固定本文件、Design Gap、治理提交和独立审阅的 SHA-256；任一字节变化都需要新审阅和新决定。

## DPM-1：独立、主体绑定的 Project Directory

ProjectDirectory 是独立于 project-scoped ViewId / ProjectionQueryPort 的读口。每一页请求都携带认证 principal；directory resolver 在服务端导出 directory scope 与当前 visibility state。浏览器不得声明 visibility、scope、项目成员关系或授权事实。

最小目录行：projectId（仅 navigation target，日常 UI 默认不展示）、name、内部 nameComparisonKey、lifecycle、rootWorkspaceId、revision、updatedAt，以及 DPM-4 的 displayDiscriminator。

### DPM-1a：分页、撤权与无泄露不变量

1. continuation token 是不透明的 snapshot continuation，不是 bearer capability、授权事实或可委托凭据；不可伪造、不可枚举、不含可解码的项目、主体或全局序列数据。
2. 每页都重新认证 principal，并在同一个一致性边界中完成 token 验证、principal/scope binding、当前 visibility revision 校验及每行授权。visibility revoke 线性化之后，任何后续页都不得返回被撤销行。
3. token 绑定 principal、directory scope、visibility revision、snapshot sort 与 snapshot filter。grant/revoke 和任何可见项目的 create/rename/close/目录字段变化都会使旧 snapshot 失效。已授权调用方得到不泄露变更原因的 DirectorySnapshotExpired，随后从第一页读取。
4. principal mismatch、无效/伪造/过期 token、scope 不存在和授权失败，对未授权调用方使用同一不泄露对象存在性的失败语义。resolver 失败 fail closed，绝不伪造空目录。DirectorySnapshotExpired 不得透露具体项目、grant 或事件。
5. visibility revision 是 principal/scope-local 语义；scope 外项目的数量、顺序、活动、时间和 revision 不得影响 token、错误、可观测延迟或输出值。
6. 本地单用户 composition 中 local root scope 可见本地数据库全部项目。多主体 composition 必须安装 visibility resolver；缺失 resolver 时目录不可用，不降级扫描 projects 表。

目录没有单一 Project journal watermark；其 snapshot/version 仅表达目录一致性。

## DPM-2：ProjectName 与 RenameProject

ProjectName 规范化和同名 comparison key 固定为：输入先 Unicode NFC；所有 Unicode White_Space 连续序列折叠为一个 ASCII space；去除首尾 ASCII space；结果按 Unicode scalar value 计数必须为 1…120。比较采用该结果的精确 code-point sequence、大小写敏感；不删除 default-ignorable 字符，不做 locale folding。Create、Rename、目录同名分组必须调用同一 projectNameKey。

新增 RenameProject，payload 为 name: ProjectName 与 expectedRevision: Revision，target 是 CommandEnvelope.projectId。它只在 Project Open、持有 exact project-governance authority，且在 DPM-3 project lifecycle gate 中赢得线性化时执行。成功时 CAS 更新 Project.name 与 Project.revision，不改变 projectPolicyRevision，并写入 ProjectRenamed(projectId, previousName, name, revision)。Closed 项目 Rename 是 TerminalLifecycleMutation。同一 command 重放按既有 receipt/idempotency 收敛；名称允许重复，绝不以同名探测不可见项目。

## DPM-3：CloseProject（产品名“归档”）的统一 gate

CloseProject(expectedRevision) 以 exact project-governance authority、CAS、显式确认使 Open → Closed，并写入既有 ProjectClosed。产品只称“归档项目”，不称“删除”。

所有要求 Project Open 的 canonical mutation（Create/Rename、工作/责任/依赖/权限/政策扩张或变更、SubmitHumanMessage、新 autonomous AdmitExecution）与 Close 使用同一个 authoritative project-lifecycle gate。事务外读到 Open 不是授权：mutation 先在线性化点提交可被随后 Close 保留为既有事实；Close 先提交则 mutation 终端拒绝。

### DPM-3a：Closed 白名单与 Active Execution drain

| 类别 | Closed 后行为 |
|---|---|
| 新 SubmitHumanMessage、新 autonomous admission、所有 Open-required business/governance mutation（含 Grant/Policy/Work/Workspace/Dependency 扩张） | 拒绝。 |
| 已成功 admission Execution 的 lease/recovery、已持久化结果接收、Session/observation append、outbox/inbox reconciliation、SettleExecution | 允许，只为收敛 Close 前已有事实。 |
| StopExecution、权限 revoke、安全/审计/投影/恢复 bookkeeping | 允许；不得借此创造新业务事实。 |
| 新 ProviderTurn、任何新 ToolInvocation（含声称 read-only） | 禁止启动。Close 前已启动或 OutcomeUnknown 的 invocation 仍须接收、reconcile，并继续受 AHT unresolved-side-effect gate 约束。 |

Active Execution 进入 drain：不强杀、不自动 Cancel Work、不丢弃已开始副作用；但不再推进新模型/工具步骤或业务/governance action，只能依据已持久化事实恢复、输出写回和 settlement。

### DPM-3b：Submit、Inbox 与 Close

SubmitHumanMessage 在 project-lifecycle gate 中线性化：

- Submit 先提交：Close 随后处置该已持久化消息。
- Close 先提交：Submit 终端拒绝；不得写 HumanMessage、event 或 Inbox entry。

HumanMessage 状态扩展为 Pending | Claimed | Answered | Declined(ProjectClosed)。Declined 保存 disposition time、reason、claim/execution/settlement reference（若有），不再进入 pending、claim 或 retry 队列。

Close 对 Pending/未 admitted Claimed 的 state change 与 Inbox retract 必须处于同一可靠提交边界，或使用已冻结、可确定重放的两步协议（明确 crash window、re-discovery、idempotency key 与最终不变量）。HumanMessageSubmitted 的延迟消费、重放和投影 rebuild 必须以 canonical message state 为准：已 Declined 时 Inbox admission no-op/retract，任何消费顺序或重启都不得复活 actionable entry。

### DPM-3c：Claimed 消息与 execution settlement

Close 对 Claimed 消息依据 durable admission record/receipt 与 execution settlement，不能以“当前是否 Active”代替“是否曾成功 admission”。

| Close 线性化点的已 claim 消息 | 固定处置 |
|---|---|
| 无 Execution record 且 deterministic admission receipt 未 committed | Declined(ProjectClosed)。 |
| admission receipt committed 但 execution record 缺失/引用不一致 | 先 recovery 找回或验证 admission；不得 rollback 或 Decline。仅证明没有 committed admission 后才可 Decline；无法证明时升级 recovery attention，直到确定处置。 |
| Execution Active | 保持 Claimed，进入 DPM-3a drain，等待 settlement。 |
| Execution Settled: Completed 或 Interrupted | 保持 Claimed，先按既有 settle→writeback 幂等变为 Answered；Close 不得覆盖 durable result。 |
| Execution Settled: Failed 或 OutcomeUnknown | Declined(ProjectClosed)，保存 execution/settlement reference；Closed 下绝不回 Pending/重试 admission。 |

Close 后 recovery/sweep 必须枚举所有曾 admission 的 Claimed/Active/Settled conversation execution，不能以 Project Open 过滤；它只执行上表的收敛，不执行旧 Claimed → Pending rollback。必须成立：

- Declined 消息没有后来成功 admission 的 Execution。
- Closed 项目没有 Pending 消息。
- Closed 项目的 Claimed 消息均有 committed admission，且有确定 settlement/writeback 路径。

验收覆盖 Close 位于 submit commit、claim、admission commit、settlement commit、conversation writeback、延迟 Inbox event replay 每个边界两侧，以及 Failed/OutcomeUnknown、进程重启和 visibility-independent recovery。

## DPM-4：允许同名与无 raw-ID 的辨识

名称允许重复。directory resolver 对 principal/scope 的完整授权 snapshot（不是当前页、不是当前 filter 页）计算 nameComparisonKey collision group；同一 Project 在该 scope 中存在 collision 时，无论分页或筛选如何变化都返回同一个 displayDiscriminator，UI 必须渲染它。

displayDiscriminator 由 resolver 管理，满足：

- 在同一 principal、directory scope、nameComparisonKey collision group 内唯一。
- 同一 principal 持续可见该 Project 的期间稳定。
- 独立随机生成、非 ProjectId 派生、不可逆、固定长度。
- 跨 principal/scope 不可关联。
- 值、长度、序号、缺口、生成顺序均不泄露不可见对象或全局计数。
- Create/Rename/visibility 并发后无碰撞，resolver 用受约束持久映射保证。

人类按 name + displayDiscriminator 识别同名项目。客户端可携带目录行返回的 projectId 作为 opaque navigation target；服务端每次读取或选择仍重新鉴权，显示文本不是 authority。

## DPM-5：Web 信息架构

左栏顶部是“项目”：当前项目名称、目录切换、创建入口及已归档筛选。完整 ProjectId 只在设置页“复制 ID / 诊断”显示。选中 Project 后才显示“项目内部导航”；责任树只表示 Workspace tree。Project 概览与 Workspace 节点使用不同组件、不同读契约。

## 落地前必须写入 owning contracts

1. DID：ProjectName、Rename/Close command/event/authority/transition；Open-required mutation lifecycle gate；Closed 白名单与 drain/tool policy；HumanMessage Declined、admission/settlement close-race。
2. P1/P10/P12/P14：CAS/transaction/repository/event、ProjectDirectory resolver/opaque snapshot、逐页 reauth、无 oracle error、P14 state/recovery/inbox replay 矩阵。
3. P13/P14 UI：human-actionable catalog supersession、目录/同名辨识/归档确认。
4. 实施 phase：schema/DDL/index、persistent discriminator mapping、token store、机械 TDD 验收矩阵。

## 非目标

不合并 Project 与 Workspace；不做 hard delete、级联删除、Reopen、自动 Cancel Work 或强杀 Active Execution；不让客户端直读 SQLite 或伪造 visibility。

