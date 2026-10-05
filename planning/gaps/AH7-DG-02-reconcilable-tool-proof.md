# AH7-DG-02 — Reconcilable shell 缺少可执行的外部现实核对合同

状态：**OPEN / 需人工治理**。影响 AH7 的“外部效果已发生、P4 settlement 未提交”
崩溃窗口。

## 真实恢复反例

`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
让生产 shell 在隔离目录追加一行 marker；测试专用 probe 在 executor 已返回、P4
settlement 尚未落盘处杀死进程。只读快照与文件检查证实：P4 intent 已持久、
文件已改变一次、P4 settlement 缺失。正常进程重启后没有盲重放，这是正确的
安全边界；但 Runtime 直接给 `OutcomeUnknown`，没有读取该文件或运行任何
`reconcile` 策略来确认已发生的效果。

冻结 P4/P3/P9 合同区分 `Reconcilable` 与 `NonIdempotent`：前者先核对现实再
决定 replay/settle，后者未知时不得自动 replay。当前 `ToolExecutor` 只有
`execute`，ToolRuntime 没有 per-tool reconcile 入口；P9 的
`ReconciliationSource.pending` 仅枚举引用，不核对外部事实。更根本的是通用 shell
命令可执行任意允许的外部操作，并非每个命令都能从一个 invocationId 推断
“是否发生、发生了几次”。将整个 shell 一律标为 `Reconcilable` 缺乏可执行证明。

## 决策归属

System Design / DID / P4 / P9 应明确：

1. 哪些 shell 子集有可证明的 reconciliation，证明材料/外部幂等键是什么；
2. 无法核对的 shell 命令是否改列 `NonIdempotent`，并怎样向模型/用户反馈；
3. per-tool reconcile port 的成功、失败、证据不足与持久结果如何进入 P4
   settlement、AgentLoop action ledger 和 Attention；
4. 对历史 `Reconcilable shell` 且 settlement 缺失的记录如何失败关闭。

建议决策稿见
`planning/proposals/reconcilable-shell-reality-proof-decision-draft.md`。
人工治理接受前，不给通用 shell 编造“已核对”的结论，不通过重试原命令来
满足测试，也不将 AH7 的安全停止测试宣称为完整 reconciliation。
