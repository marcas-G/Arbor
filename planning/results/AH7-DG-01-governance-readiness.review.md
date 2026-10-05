# AH7-DG-01 治理决策稿审阅

日期：2026-10-05

对象：`planning/proposals/tool-settlement-observation-replay-decision-draft.md`

当前 SHA-256：
`6FCBE39E781636AE1FAB92302386D0C2960FE215AD417495A58E765EE63766FA`

结论：**可提交人工治理决策；未接受、未授权实施新持久字段。**

## 证据充分性

隔离红灯 `tests/functional/pending/ah7-settled-expected-failure-reentry.functional.test.ts`
在相同 invocation identity 下预置持久 `ExpectedFailure` 与空 resultRef，且 AgentLoop
尚无 sourced ToolResult。executor 和 settlement writer 必须不再运行。当前代码返回
`OutcomeUnknown`，而非原 `ExpectedFailure` + bounded Observation。该反例证明现有
P4 settlement 行不含足以交给模型的原始观察证据；不是测试脚本等待不够。

冻结 P3 `08` 要求稳定来源的即时 Observation；P4 `01/06` 允许 resultRef 为空，
且只规定 settlement tag。两者跨事务崩溃时没有明确的模型可见观察持久化所有权。
建议稿把 bounded Observation/版本/哈希与 P4 terminal settlement 同事务建立，
历史证据不足则显式失败关闭；没有把已知业务失败伪装成未知外部效果。

AH7 的 ReadOnly Success 可通过 Artifact 重放，不能外推到 ExpectedFailure、
Interrupted 或 RuntimeFailure；这份红灯保持在 pending 配置，不计入正式 PASS。
本审阅不构成人工接受，且不授权修改 `docs/design/**`。
