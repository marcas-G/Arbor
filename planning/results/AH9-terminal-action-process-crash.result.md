# AH9 终止动作与后续动作跳过 — 进程崩溃资格结果

日期：2026-10-05

状态：**两侧定向真实进程测试与 `pnpm check` PASS；完整功能批次待复测。**

`tests/functional/process/agent-loop-ah9-terminal-action-recovery.functional.test.ts`
使用生产 daemon、隔离 SQLite 和 HTTP Provider。单个 ProviderTurn 同时返回
`wait`（动作 A）与 `assign_work`（动作 B）。`wait` 应终止本次 Execution；B
必须记录为 `SkippedEarlySettlement`，不能创建 Work。

测试通过现有 `AgentLoopQualificationProbe` 在终止动作事务提交前、提交后分别暂停
生产进程，然后杀进程并从同一数据库以无探针的正式入口重启。探针只存在于测试
Composition，不通过用户环境变量开启，也不修改生产持久化语义。

两侧持久化断言：

- 提交前：Step 为 `ActionsInProgress`、cursor=0；A 是 `Pending`，没有
  `ControlResult`，Execution 未结算。重启后完整事务得以完成。
- 提交后：A `Applied`、B `SkippedEarlySettlement`、两条 `ControlResult` 和
  `SettlementProposed` 的 `Yielded` proposal 已同一事务落盘；Execution 尚未结算。
  重启只消费已持久化 proposal，不再次请求 Provider。
- 最终两侧都是 Execution `Completed`；仅原 Work/revision 0 和一条 WorkWait，
  `WorkAssigned` 事件只有一条，Provider 请求只有一次，无 daemon 错误。

定向测试 2/2 PASS；`pnpm check` 架构 155、核心 1680 + 3 skipped、
Web 216，全部 PASS。该证据只关闭 AH9；AH7 的未证边界以及 AH10–AH14
仍不能由此推定通过。
