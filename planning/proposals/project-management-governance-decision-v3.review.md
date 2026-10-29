# 项目管理治理提交 v3 — 独立审阅意见

日期：2026-09-30。

## 不可变审阅对象

本审阅只适用于以下字节版本：

- `planning/proposals/project-management-decision-draft-v3.md`  
  SHA-256 `37EE896E60E924A6F2FF0394EE42881016F06F32043090F36D2FFA0B7B29E346`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
  SHA-256 `10CAC556A27EA52AD83FA77A41C09C4C8FA62D70D952CB4F705CB079822BA0EC`
- `planning/proposals/project-management-governance-submission-v3.md`  
  SHA-256 `1D32F5DF40CC4D70BDEC5F8FA9C932BD1CF71F9199235B131DEDB40655033C27`

三个 SHA-256 均已与磁盘字节复核一致。任一对象发生字节变化，本审阅自动失效。

## 结论

**REVISE — Blocking = 3。不得接受 v3，不授权实现，不得将 DPM-DG-01 标为 RESOLVED。**

v3 对 v2 五项阻断的处置已取得实质进展：

- v2 R1 的 settled→writeback 丢答和 Closed 下 Failed/OutcomeUnknown 回 Pending 已关闭；
- v2 R2 的 Submit/Close 线性化及 delayed/replayed Inbox resurrection 已关闭；
- v2 R3 的 Open-required canonical mutation gate、新 ToolInvocation 禁止及既有副作用 reconcile 已大体关闭，但 Active Execution drain 仍缺确定终态；
- v2 R4 的“只看当前页”、discriminator 稳定/不可关联/持久映射已关闭，但新冻结的 ProjectName 规则引入视觉冒充和版本确定性缺口；
- v2 R5 的 token 非 bearer、逐页再授权、revoke、统一失败和 scope-local revision 已关闭，但新增的绝对时延不干扰条款在当前架构下不可证明。

接受链的结构已经正确：review 固定 draft + Gap + submission，最终人工决定再固定这三者和本 review。以下三项必须先修订并重新审阅。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-V3-R1 / P1：Closed drain 没有为 in-flight ProviderTurn 与非终态 AgentLoopStep 提供确定收敛

位置：draft 第 36、43–47、62–78 行；DID §8.16 Stop/Quiescence；P3 `08-agent-loop-step-handoff.md`；P9 `07-agent-loop-step-recovery.md`。

第 45 行禁止“新 ProviderTurn”，但没有决定 Close 线性化时已经发出、尚未形成 durable complete success/failure 的 ProviderTurn 如何处理。第 43 行的“已持久化结果接收”只覆盖已有 durable evidence；它不能覆盖 provider 请求在途、完整响应已到进程但尚未持久化、stream 被 Close/cancellation 截断等窗口。若直接停止接收，会丢失可恢复结果；若沿既有 retry policy 重试，又违反“无新 ProviderTurn/不再推进模型步骤”。

更一般地，Active Execution 可能停在 `Prepared`、unsettled ProviderTurn、`ProviderResultAvailable`、`OutputAccepted`、`ActionsInProgress`、`StepEffectsCommitted`、`NextStepReady` 或 `SettlementProposed`。v3 只说“依据已持久化事实恢复、输出写回和 settlement”，没有说明：

- 已持久化 successor 是否还允许启动；
- 尚未开始的 Agent action 如何跳过；
- 完整 Provider output 中包含被 Closed gate 禁止的 action 时如何形成 settlement；
- 没有既有 SettlementProposed 的 Execution 由谁、以什么权威事实生成 Interrupted/Failed/OutcomeUnknown；
- Close 是否提交 `StopExecution`，还是发明一个与既有 `ExecutionStopping` 并行的新 drain 状态。

因此存在永久 Active/永久 Claimed 反例：Close 发生在 `NextStepReady` 或 Provider stream in-flight，后续 turn 被禁止、当前又没有 settlement proposal，recovery 只能反复发现同一非终态记录，无法满足第 76 行“有确定 settlement/writeback 路径”。

第 36 行的统一 gate 也遗漏了 conversation `Pending → Claimed` 这一 runtime 状态变化，只列 Submit 和 Admit。虽然 message-row CAS 可能在 SQLite 上偶然串行化，但治理合同必须明确 Close-first 后 claim 不得成功、claim-first 后 Close 按未 admission 分支 Decline；不能依赖具体 adapter 的写锁行为。括号中的“Create”还可能被读作 `CreateProject`，而 absent→Open 没有可与 Close 共享的既存 Project lifecycle gate，应改为精确命令集合或明确排除 CreateProject。

精确修订建议：

