# 项目管理决策草案 v4

## 状态

**DRAFT — 尚未接受，不授权实现。**

本草案取代 v3，处置 project-management-governance-decision-v3.review.md 的三项 Blocking。最终治理决定必须固定本文件、Design Gap、v4 submission 与独立 v4 review 的 SHA-256；任一字节变化均要求新 review 和新决定。

## DPM-1：Project Directory 的协议隐私边界

ProjectDirectory 是独立于 project-scoped ViewId / ProjectionQueryPort 的 principal-scoped read port。每页请求重新认证 principal；服务端 resolver 决定 directory scope 和 visibility state，浏览器不声明 visibility、scope 或成员关系。

continuation token 是不透明 snapshot continuation，不是 bearer capability、授权事实或可委托凭据；它不可伪造、不可枚举、不含可解码项目、主体或全局序列数据。每页在同一一致性边界内完成 token 验证、principal/scope binding、visibility revision 校验、逐行授权。revoke 线性化后任何页均不得返回该行。

token 绑定 principal、scope、visibility revision、snapshot sort/filter。grant/revoke 与任一可见项目 create/rename/close/目录字段变更都会失效旧 snapshot；已授权调用方得到不泄露原因的 DirectorySnapshotExpired 并从第一页读取。principal mismatch、token 无效/过期、scope 缺失和授权失败对未授权调用方使用同一不泄露对象存在性的失败；resolver 失败 fail closed，不伪造空目录。visibility revision 是 principal/scope-local，scope 外活动不得成为 token、invalidation、错误选择、响应形状、分页边界或**应用层人为延迟**的输入。

本决策不承诺共享数据库、CPU、I/O、锁和队列上的物理 timing non-interference；由共享基础设施负载导致的响应时延不属于本阶段目录协议的侧信道保证。若未来将物理时延侧信道纳入威胁模型，必须另行冻结资源隔离/调度/padding、攻击者观测能力与验证方法。

本地单用户 composition 中 local root scope 可见本地数据库全部项目。多主体 composition 必须安装 visibility resolver；缺失 resolver 时目录不可用，不扫描 projects 表。目录没有单一 Project journal watermark，只表达自身 snapshot 一致性。

## DPM-2：版本化 ProjectName 安全策略与 RenameProject

ProjectNamePolicyVersion = 1，固定使用 Unicode 15.1.0 NFC 与 UTS #39 15.1.0 confusables data 的随应用打包、版本化表；运行时 ICU/Unicode 升级不得改变结果。Project 持久化 policyVersion、nameComparisonKey 与 displaySkeleton；任何策略升级必须显式迁移并重建 collision/discriminator mapping，不能静默重算。

ProjectNamePolicy v1：

1. NFC 后将 Unicode White_Space 连续序列折叠为一个 ASCII space，并去除首尾 ASCII space。
2. 拒绝所有 General_Category = Cc、Cf、Cs、Co、Cn 的 code point，因而拒绝 NUL、零宽格式字符与 bidi override/isolate/PDF 控制；结果长度按 Unicode scalar value 为 1…120。
3. nameComparisonKey 是上述结果的精确 code-point sequence、大小写敏感、不做 locale folding。
4. displaySkeleton 使用固定 UTS #39 表生成；目录将 nameComparisonKey 相同**或** displaySkeleton 相同的条目并入同一个视觉 collision component。
5. Create、Rename、目录分组、discriminator mapping 与 UI 安全转义使用同一 policyVersion。名称以安全转义形式呈现，不能由原始控制文本改变 UI 方向或结构。

RenameProject 的 payload 为 name 与 expectedRevision，target 是 CommandEnvelope.projectId。仅在 Project Open、exact project-governance authority，并在 DPM-3 lifecycle gate 中赢得线性化时执行。成功 CAS 更新 Project.name / Project.revision，不改变 projectPolicyRevision，写入 ProjectRenamed(projectId, previousName, name, revision)。Closed Rename 为 TerminalLifecycleMutation。名称可重复，不能用于探测不可见项目。

