# AH4 终态失败 / 修复耗尽 → SettlementProposed 崩溃资格结果

日期：2026-10-04

状态：**终态 Provider 失败与输出修复耗尽，各提交边界两侧 4/4 PASS；
`pnpm check` 与完整功能批次 PASS。**

测试：`tests/functional/process/provider-failure-ah4.functional.test.ts`。
使用真实进程、隔离 SQLite、HTTP Provider、明确的测试专用 probe，父进程在收到
提交边界信号后杀死后台，以同一数据库和未注入的正式入口重启。

| 分支 | 提交前杀进程 | 提交后杀进程 | 恢复判定 |
|---|---|---|---|
| 401 终态 Provider 失败 | Attempt `TerminalFailure`，Turn 尚未 settled，Step `Prepared` | Turn `Failed` 与 Step `SettlementProposed` 一起落盘 | 原 Execution 一次 Failed settlement；无伪造 ModelOutput/Assistant 回复 |
| 三次空输出、修复次数耗尽 | 最后一个 repair Step `OutputRejected(Exhausted)` | 最后一个 repair Step `SettlementProposed` | 无重复推理；原 Execution 一次 Failed settlement；无伪造回复 |

红灯发现：终态 Provider 失败的 Step 提案此前会先落盘，ProviderTurn 却保持
unsettled。重启时 Step 已是提案终态，模型侧恢复会直接返回 settlement，跳过
ProviderRuntime，Turn 永久悬空。现由 `model-decision` 在同一事务中对确实
unsettled 的终态失败 Turn 调用既有 `ProviderTurnStore.failTurn`，再提交 Step
提案；已 settled 的 timeout/其他分支不重复修改。

修复耗尽分支独立测试 `OutputRejected → SettlementProposed`，没有挪用
`Prepared → SettlementProposed` 的探针。两类测试均断言原 ProviderTurn 身份、
准确的 Step 提交侧、无 sourced ModelOutput、唯一 ExecutionSettled 事件和后台
无错误。F16 的宽泛用户可见去重不能替代这些提交边界证据。

本结果只关闭 AH4；AH5–AH14 仍未完成。

`pnpm check`：架构 155、核心 1677 + 3 skipped、Web 216，均 PASS。
`6dd3dda` 上 `pnpm test:functional`：公开进程 23/23、浏览器 2/2，包含该提交的
干净检出测试，零重试。