1. 复用既有 Stop/Quiescence 单一控制语义：明确 Close 如何使项目内每个 Active Execution 获得 durable `stopRequestedAt`/等价既有 stopping fact、由谁提交、幂等键是什么；不得另造仅存在于 Project Close 的隐式执行状态。
2. 冻结 Close-drain disposition matrix，至少覆盖上述八个 AgentLoopStep/Provider 状态。Close 前已经开始的 ProviderAttempt 必须选择并明确：允许完整成功/终端失败证据落盘并按 AHT handoff 收敛，或受控取消为 terminal failure；禁止丢弃完整成功，也禁止在 Closed 后按 safe retry 发出新 attempt/turn。
3. 已开始 Tool action 继续按 AHT-5 reconcile；未开始 action 必须以既有 stopping disposition 确定跳过。若没有 settlement proposal，控制面必须确定性地产生既有 `Interrupted(ControlledInterruption/StopRequested)` 或在 unresolved side effect 下产生 `OutcomeUnknown(ReconciliationRequired)`；不得从 Session 文本猜测。
4. 已经 durable 的 `SettlementProposed` 允许提交 `SettleExecution`；已经 durable 的 next-turn successor 在 Closed 后不得启动 Provider 请求，并须通过同一 stopping protocol 收敛，而不是永久保持 `NextStepReady`。
5. 把 claim 明确纳入 Close 的 authoritative gate/transaction protocol，并在验收中加入 Close 位于 claim CAS、Provider request/terminal event、每个 AgentLoopStep handoff、action intent/effect、successor persist 及 settlement proposal 两侧的注入矩阵。
6. 将“所有 Open-required mutations”落为精确 command/state-transition 清单；明确 `CreateProject` 的 absent→Open bootstrap 不属于对既存 Project 的 Close 竞态。

## DPM-V3-R2 / P1：ProjectName 允许不可见/双向控制字符，UI 可出现无 discriminator 的视觉同名

位置：draft 第 13、28、82–93 行。

v3 已冻结 exact `nameComparisonKey`，但明确“不删除 default-ignorable 字符”，也没有禁止 Unicode control、format 或 bidirectional control。于是两个 code-point sequence 不同的名称可以在人类界面中看起来相同或重排，例如普通名称与插入零宽字符/双向覆盖字符的名称。它们不属于同一个 `nameComparisonKey` collision group，因此 DPM-4 不返回 discriminator；用户仍可能在隐藏 ProjectId 的目录中选择错误项目。服务端重新鉴权只能阻止越权，不能证明用户选择意图正确。这是名称作为主要导航界面后的 UI spoofing 风险，不是普通呈现细节。

此外，`Unicode White_Space` 属性表和整个 `projectNameKey` 算法没有版本标识。Arbor 的 Project 是长期主体；运行时/Unicode 数据升级后，Create、Rename、已有行分组和持久 discriminator mapping 必须继续使用同一确定函数或执行显式迁移。只写“Unicode NFC/White_Space”不足以形成可回放、可迁移的 canonical contract。

第 13 行还把“内部 nameComparisonKey”列入“最小目录行”，容易被实现为外部 DTO 字段；它是 resolver 内部比较事实，不应无理由扩大浏览器可见合同。

精确修订建议：

1. 冻结 `ProjectNamePolicyVersion`/Unicode 数据版本，并规定 Project 持久化 comparison key 及 policy version；策略升级必须显式迁移/重算 collision group，不能随运行时库静默改变。
2. 对 `Cc`、危险 `Cf`/bidi controls、NUL 和其他不可安全显示字符选择明确策略：拒绝；或保留 canonical name 但另建 versioned display-skeleton/visual-collision key，并对视觉碰撞始终显示 discriminator/警告及安全转义。仅依赖 exact code-point key 不足。
3. Create、Rename、directory grouping、discriminator mapping 和 UI rendering 必须绑定同一 policy version；加入零宽字符、RLO/LRO/PDF/isolates、combining marks、全空白与 120-scalar 边界测试。
4. 将 `nameComparisonKey` 标为 server-internal，不进入外部最小目录 DTO；若确需传输，必须说明客户端用途且不得把它当 authority。

## DPM-V3-R3 / P1：scope 外活动“不得影响可观测延迟”是未定义且当前无法证明的绝对非干扰保证

位置：draft 第 17–22 行，尤其第 21 行。

token 内容、revision、错误和输出不受 scope 外项目变化影响是可实现且应保留的协议不变量；但“scope 外项目的活动不得影响可观测延迟”按字面要求 timing non-interference。当前本地/多主体 composition 共享数据库、CPU、I/O、锁和队列，scope 外写入即使完全不参与 directory revision，也可能通过资源竞争改变响应时间。若把该句作为硬隐私合同，现有架构没有 partition/padding/scheduling 机制或 threat model 可以机械证明；若不按字面测试，它又会成为不可审计的安全宣称。

精确修订建议二选一：

1. 若不把物理 timing side channel 纳入本阶段威胁模型，将条款收窄为：scope 外活动不得作为 token、invalidation、错误选择、响应形状、分页边界或应用层 delay 的输入；共享基础设施负载造成的物理时延不在该语义保证内，并记录部署层侧信道边界。
2. 若坚持 timing non-interference，则必须在 owning design 中加入资源隔离/调度/恒定时间或 padding 模型、攻击者观测能力、可接受泄露预算和机械验证方法；在这些合同闭合前不能声称已满足。

