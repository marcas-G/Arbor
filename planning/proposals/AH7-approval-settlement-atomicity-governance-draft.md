# AH7 Approval 消费与 Tool Settlement 原子性 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**
缺口标识：**建议 AH7-DG-03；待治理登记**
实施：**未授权**
建议接受标识：`ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`

## 缺口与证据

P4 `02` §1–§2规定 Permission/Approval match+consume 先于 Sandbox 与 Execute；
P4 `06` §5规定 approval consumption 与 settlement 共享事务。现有 ToolRuntime
先持久化 intent，再在独立事务消费 approval，执行外部 effect，最后在另一独立事务
持久化 ToolInvocation settlement。

隔离红测
`tests/functional/pending/ah7-approval-settlement-atomicity.functional.test.ts`
使用真实 SQLite `ToolInvocationStoreLive` / `TransactionPortLive` 和生产
`ToolRuntimeLive`。在 `AH7AfterToolEffectBeforeSettlement` 注入中断后，观测到：

- 外部 effect 已运行一次；
- ToolInvocation intent 已存在但尚未 settlement；
- approval 的 `consumed_by` 已是该 invocation ID。

测试的 P4 `06` 同事务预期要求 approval 未消费且 settlement 未写入。实际值与预期值
仅在 `consumed_by` 不同处冲突。该测试是确定性 effect-before-settlement 故障注入，
不是公开功能旅程或真实进程崩溃资格。

## 必须由治理选择的语义

1. **保留执行前消费。** P4 `02` 的 match+consume 在 effect 前耐久提交；P4 `06` 改为
   不要求 approval consumption 与终态 ToolInvocation settlement 同事务。崩溃可留下
   `consumed approval + unsettled invocation`；恢复按原 SideEffectSemantics 对同一
   invocation 失败关闭/核对，approval 永不因恢复自动释放或转给另一 invocation。
2. **终态 settlement 时消费。** P4 `02` 区分执行前 exact approval validation 与执行后
   consumption；P4 `06` 将 approval consumption 和 ToolInvocation settlement 放在同一
   数据库事务。需明确并发调用、effect 已发生但事务未提交、approval 再利用和恢复规则；
   此选项改变当前执行前单次消费语义。
3. **新增耐久 reservation / claim。** 执行前原子占用 exact approval，执行后在 settlement
   事务中消费；必须定义 reservation 的身份、有效期、并发胜出、崩溃回收及与外部 effect
   reconciliation 的关系，并评估迁移。该选项引入新的持久状态。

以上是待裁决选项，不构成新语义决定。不得在实现中自行挑选、混合或以测试绿灯替代
人工接受。若 governance 不接受任何选项，应保持当前设计缺口与隔离红测，不声称 AH7
闭合。

## 接受后的落字范围与实施门

人工接受后，按既有人工治理委托可由 Codex 代为应用**完全一致的已接受落地包**到
拥有合同的文档，至少审查 P4 `02`、P4 `06` 和 DID/P4 权限消费语义；若影响
P3/P9 的恢复合同，则同步更新对应拥有文档。记录被接受提案的
SHA-256、决策记录、文档修订与落地一致性审阅。落地一致性 PASS 后，另行明确实现授权；
本稿本身不授权代码或迁移。

实现授权后的退出证据至少包括：

1. 精确 approval、invocation、Execution、action digest 和 control basis 在并发与重入时
   绑定一致，另一个 invocation 不能借用或抢占该 approval；
2. 在 approval mutation、intent commit、外部 effect、Tool settlement 的每个相关边界
   两侧注入进程崩溃并重启；
3. 对 ReadOnly、Idempotent、Reconcilable、NonIdempotent 依 P4 规则验证重放、核对或
   fail-closed；effect 已发生时不能盲重放；
4. 重复 recovery 不产生额外外部 effect、approval 消费、settlement 或 Observation；
5. 真实 SQLite 并发/事务资格与真实进程 crash qualification 分开报告，后者通过前
   不宣称 AH7 此 seam 完成。
