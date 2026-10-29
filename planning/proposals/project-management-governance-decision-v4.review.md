# 项目管理治理提交 v4 — 独立审阅意见

日期：2026-09-30。

## 不可变审阅对象

本审阅只适用于以下字节版本：

- `planning/proposals/project-management-decision-draft-v4.md`  
  SHA-256 `BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
  SHA-256 `38FFB74ED2A9C86B0779991BA8E62F5DC588F8616B4F8DCDC3189E8B18026681`
- `planning/proposals/project-management-governance-submission-v4.md`  
  SHA-256 `ABCF21E3D84F12C900993E520B5638B5D862CDDD9ABC6F6C9477F4A2C4D06E07`

三个 SHA-256 均已与磁盘字节复核一致。任一对象发生字节变化，本审阅自动失效。

## 结论

**REVISE — Blocking = 3。不得接受 v4，不授权实现，不得将 DPM-DG-01 标为 RESOLVED。**

v4 已关闭 v3 R3：目录只承诺协议层 non-disclosure，明确排除共享基础设施物理 timing non-interference；token、逐页认证、revoke 线性化、统一错误和 scope-local revision 的合同现在可机械验证。

v4 也正确补入了 claim gate、durable StopExecution 请求、每步 Project lifecycle 复核、Provider/Tool 既有结果接收、名称 policy/Unicode/UTS #39 固定表、视觉 collision、server-only key/skeleton 和迁移必须显式等重要合同。但 Stop/Quiescence matrix 仍与冻结 Settlement/AHT ADT 有两个接口断点，ProjectNamePolicy v1 的**首次采用迁移**没有处置 legacy 非法/非规范名称；同时被固定的 Design Gap 与 draft 对 Close 是否自动 StopExecution 给出相反规则。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-V4-R1 / P1：Provider OutcomeUnknown、OutputRejected 与 NextStepReady 仍不能按现有 Stop/AHT 合法收敛

位置：draft 第 48–66、89、103 行；DID §3.4/§8.16；P2 `01-command-contracts.md` §7、`03-lease-fencing-model.md` §5；P3 `08-agent-loop-step-handoff.md` §§4、8、10。

### 1. Provider 无 terminal evidence 时不能构造现有 OutcomeUnknown

第 59 行规定 in-flight Provider 请求无法取得 terminal evidence 时形成 `OutcomeUnknown(ReconciliationRequired)`。但冻结 ADT 要求 `ReconciliationRequired.invocationRefs` 非空；P2 `SettleExecution` 明确拒绝空 refs。该 refs 集合由 unresolved side-effectful **ToolInvocation** 提供，DID 对 `OutcomeUnknown` 的定义也是“外部副作用是否发生未知”。ProviderTurn 不是 ToolInvocation，也没有可填入该 ADT 的 invocationRef。用假的 ref 会破坏 AHT-5/reconciliation 真实性；扩展为 ProviderTurnRef 则是新的 Settlement ADT 设计，不能由本草案暗中完成。

既有 P3 provider Stop 合同已经给出合法方向：in-flight Turn 受 cancellation，形成 `TurnFailed(StreamInterrupted)` 或 controlled interruption；它不能产出 accepted partial output。Close drain 应明确使用这条路径。若完整 success evidence 已存在，必须先按 AHT-2 本地收敛；若只有不完整 stream/transport failure 且无 tool side effect，则应形成既有 Interrupted/Failed，而不是无 refs 的 OutcomeUnknown。只有同时存在真实 unresolved ToolInvocation refs 时，Execution 才能 OutcomeUnknown。

### 2. matrix 遗漏 `OutputRejected`

冻结 `AgentLoopStepState` 包含 `OutputRejected`，而第 56–64 行没有该行。`OutputRejected` 又至少有两种不同 durable disposition：`Retry(successor)` 已经固定完整 successor identity；`Exhausted(settlement)` 应推进已决定的 settlement。二者不能统一按 Prepared、ProviderResultAvailable 或 NextStepReady 猜测。Close 恰在 OutputRejected commit 后发生时，当前 matrix 没有合法下一步，违反第 66/89 行“不永久 Active/Claimed”的声明。

### 3. `NextStepReady` 不能直接跳成 SettlementProposed

第 62 行要求 `NextStepReady` 不启动 durable successor、由停止协议直接提出 Interrupted。AHT-6 和 P3 `08` §8 已冻结：predecessor committed/successor absent 的 crash window必须调用幂等 `ensureSuccessor`，创建**恰好那个** `Prepared` successor；不得重算或抹去已提交的 successor 决定。`AgentLoopStep` 转移还要求 monotone/no-skip。直接把已有 `NextStepReady` predecessor 改写为 SettlementProposed 会覆盖不可变 successor 决定；不创建 successor又违反 AHT-6。

这里必须区分“创建已承诺的 successor record”与“启动新的 ProviderTurn”。Close 后仍应允许 `ensureSuccessor` 物化 exact `Prepared` successor（不发 Provider 请求），然后该 successor 在 lifecycle/stop gate 前被确定性 Interrupted；或由人工治理正式修改 AHT-6。后者会触及冻结设计，不能留给实施猜测。

精确修订建议：

1. Provider drain 改为：complete success evidence → AHT-2/AHT-3 本地收敛；incomplete/cancelled provider attempt → 既有 terminal provider failure + Interrupted/Failed；OutcomeUnknown 仅在存在非空、真实 ToolInvocation refs 时使用。
2. matrix 增加 `OutputRejected(Retry(successor))` 与 `OutputRejected(Exhausted(settlement))` 两行，分别保持已固定 successor/settlement identity。
3. `NextStepReady` 和 OutputRejected-Retry 必须执行 `ensureSuccessor` 以闭合 AHT-6 crash window，但 gate 禁止该 successor 发起 Provider 请求；exact successor 的 Prepared 状态再通过既有 stop path形成 Interrupted。
4. 明确 stop-generated SettlementProposed 使用哪个 AgentLoopStep identity/state transition，不能就地覆盖已经 terminally committed 的 predecessor disposition。
5. 验收加入：provider complete-success-before-cancel、不完整 stream、OutputRejected 两分支、predecessor committed/successor absent、successor Prepared/provider-not-started，以及真实 tool refs 与 provider-only 无 refs 两类 OutcomeUnknown 判定。

在上述修订前，v3 R1 仍为 **PARTIAL / Blocking**；claim gate 本身已关闭。

## DPM-V4-R2 / P1：ProjectNamePolicy v1 的首次迁移没有定义 legacy 数据处置

位置：draft 第 23–35、93–95、103 行。

对 v1 之后的新 Create/Rename，固定 Unicode 15.1、UTS #39 15.1 打包表、拒绝 Cc/Cf/Cs/Co/Cn、持久化 policyVersion/key/skeleton 与视觉 collision 已关闭 v3 的新写入风险。

但当前数据库中的 `Project.name` 是 policy v1 之前的 canonical data，可能包含：

- v1 会折叠/trim、因此持久名称会改变的 whitespace；
- v1 明确拒绝的 control/format/private-use/unassigned code point；
- 已有名称之间新出现的 comparison/skeleton collision；
- 缺失 policyVersion/nameComparisonKey/displaySkeleton 的行。

“任何策略升级必须显式迁移”只描述未来版本升级，没有决定**首次采用 v1**时如何处理这些行。DDL 若静默 NFC/trim/rename 会无 `ProjectRenamed` 审计地改变 canonical Project 名称；若简单失败，升级可能永久阻塞；若保留 raw legacy name 却标记 v1，又会伪造策略符合性并使 Create/Rename/目录分组使用不同函数。discriminator mapping 在首次 backfill 出现新视觉 collision 时也需要确定的稳定分配与重放规则。

精确修订建议：

1. 冻结 initial-adoption preflight：只读扫描所有 legacy names，用打包的 v1 表生成分类报告和确定 digest；在任何写入前证明迁移集合。
2. 已符合 v1 且规范化结果与原值相同：原子 backfill policyVersion/key/skeleton。
3. 可规范化但值会改变、或 v1 拒绝的 legacy name：不得由 schema migration 静默改名。选择并冻结一种治理路径，例如 migration fail-closed + durable/manual remediation；或显式、审计化 legacy rename command/event。必须说明 project revision、updatedAt、event 与 directory invalidation 是否变化。
4. 首次生成 discriminator mapping 必须以 principal/scope/collision component 的确定 snapshot 进行、带唯一约束和幂等重放；不得因扫描顺序产生可观察序号或跨 scope 关联。
5. migration 完成条件必须证明：每个 Project 恰有一个受支持 policyVersion，key/skeleton 与 persisted name 一致；不存在“legacy bypass”写路径。加入 legacy NUL/ZWSP/RLO/private-use/unassigned、whitespace normalization、collision backfill 和 crash-restart fixture。

因此 v3 R2 对**策略定义**已关闭，对**现有数据迁移**仍为 Blocking。

## DPM-V4-R3 / P1：固定 Design Gap 与 draft 对 Close 是否自动 StopExecution 直接矛盾

位置：draft 第 52、107 行；Design Gap 第 57–60、78 行。

draft 第 52 行冻结：Close 后 control plane 对每个 Active Execution 自动提交既有 `StopExecution`，这是 v4 能阻止新 Provider/Tool/action 并最终 quiesce 的核心机制。draft 的非目标只排除“强杀 execution”，没有排除 cooperative stop request。

但同一轮被固定、拟由最终决定共同接受的 Design Gap 第 78 行仍写“不实现……自动停止执行”。按通常语义，自动提交 `StopExecution` 正是自动停止执行；Gap 第 59 行还保留旧表述“不能擅自终止”，没有记录 v4 已选择 cooperative Stop/Quiescence。最终 ACCEPT 若同时固定这两个对象，将无法判断实现自动 stop request 是满足 draft 还是违反 Gap。

精确修订建议：

1. 将 Gap 非目标改为“不强杀 Execution、不自动 Cancel Work；Close 会按 accepted v4 对 Active Execution 自动提交 cooperative StopExecution/Quiescence”。
2. Gap 的最小合同补充 v4 的 claim gate、Stop/AHT drain、ProjectName policy/migration 和协议隐私边界，或明确这些由固定 draft 规范性扩展；不要让 Gap 继续呈现旧版“自然运行至 settlement”的含义。
3. 修订 Gap 后产生新 SHA，并重新 review；不能用当前 review/未来 ACCEPT 跨哈希接受。

这是同一治理包内的直接语义冲突，必须作为 Blocking 处理。

## v3 R1–R3 复核表

| v3 项 | v4 结论 | 证据 |
|---|---|---|
| R1 Stop/Provider/AgentLoopStep drain + claim gate | **PARTIAL — Blocking R1/R3** | claim、durable stop、activity gate 和多数状态已补齐；Provider-only OutcomeUnknown 不符合 ADT，OutputRejected 遗漏，NextStepReady 与 AHT-6 冲突；Gap 又否定自动 stop。 |
| R2 ProjectName visual safety/version | **PARTIAL — Blocking R2** | 新写入 policy、UTS #39 表、持久 key/skeleton 和视觉 collision 已闭合；首次 legacy migration 未决定。 |
| R3 directory timing/privacy | **CLOSED** | 明确协议层输入/错误/形状/人为 delay non-disclosure，并把共享资源物理 timing 排除、未来另行治理。 |

## 已确认正确、可保留的内容

- Directory token 不是 bearer authority；逐页重认证、scope binding、visibility revision 与逐行授权处于同一一致性边界。
- revoke 后不再返回该行；invalid/mismatch/unauthorized 使用无对象存在性泄露的统一失败；resolver failure fail closed。
- scope 外活动不进入 token、invalidation、错误、响应形状、分页或人为 delay；物理 timing threat model 的边界表达诚实且可审计。
- claim 与 Submit/Admit/Open-required mutation 均进入 Project lifecycle gate；CreateProject bootstrap 被明确排除。
- Close→Stop command identity 对 `(projectId, close revision, executionId)` 确定，重放可幂等；driver 在新 activity 前复核 Project lifecycle。
- complete Provider/Tool evidence、Session/observation、reconciliation 和 SettleExecution 在 Closed 下可继续；不强杀、不自动 Cancel Work。
- HumanMessage 的 admission/settlement/writeback/Declined 分支继续保持 v3 已关闭的无丢答、无永久 Pending 语义。
- ProjectName policy 固定 Unicode/UTS #39 数据，不受 runtime ICU 漂移；危险 categories 对新写入拒绝；comparison/skeleton 不出服务端。
- visual collision 在完整授权 snapshot 上计算；discriminator 随 scope 隔离、持久、随机、固定长度且非 ProjectId 派生。
- 四对象接受链正确；v1 标为 superseded、v2/v3 保留为 REVISE evidence 的措辞准确。
- owning `docs/design/**` 落字并记录 resolving revision 前，Gap 保持 OPEN、实现保持未授权。

## 再审最小证据

下一版至少应提供：

1. 与现有 Settlement ADT/AHT-6 一致的 Provider-only failure、OutputRejected 与 successor materialization matrix；
2. ProjectNamePolicy v1 initial-adoption migration 对 compliant/normalized-change/rejected legacy name 的完整处置与 crash fixture；
3. 与自动 cooperative StopExecution 一致的 Design Gap；
4. draft、Gap、submission 的新 SHA；独立 review 后由最终治理决定固定四 SHA。

## 审阅范围

本次对照了 `AGENTS.md`、冻结 Problem/Goals、DID Execution Settlement、Stop/Quiescence 与 AHT-1…AHT-8，P2 Stop/Settlement validation、P3 Provider cancellation/AgentLoopStep successor contract、P9 recovery、P14 HumanMessage convergence，以及 v3 review 的 R1–R3。未运行实现测试；未修改 `docs/design/**`、实现代码或三个被审阅对象。