统一错误仍需避免显式 oracle，但不要把 error-shape non-disclosure 与当前系统无法兑现的绝对恒定时延混为一体。

## v2 R1–R5 逐项复核

| v2 项 | v3 结论 | 说明 |
|---|---|---|
| R1 settle/writeback 与 Failed retry | **CLOSED** | 依据 committed admission + settlement 分支；Settled Completed/Interrupted 先写回，Failed/OutcomeUnknown 在 Closed 下 Declined，不回 Pending。 |
| R2 Submit/Inbox replay | **CLOSED** | Submit/Close 顺序、无 message/event/entry、canonical-state-aware no-op/retract 及 replay/rebuild 均已冻结。 |
| R3 lifecycle gate / Tool | **PARTIAL — Blocking R1** | canonical mutation 与 Tool side-effect 边界已补齐；claim gate、in-flight Provider 与 AgentLoopStep drain/settlement 仍缺。 |
| R4 同名与 name key | **PARTIAL — Blocking R2** | 完整授权 snapshot、持久随机 discriminator 已补齐；视觉同名和 policy version 未闭合。 |
| R5 token / revoke / no oracle | **CLOSED at protocol level; new overclaim R3** | 非 bearer、逐页认证、revoke 和统一失败正确；绝对 timing non-interference 需收窄或实现。 |

## 接受链与状态审计

v3 submission 的三对象→独立 review→最终四 SHA 人工决定顺序正确，消除了 v2 对旧 review 的错误绑定。本 review 已固定三个候选对象；最终决定若引用本 review，必须再固定本文件当时的 SHA-256。v2 没有 ACCEPT 记录，最终措辞宜精确写为“旧 v1 decision superseded；v2 draft/submission/review retained as historical REVISE evidence”，不要声称存在 v2 acceptance。

Design Gap 已正确把旧决定收窄为“产品方向及初始规则”，保持 OPEN，并记录 v2 REVISE。建议下一版把 Close drain、ProjectName display safety/version 和 timing threat-model 三项写入其“需治理裁决的最小合同”，或明确该节以被固定 draft/review 为规范扩展；否则 Gap 正文仍只概述旧版最小合同。

另有一个应在 owning contract 落字但不单列 Blocking 的一致性说明：draft 第 67 行“receipt committed 但 execution record 缺失”在既有 Command receipt + Execution 同一 authoritative transaction 下应是 invariant violation/超出正常 crash recovery 的存储不一致，而不是可长期存在的常规分支。若正常 failure domain 可到达，必须给出确定 repair/terminal path；否则应明确其只产生 durable Attention 并进入已声明的 Durability Envelope 外故障处置，不能用该分支削弱第 76 行的正常运行不变量。

## 已确认可保留的合同

- Close 判定使用 durable admission/settlement，不再以“当前 Active”替代“曾 admission”。
- Settled→HumanMessage writeback 的 crash window不丢答；Closed 下无 Failed/OutcomeUnknown retry admission。
- Submit/Close 共享 authoritative lifecycle gate；Close-first 不产生 message/event/Inbox。
- Declined 是可审计终态，延迟事件、重放和 rebuild 不复活 actionable Inbox。
- 所有要求 Open 的 canonical mutation必须在线性化 transaction 内复核；事务外 Open read 不构成授权。
- Close 后不启动新 ToolInvocation，既有/unknown side effect 继续 reconcile，AHT-5 不被绕过。
- Directory token 不是 capability；每页重新认证/授权；revoke 后不返回被撤销行；scope-local revision 与统一错误不泄露对象存在。
- 同名按完整授权 snapshot 分组；discriminator 随 principal/scope 隔离、随机、持久、固定长度、不由 ProjectId 派生。
- ProjectId 仍是 opaque identity/navigation target，名称和 discriminator 都不是 authority。
- 无 hard delete、Reopen、自动 Cancel Work、强杀 Execution，也不合并 Project 与 Workspace。
- owning `docs/design/**` 落字并记录 resolving revision 前，Design Gap 保持 OPEN、实现保持未授权。

## 再审最小证据

下一版至少应提供：

1. Close-drain 的 ProviderTurn/AgentLoopStep/action/settlement disposition matrix，以及 claim/Close 的明确 gate；
2. versioned ProjectName/display-safety policy，含 invisible/bidi/visual-collision 处置；
3. 收窄后的协议时延条款，或可证明 timing non-interference 的 threat model 与机制；
4. draft、Gap、submission 新 SHA；独立 review 后由最终决定固定四 SHA。

## 审阅范围

本次对照了 `AGENTS.md`、冻结 Problem/Goals、DID Project/Execution lifecycle、Stop/Quiescence 与 AHT-1…AHT-8，P2 admission、P3 AgentLoopStep、P6 Inbox、P9 recovery、P14 HumanMessage claim/retry/settle→writeback 合同，以及 v2 review 的 R1–R5。未运行实现测试；未修改 `docs/design/**`、实现代码或三个被审阅对象。
