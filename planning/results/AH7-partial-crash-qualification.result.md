# AH7 action / tool handoff — 部分进程崩溃资格结果

日期：2026-10-05

状态：**部分 PASS，AH7 未闭合。**

## 已取得的真实进程证据

`tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`
在四个独立提交点收到精确 probe 后杀死首个 daemon，以同一 SQLite DB 和普通生产
入口重启。四点分别为 AgentLoop `Pending` action intent、P4 ToolInvocation intent、
P4 tool settlement，以及 Session ToolResult + action `Applied` + Step cursor 的原子
收口。ReadOnly `read` 的四条用例合并 4/4 PASS：同一 logicalActionId/callRef 与
ToolInvocationId 保持稳定；P4 已结算后复用原 Artifact，未再产生 Artifact；Session
ToolResult 恰一份，Provider 首次工具决策没有重放。

`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
分别在 Reconcilable `shell` intent 已落盘但 executor 尚未进入，以及 shell
外部效应已发生、P4 settlement 尚未提交时杀进程。首侧效应文件始终不存在；
后侧文件仅有一次追加的 marker，重启后内容不变。两侧均不盲执行 shell；原
action 是 `ReconciliationPending`，Execution 是 `OutcomeUnknown`。这些用例
只证明安全停止，不宣称完成外部现实 reconciliation。

测试发现并修复了三条实现缺陷：

1. 生产调度遇已有 Active Work 就 `Noop`，重启后 Pending action 永久停滞；
   scheduler tick 现在在旧租约到期后恢复 exact Work Execution，并跳过待人工批准。
2. ToolRuntime 对已存在 P4 intent 直接再次 INSERT，触发主键冲突；现在先比较
   exact intent，再按副作用语义决定安全重入或 OutcomeUnknown。已结算 Success 且
   Artifact 可读时复用原结果。
3. ToolRuntime 的 OutcomeUnknown 曾被包装成普通 Observation，使 AgentLoop 错记
   `Applied`；现在映射为 `OutcomeUnknown(ReconciliationRequired)` settlement，
   保留 `ReconciliationPending`。

另外，`packages/tool-runtime/test/p4-approval-reentry.test.ts` 证明同一 invocation
已消费的 exact approval 可在重启后复用；不同 invocation 不能借此重复消费。
`apps/single-workspace/test/executable-invocation-identity.test.ts` 证明新调用 ID 同时
绑定 Execution 与 callRef，同一 Execution 重试稳定；精确匹配的历史 callRef-only
记录仍按旧 ID 继续。P4 pipeline 的三个旧 fake store 补齐 `findById` Port 方法。

## 尚未通过 / 不能宣称关闭

- Reconcilable 工具在 effect 已发生、P4 settlement 未提交时，已证明不盲重放；
  仍缺**主动核对外部现实并收敛**的测试与实现。
- 已结算的非 Success（例如 ExpectedFailure）没有持久的 bounded Observation，
  resultRef 又可为空。P4 record 仅有 settlement/resultRef，不能精确重建原模型
  观察；需要设计归属确认和红灯反例，不能伪造成功或把已知失败说成外部效应未知。
- exact approval consumption 与 P4 settlement 目前仍是不同事务；需覆盖两侧
  crash，并按冻结 P4 合同收敛。
- 非幂等 effect 未结算、两动作交错、ControlBasis stale、并发同 invocation 等
  AH7 子边界仍缺进程资格。

本批 `pnpm check` PASS：架构 155、核心 1680 + 3 skipped、Web 216。
`26f80f2` 上 `pnpm test:functional` PASS：公开进程 29/29、浏览器 2/2，
包含从该提交的干净检出测试，零重试。隔离 AH7-DG-01 红灯仍失败，不计入
正式 PASS。治理审阅见 `planning/results/AH7-DG-01-governance-readiness.review.md`。
AH8–AH14 仍 OPEN。
