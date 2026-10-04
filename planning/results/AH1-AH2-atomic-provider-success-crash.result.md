# AH1–AH2 Provider Success 原子提交崩溃资格结果

日期：2026-10-04

状态：**AH1–AH2 共同原子提交的前/后两侧 PASS；AH4–AH14 除 AH3 外仍 OPEN。**

`ProviderRuntime` 将 ProviderAttempt `Success`、完整 canonical events 成功证据和
ProviderTurn settled 放在同一个 `settleSuccessAtomically` 事务。不存在可持久观察
的“Attempt Success、Turn 未 settled”中间提交点；AH1 与 AH2 因而在该事务的
两侧共同验证，不能人为制造第二个不真实的提交边界。

`tests/functional/process/provider-success-ah1-ah3.functional.test.ts` 使用与 AH3
相同的真实进程、隔离 SQLite、HTTP Provider 和显式测试专用 probe：

| 边界 | 杀进程后的持久状态 | 正常生产入口重启后 |
|---|---|---|
| `AH12BeforeSuccessCommit` | Turn 未 settled，Attempt `InProgress` 且无 success evidence，Step `Prepared`，无 sourced ModelOutput | 原 Attempt 终结为 `TerminalFailure`、原 Turn `Failed`；没有把不完整结果冒充成功，也没有接受原输出 |
| `AH12AfterSuccessCommit` | 同一 Turn 已 settled Success、Attempt 完整成功证据已落盘，Step 仍 `Prepared` | 无第二次 Provider 请求；一条 Assistant 回复，Execution durable settled |

两侧均由父测试进程在收到精确 probe 消息后杀进程，再以同一数据库重启；DB
快照和 Provider 请求计数是机器断言，不靠固定延时猜提交位置。提交前侧的
安全停止不等于用户已得到回答；F16 只证明另一个宽泛用户可见崩溃旅程。

测试入口只通过显式 in-process config 注入 `providerQualificationProbe`；生产
CLI 不从外部环境变量或模型输出开启它。`pnpm check` PASS（架构 155、
核心 1677 + 3 skipped、Web 216）。完整发布功能批次需在包含本测试的提交上
另行验证。