目录外部 DTO 不暴露 nameComparisonKey 或 displaySkeleton；它们仅是服务端持久化比较事实。

## DPM-3：CloseProject 的统一 gate、claim 和 Stop/Quiescence

CloseProject(expectedRevision) 以 exact project-governance authority、CAS 和显式确认使 Open → Closed，并写 ProjectClosed。产品名为“归档”，不是“删除”。

除 CreateProject 的 absent → Open bootstrap 外，所有要求既有 Project Open 的 canonical command/state transition（Rename、工作/责任/依赖/权限/政策变更、SubmitHumanMessage、Pending → Claimed claim、新 autonomous AdmitExecution）与 Close 在同一 authoritative project-lifecycle gate 线性化。事务外读取 Open 不构成授权：mutation/claim 先提交则成为 Close 前事实；Close 先提交则命令拒绝、claim 不得成功。

Closed 后白名单：

| 类别 | 行为 |
|---|---|
| 新 Submit、新 claim、新 autonomous admission、Open-required business/governance mutation | 拒绝。 |
| 已 admitted execution 的 lease/recovery、已启动 Provider/Tool 的终态证据接收、Session/observation append、outbox/inbox reconcile、SettleExecution | 仅为收敛既有事实而允许。 |
| StopExecution、权限 revoke、安全/审计/投影/recovery bookkeeping | 允许；不得创造新业务事实。 |
| 新 ProviderTurn、任意新 ToolInvocation（包括 read-only 声称）、新 successor execution | 禁止启动。 |

Close 不创建项目专属 execution state。对 Close 线性化点时每一个 Active Execution，control plane 使用既有 StopExecution / Quiescence 语义提交 durable stop request；命令 ID 由 (projectId, close revision, executionId) 确定，重复 consumer/recovery 只重放同一请求。driver 在每个下一步、Provider 开始、Tool 开始、AgentAction 开始前复核 Project lifecycle gate；因此 ProjectClosed 与 stop-request 之间也不能启动 successor 或新的副作用。该机制不是强杀，不自动 Cancel Work。

### DPM-3a：Close-drain disposition matrix

| Close 时 durable 状态 | 必须的收敛处置 |
|---|---|
| Prepared，尚未 Provider/Tool intent | 停止协议产生既有 Interrupted(ControlledInterruption/StopRequested) settlement；不得启动 turn。 |
| ProviderTurn/attempt 已开始、无 terminal evidence | 可以接收同一已发请求的完整 success 或 terminal failure 并持久化；若无法取得确定 terminal evidence，按既有 stopping/reconciliation 产生 OutcomeUnknown(ReconciliationRequired)。不得在 Closed 后发 retry attempt 或新 turn。 |
| ProviderResultAvailable 或 OutputAccepted | 持久化/接纳该已得到结果所需的 output/session facts；不启动新的 AgentAction；由停止协议提出 Interrupted，除非已有更强的 durable SettlementProposed。 |
| ActionsInProgress | 已开始 action 按 AHT-5 reconcile；尚未开始 action 由 stopping disposition 跳过。未解决外部副作用生成 OutcomeUnknown(ReconciliationRequired)，不得伪造成功或启动新 action。 |
| StepEffectsCommitted 或 NextStepReady | 不启动已 durable 的 successor；停止协议直接提出 Interrupted，或在 unresolved side effect 下 OutcomeUnknown。 |
| SettlementProposed | 允许提交已 durable proposal 的 SettleExecution。 |
| 已 Settled | 不改变 settlement；仅完成下游 writeback/reconciliation。 |

不存在 settlement proposal 时，既有 Stop/Quiescence control path 必须从 durable execution/AgentLoopStep/side-effect facts确定地产生上述已有 Interrupted 或 OutcomeUnknown settlement；不得由 Session 文本猜测，也不得永久保留 Active、Prepared、NextStepReady 或 Claimed。

### DPM-3b：Submit、Inbox、Claim 与 Close

SubmitHumanMessage、claim 与 Close 均在 lifecycle gate 中：

- Submit 或 claim 先提交：Close 处置其已持久化状态。
- Close 先提交：Submit 不写 HumanMessage/event/Inbox；claim 不得成功。

