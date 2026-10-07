# AH7 普通 A/B 双动作交错——真实进程资格结果

日期：2026-10-07
状态：**该独立边界 PASS；AH7 整体仍 PARTIAL / OPEN**

测试：`tests/functional/process/agent-loop-ah7-two-action-interleaving.functional.test.ts`
定向命令：

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah7-two-action-interleaving.functional.test.ts
```

结果：子 Agent 定向 1/1、主 Agent 独立复跑 1/1 PASS；真实 SQLite、生产 daemon、Provider 边界及现有
AH qualification child/probe。

## 断点序列

同一 ProviderTurn 一次返回两个有序 `patch` ToolCall。Patch 由公开
`GrantPermission(fs:write)` 授权，P4 side-effect class 为 Idempotent，且
`requiresApproval` 为 false；本场景不触发 AH7-DG-01、AH7-DG-02 或审批事务缺口。

| 断点 | durable cursor | action ledger | Tool facts / workspace |
|---|---:|---|---|
| 首次 daemon：A action intent 后 | 0 | A Pending；B 尚未建行 | 无 ToolInvocation、ToolResult、Artifact；A/B 文件未写 |
| 第二 daemon：重放 pin 后，A result commit 后 | 1 | A Applied | 1 个 settled Success Invocation、1 个 ToolResult、1 个 Artifact；A 文件写入一次 |
| 普通 daemon：同一 ProviderTurn 完成 B 后 | 2 | A、B 均 Applied，LogicalActionId/callRef 不同 | 2 个 settled Success Invocation、2 个 ToolResult、2 个 Artifact；A 内容保持不变，B 文件写入一次 |

探针为 `AH7AfterActionIntentCommit`（首次 daemon）和
`AH7AfterActionResultCommit`（恢复 daemon）。最后一次恢复使用普通 production
daemon，不含 crash probe。Provider 侧断言 action batch 只有一次，无 action 结果
仅含 A 的中间重请求；最终 target marker 请求最多为原 action batch 加一个带完整
A/B 工具结果的 successor request。无 daemon error。

该 PASS 证明普通 A 已完整提交后，B 可在重启后的同一 AgentLoopStep 继续完成，A
观察/cursor 不重复且 B 不被 stale/terminal 规则跳过。它不证明 NonIdempotent
effect-after-crash reconciliation，也不覆盖 AH7-DG-01/02/03、审批原子性、通用
并发或 AH7 全部提交边界；不能据此宣布 AH7 闭合。未运行全量 `pnpm check` 或完整
功能批次。
`pnpm typecheck`、lint 和架构 155/155 在本测试加入后 PASS。
