# AH8 已提交动作 A 与失效动作 B — 进程崩溃资格结果

日期：2026-10-05

状态：**定向真实进程用例与 `pnpm check` PASS；完整功能批次待含本变更的
提交复测。**

`tests/functional/process/agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`
使用生产 daemon、隔离 SQLite 与 HTTP Provider。测试 Provider 在同一 Turn 返回
两个 ActionCall：A 为 `update_plan`，B 为 `assign_work`。测试专用 probe 在 A 的
Session Observation、Action `Applied`、Step cursor=1 原子提交后暂停。

趁原 daemon 的公开 HTTP 命令入口仍可用，测试提交 `SteerWork`，将原 Work
revision 0→1；随后杀死 daemon，以未注入的正常生产入口和同一数据库重启。

重启后机器断言：

- A 仍是唯一 `Applied`，没有再次执行；
- B 是 `SkippedStale`，其 disposition 为 `DecisionStale`，没有创建第二个 Work；
- 原 Step `NextStepReady`、cursor=2、reason=DecisionStale；同一 Execution 只有
  一个后继 Step。后继可从瞬时 `Prepared` 合法推进到 `SettlementProposed`，测试
  不要求轮询恰好撞到瞬时状态；
- Work 表仅原一项，revision=1；daemon 无错误。

测试夹具仅扩充一个 OpenAI-compatible SSE 响应中的多 ToolCall 输出，不改变
正式 Provider 或生产 Prompt。`pnpm exec vitest run --config
vitest.functional.config.ts tests/functional/process/agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`
单独 PASS。该结果只关闭 AH8；AH7 部分边界与 AH9–AH14 仍未闭合。

`pnpm check`：架构 155、核心 1680 + 3 skipped、Web 216，均 PASS。
