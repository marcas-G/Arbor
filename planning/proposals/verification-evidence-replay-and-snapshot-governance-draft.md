# 验证证据重放身份与结论快照——治理决策稿

状态：**草稿，待人工治理**
实施：**本稿未授权**
建议接受标识：`ACCEPT_VERIFICATION_EVIDENCE_REPLAY_SNAPSHOT_CONVERGENCE`

## 已冻结目标与实际缺口

P8 `04` §2 已冻结 `CriterionResult` 为结论快照的值对象，并要求
Verification 行持久保存 `missionSnapshot` 与 `criteriaResults` JSON。
本稿不重新裁决该目标。当前 Domain `Verification`、Repository Port、
SQLite 行、`VerificationConcluded` 事件和已提交命令结果均未保存逐 criterion
结果。事件只有整体 verdict、合并后的 `evidenceRefs` 和 `summaryRef`；
证据行有 criterion 身份，却没有该 criterion 的 verdict。命令回执保存
请求指纹，不保存原始 payload。因此现有权威事实无法重建完整
`criteriaResults` 快照。

隔离红测
`tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts`
通过真实控制 handler、CommandGateway 和 SQLite 提交两条不同 verdict 的
criterion 结果。命令已提交，Verification 有整体 verdict 与 `summaryRef`，
事件/结果有合并的证据引用，但重读 Verification 得不到逐项快照。
历史已结论行同样没有可用于精确回填的来源。

## `recordedAt` 的稳定来源未定

P8 `04` 定义持久字段 `recordedAt`，但未指定重放时应取哪个稳定事实。
当前控制 handler 每次调用都生成新的 `clock.now()`；该值参与
CommandGateway 请求指纹。同一个 CommandId 重试时指纹可能变化，
被拒为 `IdempotencyConflict`。

需要人工选择的候选来源：

1. 已结算 ToolInvocation 的时间：持久且稳定，但含义可能是“工具完成”，
   而不是“证据被记录”。
2. 有来源的 Session ToolResult 创建时间：稳定，表示观察何时可见。
3. Runtime 在首次提交命令前选定并持久化证据记录时间，后续重试复用。

不得在实现中悄悄替换时间来源；若所选方案需要新的持久状态，须明确
所属对象、写入边界和迁移。

## 历史结论行

当前历史库无法精确恢复 `criteriaResults`：Evidence 行无逐项 verdict；
`VerificationConcluded` 只有整体 verdict 与合并后的证据引用；
回执只有指纹/结果，没有原 payload；Verification 行也无该数组。

人工治理须决定旧行如何表示：显式标记“逐项快照不可用”；仅在确有
独立耐久原文时回填、其余标记不可用；或在接受操作员控制的核对政策前
阻止迁移。不得从整体 verdict 或“存在证据”推断逐项 verdict。

## AH10 回执与重放边界

两个验证控制 handler 目前都按 `providerTurnId:outputPosition` 派生固定
CommandId，没有纳入 lease generation，也未接共用的旧回执查询。
P1 `07` 要求跨代先查旧回执：旧 `FencingRejected` 且动作仍 Pending 时
才允许新代 CommandId；旧 Committed 必须从匹配的权威事实收敛；
非 fencing 终态拒绝不得因换代被抹除。

`tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts`
使用真实 Composition、Gateway 和 SQLite，复用同一控制动作时因
`recordedAt` 改变而得到不同指纹及 `IdempotencyConflict`。这独立于
尚未实现的 AH10 跨代分支。

## 裁决后的退出门

1. 人工确定 `recordedAt` 的稳定来源和历史已结论行处置；P8 `04` 的
   逐 criterion 快照目标保持不变。
2. 按已接受合同授权实现快照持久化、重放验证及必要迁移；旧行不得
   被赋予推断出的 verdict。
3. AH10 测试覆盖旧代围栏拒绝、匹配的旧成功回执、非围栏拒绝、缺失或
   冲突的 Evidence/Verification 事实，以及同 CommandId 同指纹重试。
4. Conclude 测试核对完整逐项快照、内容寻址 `summaryRef`、事件/结果
   一致性和终态 SettleExecution 恢复。
5. RecordVerificationEvidence 恢复核对持久 Evidence 行及 Runtime
   绑定的 ToolObservation 来源四元组；`recordedAt` 依获接受来源比较。

本稿不修改 `docs/design/**`，不作业务裁决，也不授权产品代码或迁移。
