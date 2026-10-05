# AH11 Observation → StepEffectsCommitted 真实进程崩溃资格

日期：2026-10-05

状态：**两侧定向真实进程测试 PASS；完整功能批次待含本变更提交复测。**

`tests/functional/process/agent-loop-ah11-step-effects-crash.functional.test.ts`
使用隔离 SQLite、生产 daemon 和 HTTP Provider，让单个 ProviderTurn 调用只读
`read`。动作的 ToolResult/Observation、`Applied` disposition 与 cursor=1
先持久化，再分别在 Step `ActionsInProgress → StepEffectsCommitted`
事务的提交前与提交后暂停并杀进程；用无故障探针的正式入口从同一数据库重启。

两侧杀停快照与恢复断言：

- 提交前 Step 仍是 `ActionsInProgress`；提交后 Step 已是
  `StepEffectsCommitted`。两侧动作均已 `Applied`，只有一条 ToolInvocation、
  一条 ToolResult 和一个 Artifact，Execution 未结算。
- 重启后原 Step 只进入一次 `NextStepReady`，存在一个后继 Step；动作、
  ToolInvocation、ToolResult 与 Artifact 与杀停快照完全相同，没有重复效果。
- 首轮含 `read` 的 Provider 请求只有一次；daemon 无错误。

定向测试 2/2 PASS；`pnpm typecheck`、`pnpm lint`、架构测试 155/155 PASS。
该证据只关闭 AH11；AH7、AH10 的剩余缺口及 AH12–AH14 不能由此推定通过。
