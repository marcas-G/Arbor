# AH7 Approval / Tool Settlement Gap — Governance Readiness Review

日期：2026-10-07
对象：`planning/proposals/AH7-approval-settlement-atomicity-governance-draft.md`
提案 SHA-256：
`970AA61BAF2A56C4BBC19EE4532D64BDBBA6F7310BC8BC40C97804B66A292FEA`

结论：**证据足以提交人工治理决策；未接受，未授权实现。**

## 精确事务序列

冻结 P4 `02` §1–§2 的流水线要求 Approval match/consume 在 Sandbox 与 Execute 前；
P4 `06` §5 又要求 approval consumption 与 ToolInvocation settlement 同事务。
当前 `packages/tool-runtime/src/runtime.ts` 的相关顺序为：

1. `findApproval` 并校验 exact approval；
2. ResourceAdmission；
3. `findById`，随后在单独 `TransactionPort.transact` 中 `recordIntent`；
4. 在另一个事务中 `consumeApproval`；
5. Sandbox open、外部 effect；
6. `AH7AfterToolEffectBeforeSettlement` 故障注入点；
7. 在另一个事务中 `settle`。

因此 effect 已发生、settlement 尚未提交时，Approval 已消费。现有实现不能同时展示
P4 `02` 的耐久前置消费与 P4 `06` 的同 settlement 事务保证。

## 隔离红测

`tests/functional/pending/ah7-approval-settlement-atomicity.functional.test.ts` 使用
真实 SQLite P4 migration、`ToolInvocationStoreLive`、`TransactionPortLive` 与生产
`ToolRuntimeLive`，在 effect 已执行后、`settle` 前注入异常。运行命令：

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah7-approval-settlement-atomicity.functional.test.ts
```

失败证据：外部 effect 次数为 1，intent 行存在且 `settlement_kind` / `settled_at` 为
NULL；但数据库实际 `consumed_by` 等于该 `ToolInvocationId`，而同 settlement 事务
预期为 NULL。红灯只定位合同冲突，不证明真实进程崩溃，也不构成公开旅程 PASS。

## 裁决与后续门

提案列出三种互斥候选：保留执行前消费并澄清 P4 `06`；在终态 settlement 时消费并
澄清 P4 `02`；或引入耐久 reservation/claim。选择会改变消费、并发和恢复语义，不能由
测试或实现自行决定。应由人工治理选择并在拥有文档落字，保存接受 token、proposal
hash、修订与落地一致性审阅；只有治理落地 PASS 后，才另行授权实现。

本审阅不修改 `docs/design/**`，也不授权产品代码或迁移变更。恢复授权后需完成精确
approval/invocation 绑定、并发和各耐久边界两侧的真实进程 crash qualification，并
分别报告 SQLite 与进程级证据。AH7 保持 PARTIAL / OPEN。
