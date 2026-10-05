# AH7-DG-02 治理决策稿审阅

日期：2026-10-05

对象：`planning/proposals/reconcilable-shell-reality-proof-decision-draft.md`

当前 SHA-256：
`41E0998B6B93648C0D0CA5767C97628F091E54E757299D1D585D0B4E71B50A9A`

结论：**可提交人工治理决策；未接受、未授权更改 shell 的副作用分级。**

真实进程用例在 shell 实际追加临时文件之后、P4 settlement 之前杀进程。
重启时文件未被二次追加，Action 保持 ReconciliationPending，Execution 为
OutcomeUnknown；该 PASS 只证明没有盲重放。冻结 P4/P9 要求 Reconcilable 先
核对现实，但当前 ToolExecutor 没有 per-invocation reconcile 能力，通用 shell
文本也没有统一、可证明的外部效果身份。

决策稿选择“通用 shell 默认 NonIdempotent，受限且具可执行证明的 profile 才可
Reconcilable”，同时定义三态核对与旧记录失败关闭。此稿改变副作用分类语义，
不能由代码测试结果自动授权；须人工接受后更新拥有文档、做迁移与完整资格测试。

本审阅不是人工接受，不允许修改 `docs/design/**`。
