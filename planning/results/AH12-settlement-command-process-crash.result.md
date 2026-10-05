# AH12 SettlementProposed → SettleExecution 进程崩溃资格

日期：2026-10-05

状态：**两侧定向真实进程测试 PASS；完整功能批次待含本变更提交复测。**

`tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts`
使用生产 daemon、隔离 SQLite 和 HTTP Provider。Provider 在一个 Turn
调用 `wait`，先持久化 `SettlementProposed`，随后 Execution Runtime 以
当前 lease generation 提交 `SettleExecution`。测试专用进程内探针分别在
CommandGateway 提交前、返回已提交回执后暂停，杀进程并从同一数据库以
无探针的正式入口重启。测试子进程用环境变量选择暂停点；正式入口不会
据此装配探针，公开请求也不能启用它。

两侧断言：

- 提交前快照：Step 为 `SettlementProposed`、`wait` 已 Applied、
  Execution 仍 Active，尚无结算 Command 回执。
- 提交后快照：同一 proposal 不变，Execution 已结算，恰有一条
  `Committed` 的结算 Command 回执。
- 重启后两侧都只有同一 proposal、同一 action、一个已结算 Execution、
  一条结算回执，原 Work revision 仍为 0；Provider 只请求一次，daemon
  无错误。

最初探针未命中揭示 daemon 的新 Work 路径先经 `consumeWorkspaceWake`
而非恢复循环。探针接线覆盖该入口后，两侧定向测试 2/2 PASS。
`pnpm typecheck`、`pnpm lint`、架构测试 155/155 PASS。
该证据只关闭 AH12；AH7、AH10 的剩余缺口及 AH13–AH14 仍独立待证。