HumanMessage 状态为 Pending | Claimed | Answered | Declined(ProjectClosed)。Declined 保存 time、reason、claim/execution/settlement reference；永不进入 pending/claim/retry。Close 对 Pending/未 admitted Claimed 的状态变更与 Inbox retract 必须处于同一可靠提交边界，或使用冻结的确定重放协议。延迟 HumanMessageSubmitted 消费、事件 replay 与 rebuild 必须以 canonical message state 判断：Declined 的 Inbox admission no-op/retract，绝不复活 actionable entry。

### DPM-3c：Claimed execution settlement

Close 根据 durable admission receipt 和 execution settlement，而非仅当前 Active：

| Claimed 消息关联事实 | 处置 |
|---|---|
| 无 execution record，且 deterministic admission receipt 未 committed | Declined(ProjectClosed)。 |
| receipt committed 而 execution record 缺失/不一致 | invariant violation：持久记录 durable Attention 并进入 Durability Envelope repair；在 repair 确定 committed admission/settlement 前不得 Decline 或 rollback。 |
| Active | 按 DPM-3a drain，保持 Claimed。 |
| Settled Completed 或 Interrupted | 先按 settle→writeback 幂等转 Answered；Close 不覆盖 durable result。 |
| Settled Failed 或 OutcomeUnknown | Declined(ProjectClosed)，保存 reference；绝不回 Pending/重试 admission。 |

Close 后 recovery 枚举曾 admission 的 Claimed/Active/Settled conversation execution，不以 Project Open 过滤；只执行上述收敛，不执行 Claimed → Pending rollback。正常 durability envelope 内必须满足：Declined 没有后来 committed admission；Closed 没有 Pending；Closed 的 Claimed 都有 committed admission 和确定 settlement/writeback 路径。验收注入 Close 于 submit、claim CAS、admission、Provider request/terminal evidence、每个 AgentLoopStep handoff、action intent/effect、successor persist、settlement proposal、writeback 和 delayed Inbox replay 两侧。

## DPM-4：允许同名与 displayDiscriminator

目录 resolver 对完整授权 snapshot（不是当前页或 filter 页）按 DPM-2 collision component 分组。一个 Project 属于 collision component 时，无论分页/筛选均返回同一 displayDiscriminator，UI 渲染 name + displayDiscriminator；非 collision 不展示技术 ID。

discriminator 在同一 principal/scope/collision component 内唯一、在持续可见期间稳定、独立随机生成、非 ProjectId 派生、不可逆、固定长度、跨 principal/scope 不可关联。它的值/长度/序号/缺口/生成顺序不泄露不可见对象或全局计数。resolver 通过受约束持久映射处理 Create/Rename/visibility 并发并保证无碰撞。客户端可持返回 projectId 为 opaque navigation target，但每次服务端读取/选择重新鉴权；显示文本不是 authority。

## DPM-5：Web 信息架构

左栏顶部为“项目”：名称、目录切换、创建入口、已归档筛选。完整 ProjectId 只在设置页“复制 ID / 诊断”显示。选中项目后才显示项目内部导航；责任树只表示 Workspace tree。Project 概览与 Workspace 节点使用不同组件和读契约。

## 必须写入 owning contracts

DID 必须拥有：ProjectNamePolicy v1、Rename/Close event/authority/transition、Open gate 精确清单、Closed whitelist、Stop/Quiescence/AgentLoopStep/Provider/Tool matrix、HumanMessage terminal/race。P1/P10/P12/P14 必须拥有：CAS/transactions、directory resolver/tokens、逐页 reauth、无 oracle errors、P14/AgentLoopStep recovery/inbox matrix。P13/P14 必须 supersede human-actionable catalog 和 UI rules。实施 phase 必须定义 DDL/index、policy tables/migrations、token/discriminator stores 与机械 TDD matrix。

## 非目标

不合并 Project 与 Workspace；无 hard delete、cascade delete、Reopen、自动 Cancel Work 或强杀 execution；不让客户端直读 SQLite 或伪造 visibility。

