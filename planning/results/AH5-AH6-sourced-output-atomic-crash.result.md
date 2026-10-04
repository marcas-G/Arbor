# AH5–AH6 sourced Session 输出 / OutputAccepted 原子提交资格结果

日期：2026-10-04

状态：**同一原子提交的前/后两侧 PASS；`pnpm check` PASS，完整功能批次
待含本变更的提交复测。**

`recordAcceptedModelOutput` 在一笔 fenced 事务中写入 sourced AssistantMessage
（或 legacy ModelOutput）、关联 ToolCall，并把 AgentLoopStep 从
`ProviderResultAvailable` 转为 `OutputAccepted`。Session 输出与 Step 标记没有
可持久观察的中间提交点，所以 AH5/AH6 按这笔事务两侧验证。

- 提交前：`tests/functional/process/provider-success-ah1-ah3.functional.test.ts`
  的 `AH3AfterStepAvailable` 在 ProviderTurn settled、Step
  `ProviderResultAvailable` 后杀进程；只读 SQLite 快照断言 sourced ModelOutput
  为零，重启后同一 Turn 继续，最终一条答复、一次 Provider 请求。
- 提交后：`tests/functional/process/model-output-ah5-ah6.functional.test.ts`
  在 `AH56AfterOutputAcceptedCommit` 杀进程；快照断言 Step
  `OutputAccepted` 与同一 ProviderTurn 的 sourced Session 输出均已持久化，
  pinned `decode-turn-v1`、decoded output hash 与 Session sequence 均有确切值，
  Execution 仍 Active。正常生产入口重启后，这三项身份不变，输出仍恰一条，公开 transcript
  恰一条目标 Assistant 回复，Provider 仍只请求一次。

测试专用 probe 通过 Composition 显式注入；正式 CLI 不从环境变量或外部请求
启用。两个位置都是真实进程 kill/restart、同一 SQLite DB，不靠延时推测事务
侧别。此结果不覆盖 AH7–AH14。

`pnpm check`：架构 155、核心 1677 + 3 skipped、Web 216，均 PASS。
