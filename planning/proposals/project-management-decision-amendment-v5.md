# 项目管理决策修订包 v5

## 状态与适用范围

**DRAFT — 尚未接受，不授权实现。**

本修订包以 v4 draft 的固定 SHA-256 BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25 为基线；除本文明确替换的条款外，v4 DPM-1、DPM-2、DPM-3、DPM-4、DPM-5 均原样纳入。本包与该固定 v4 基线共同构成 v5 的完整候选语义。最终决定必须固定 v4 base、本文、Design Gap、v5 submission 和独立 review 的哈希。

本包处置 v4 review 的 R1…R3；不以修改冻结 DID/P3/P9/P14 为前提，也不把既有 ADT 偷换为新语义。

## V5-1：Close drain 与既有 Provider / AgentLoopStep / Settlement 合同

Close 对 Active Execution 发出既有、幂等的 cooperative StopExecution/Quiescence 请求，identity 为 (projectId, closeRevision, executionId)。这不是强杀，也不自动 Cancel Work。Project lifecycle gate 禁止 Close 后新 autonomous admission、new ProviderTurn、new ToolInvocation 和 AgentAction；但允许既有 Stop/Quiescence、recovery、settlement、已开始外部操作的结果接收与 reconciliation。

Close 发生后，driver 对每个 step 按以下已有事实收敛；不能从 Session 文本推测，也不能永久停在非终态：

| durable 状态 | 强制处置 |
|---|---|
| Prepared，尚无 ProviderTurn/Tool intent | 既有 Stop/Quiescence 控制路径产生 Interrupted(ControlledInterruption/StopRequested)；不启动 Provider。 |
| 已发 Provider attempt，尚无完整 terminal evidence | 请求既有 provider cancellation；完整 success 若已获得则按 AHT-2/AHT-3 落盘与本地 handoff。只有不完整流/取消/transport terminal failure且无真实 unresolved ToolInvocation 时，形成既有 TurnFailed(StreamInterrupted) 并确定 Interrupted 或 Failed；不得构造没有真实非空 invocationRefs 的 OutcomeUnknown，也不得 retry/new turn。 |
| ProviderResultAvailable / OutputAccepted | 仅持久化已获得 output/session facts；不启动 action。再依既有 stopping transition 提出 Interrupted，除非已有更强的 durable SettlementProposed。 |
| OutputRejected(Retry(successor)) | 不改变已提交 disposition；必须调用既有幂等 ensureSuccessor，物化那个精确 Prepared successor（该持久化是 AHT-6 recovery consistency write，不是 autonomous Provider admission），随后在 stop gate 下把该 Prepared successor 确定性 Interrupted，绝不发 Provider 请求。 |
| OutputRejected(Exhausted(settlement)) | 保持已决定 settlement identity，推进既有 SettlementProposed / SettleExecution。 |
| ActionsInProgress | 已开始 action 依 AHT-5 reconcile；未开始 action 由 stop disposition 跳过。仅当存在真实、非空 unresolved ToolInvocation refs 时，既有 OutcomeUnknown(ReconciliationRequired(refs)) 合法；否则用 Interrupted/Failed。 |
| StepEffectsCommitted / NextStepReady(successor) | 先 ensureSuccessor 物化已承诺的 exact Prepared successor，绝不重算或跳过 predecessor 的 AHT-6 successor 决定；随后对 successor 走 Prepared stop 分支，不发 Provider。 |
| SettlementProposed | 提交已 durable proposal 的 SettleExecution。 |
| Settled | 不改 settlement，只完成 writeback/reconciliation。 |

Stop-generated settlement 必须使用现有 AgentLoopStep identity 与单调 transition；不得就地覆盖已提交 predecessor disposition。Provider-only 的未知/中断不是 Tool Invocation outcome unknown。只有工具副作用是否发生未知、且有真实 refs 时才允许既有 OutcomeUnknown。所有 Provider/Tool terminal evidence先写入 durable records再按矩阵收敛。

