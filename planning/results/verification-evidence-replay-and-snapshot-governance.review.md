# 验证证据重放与逐项结论快照——治理审阅

日期：2026-10-07
对象：`planning/proposals/verification-evidence-replay-and-snapshot-governance-draft.md`
提案 SHA-256：`8C6341728549E928450CC8467CE788121BE2EB6F203CBDD4909A7443924F57BF`

结论：**失败证据可提交人工治理；方案未接受，实施未授权。**

## 已执行的隔离证据

两条测试都使用真实 Composition、CommandGateway、P32 SQLite 和生产控制
handler，仅由 `vitest.pending-functional.config.ts` 运行。

1. `ah10-verification-recorded-at-fingerprint.functional.test.ts`：首次命令
   Committed；两次动作使用同一确定性 CommandId，但 `clock.now()` 使
   `recordedAt` 与生产请求指纹变化。持久回执仍保留第一次指纹，Evidence
   行只有一条，第二次返回 `IdempotencyConflict`。最终“同一不可变请求应
   成功收敛”的断言失败；不是夹具导入或前置数据错误。
2. `p8-conclusion-criteria-snapshot.functional.test.ts`：真实结论命令已
   Committed；Verification 为 Concluded 且有持久 `summaryRef`，事件的
   `summaryRef` 与合并证据引用匹配，两条 criterion Evidence 行存在。
   最终重读 Verification 得到 `criteriaResults: null`，与 P8 `04` 冻结的
   两条不同 verdict 的逐项快照相冲突。

定向 pending 合跑 **2 个预期失败**；主 Agent 独立复现。它们不证明
进程崩溃恢复，也不关闭 AH10 回执矩阵。

## 合同与历史数据

P8 `04` 已决定必须持久保存逐 criterion 快照，这不是待选的产品目标。
当前 Verification Domain/Store/行没有该成员；历史 Evidence 只有 criterion
身份而无 verdict，事件只有整体 verdict 和合并证据引用，回执没有原始
`criteriaResults` payload，无法无损回填历史结论。

`recordedAt` 虽为 P8 持久字段，但合同没有指定其稳定时间来源。
提案列出 ToolInvocation settlement、来源 Session ToolResult 创建时间和
Runtime 首次持久选择时间三种互斥候选；选择会影响时间含义与迁移，不能
由实现者悄悄决定。

人工治理须明确旧结论行的“逐项快照不可用”表达和 `recordedAt` 来源；
按接受提案落地所属文档并复核后，另行授权实现及迁移。此审阅不修改
`docs/design/**`，不授权产品代码，也不把 pending 红测计入绿色门禁。
