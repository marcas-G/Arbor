# AH10 跨租约代 Command 接管 — 未闭合缺陷证据

日期：2026-10-05

状态：**PARTIAL / 两个确定性反例已修复并纳入核心测试；真实进程资格与其他控制动作仍未完成。**

冻结合同：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
§1–§3 和 `docs/design/implementation/P9/07-agent-loop-step-recovery.md` AH10。
同一 LogicalAction 跨 owner generation 时，旧代的
`TerminalRejected(FencingRejected)` 只终止旧 CommandId；新代必须先查旧回执，
只有没有已提交效果且动作仍 Pending、ControlBasis 新鲜、无未决外部效果时，
才可用新一代 CommandId 提交。

两个反例现已落在正式核心测试
`apps/single-workspace/test/ah10-generation-command-takeover.test.ts`。
执行命令：

```text
pnpm exec vitest run apps/single-workspace/test/ah10-generation-command-takeover.test.ts
```

最初结果 **2 failed / 0 passed**，失败均命中合同：

1. gen0 的 `AssignWork` 留下 `FencingRejected` 回执后，gen1 的同一 pinned
   action 复用了同一个 CommandId，网关按 receipt-first 返回旧拒绝，无法提交。
2. gen0 命令已经 `Committed`、但动作 disposition 尚未持久化时，若只改为
   generation-scoped CommandId，gen1 会再次提交，造成第二次 canonical effect。
   测试要求先收敛已提交回执，不得发第二个 gateway 请求。

原实现 `control-actions.ts` 用 `providerTurnId:outputPosition` 派生命令 ID，
没有 generation；`gateway.ts` 先查相同 ID 回执再查 fence。仅更换跨代
CommandId 会使第一例转绿、第二例转红，故未采纳半修复。当前 `AssignWork`
在新代发命令前读取旧代持久回执：旧代已 Committed 且结果匹配时直接收敛；
旧代 FencingRejected 时才使用新代 ID。gen0 保留原有 ID 兼容既有回执。

定向测试 2/2、`pnpm typecheck`、相关控制动作测试 19 passed + 2 skipped
均 PASS。AH10 的退出仍需要：其他 canonical 控制动作的跨代 receipt-first
收敛、两侧真实进程 kill/restart、旧代写拒绝、新代最多一次 canonical effect
与 Provider 不重跑的证据。不得把这份单 handler 测试称为 AH10 通过。
