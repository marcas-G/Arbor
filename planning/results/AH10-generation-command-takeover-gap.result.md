# AH10 跨租约代 Command 接管 — 未闭合缺陷证据

日期：2026-10-05

状态：**OPEN / 两个确定性反例已复现；生产修复与真实进程资格均未完成。**

冻结合同：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
§1–§3 和 `docs/design/implementation/P9/07-agent-loop-step-recovery.md` AH10。
同一 LogicalAction 跨 owner generation 时，旧代的
`TerminalRejected(FencingRejected)` 只终止旧 CommandId；新代必须先查旧回执，
只有没有已提交效果且动作仍 Pending、ControlBasis 新鲜、无未决外部效果时，
才可用新一代 CommandId 提交。

`tests/functional/pending/ah10-generation-command-takeover.functional.test.ts`
是隔离的、显式不进入绿灯门的确定性测试。执行命令：

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-generation-command-takeover.functional.test.ts
```

当前结果 **2 failed / 0 passed**，失败均为预期且命中合同：

1. gen0 的 `AssignWork` 留下 `FencingRejected` 回执后，gen1 的同一 pinned
   action 复用了同一个 CommandId，网关按 receipt-first 返回旧拒绝，无法提交。
2. gen0 命令已经 `Committed`、但动作 disposition 尚未持久化时，若只改为
   generation-scoped CommandId，gen1 会再次提交，造成第二次 canonical effect。
   测试要求先收敛已提交回执，不得发第二个 gateway 请求。

现有 `control-actions.ts` 用 `providerTurnId:outputPosition` 派生命令 ID，
没有 generation；`gateway.ts` 先查相同 ID 回执再查 fence；控制 handler
把任何终态拒绝变成模型可见 `AgentActionRejected`。这是实现未满足既有冻结合同，
不在此文件引入新设计语义。尝试过仅更换跨代 CommandId，第一例转绿、第二例
转红，因此该半修复已撤回，生产代码未改。

`pnpm typecheck` PASS；pending 测试可运行并精确失败。AH10 的退出仍需要：
receipt-first 的完整跨代 ledger、两侧真实进程 kill/restart、旧代写拒绝、
新代最多一次 canonical effect 与 Provider 不重跑的证据。不得把这份红测
称为 AH10 通过。
