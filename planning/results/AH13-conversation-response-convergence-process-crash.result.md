# AH13 Execution 已结算 → 对话回复收敛进程崩溃资格

日期：2026-10-05

状态：**两侧定向真实进程测试 PASS；完整功能批次待含本变更提交复测。**

P17 已用 `ConversationResponseJob/Attempt` 取代旧 `HumanMessage`
状态作为回复交付真相。本测试据此选择真实边界：Execution 已结算，
ResponseJob 的 `Running → Answered` 与 Attempt settlement 在一个
事务中完成。`tests/functional/process/agent-loop-ah13-conversation-convergence-crash.functional.test.ts`
使用生产 daemon、隔离 SQLite、HTTP Provider 与公开 transcript 视图，
分别在该事务提交前、提交后暂停并杀进程，再从同一数据库正常重启。

两侧证据：

- 提交前：Execution `Completed`，ResponseJob 仍 `Running`，Attempt
  未结算，已有且仅有一条 sourced ModelOutput。
- 提交后：Execution 不变，ResponseJob `Answered`，Attempt 已结算。
- 两侧重启后：同一个 ResponseJob `Answered`，只有一个 Attempt、
  一条 ModelOutput；公开 transcript 中目标答复恰好一条；目标 Provider
  请求只有一次，daemon 无错误。

定向测试 2/2 PASS；`pnpm typecheck`、`pnpm lint`、架构测试 155/155 PASS。
该证据只关闭 AH13；AH7、AH10 的剩余缺口及 AH14 不由此推定通过。