Close、SubmitHumanMessage、Pending→Claimed claim、新 AdmitExecution 与所有既有 Project Open-required canonical mutations共享 lifecycle gate；CreateProject 的 absent→Open bootstrap 明确不在此竞争集合中。Close-first 后 claim 不得成功；claim-first 后 Close 按 durable admission receipt/execution settlement 决定 Declined、Answer或drain。已 admission conversation execution 的 Completed/Interrupted settle→writeback 优先于 Declined；Failed/OutcomeUnknown 在 Closed 下 Declined，不回 Pending。延迟 HumanMessageSubmitted replay/rebuild 对 Declined 必须 inbox no-op/retract。

必须验证：Close 位于 claim、Provider success/stream interruption、每个 AgentLoopStep handoff、OutputRejected 两分支、action intent/effect、NextStepReady successor absent、Prepared successor、SettlementProposed、settle→writeback 和 Inbox replay 两侧；正常 durability envelope 内没有 Closed Pending、无主 Claimed 或永久 Active step。

## V5-2：ProjectNamePolicy v1 的首次采用与 legacy 处置

ProjectNamePolicy v1 继续固定 Unicode 15.1.0 NFC、UTS #39 15.1.0 bundled tables、Cc/Cf/Cs/Co/Cn 拒绝、1…120 scalar、versioned key/skeleton、完整授权 snapshot visual-collision discriminator。comparison key/skeleton 永不进入目录外部 DTO。

首次采用 v1 必须先进行**只读 preflight**：用打包 v1 tables 扫描全部 legacy Project.name，输出可复验的 report digest，至少按下列集合分类：已合规且规范化值不变；可规范化但值会改变；v1 拒绝；新 key/skeleton collision；缺少 policy metadata。preflight 在任何 backfill/DDL semantic write 前完成。

- 只有“已合规且值不变”的行可在原子、可重放 migration 中 backfill policyVersion=1、key、skeleton；canonical name、Project.revision、updatedAt 与 domain event 不变。
- 可规范化后值改变、v1 拒绝、或 policy metadata/derived facts 不能一致的行，令项目目录功能启用 **fail closed**：不静默 trim/NFC/rename，不伪装标成 v1，不发假 ProjectRenamed。迁移报告列出稳定 project identity 供人工治理处理。
- 本修订包不发明 Closed 项目的 rename bypass。对不合规 legacy 数据，须先由独立、人工治理的数据修复决定定义审计 command/event、Closed 规则、revision、updatedAt、directory invalidation与授权，或在治理外明确修复原始数据并重新运行 preflight；在此之前不得启用 ProjectDirectory/Rename/Close product surface。
- 所有行通过 preflight 后，首次 discriminator backfill 在 per-principal/scope/collision-component 的确定 snapshot 上执行，使用唯一约束、随机固定长度值与幂等 key；扫描顺序不形成用户可观察序号，crash/restart 重放不能产生第二个 mapping或跨 scope 关联。
- migration exit proof：每个 Project 恰有一个受支持 policyVersion；key/skeleton 与 persisted name 一致；没有 legacy bypass 写路径；包含 legacy NUL/ZWSP/RLO/private-use/unassigned、whitespace change、collision backfill 和 crash-restart fixtures。

## V5-3：Design Gap 同步与无矛盾非目标

DPM-DG-01 的本轮规范性扩展为本修订包 V5-1/V5-2 和 v4 directory privacy contract。其非目标必须表述为：

“Close 不强杀 Execution、不自动 Cancel Work；但会按已接受项目管理合同，对 Close 时 Active Execution 自动提交既有、协作式 StopExecution/Quiescence。它禁止新的模型/工具/业务动作，并让已开始的操作和执行按既有 durable recovery/settlement 收敛。”

因此“协作 StopExecution”是归档的一部分；“不强杀/不取消”仍是非目标。任何与此冲突的旧自然收敛措辞均由本包取代。

## 接受后的设计落地要求

只有人工治理将 v4 base + 本 v5 修订包的 accepted rules 写入 owning docs/design/**，记录 resolving revision，并把 DPM-DG-01 标为 RESOLVED 后，方可实现。落地必须引用 P3/P9 已有 AHT-6 successor 与 P2 Settlement ADT，而非新建 ProviderOutcomeUnknown 或项目专属 execution lifecycle。

