# AH7-DG-01 — 已结算 ToolInvocation 缺少可重放的模型观察

状态：**OPEN / 需人工治理**。影响 AH7 中“P4 settlement 已提交、AgentLoop
Observation 尚未提交”崩溃恢复，尤其是 `ExpectedFailure` 和无 Artifact 的结果。

## 恢复反例

1. P4 持久化 `ToolInvocationSettlement = ExpectedFailure`、`resultRef = null`。
2. 进程在 AgentLoop 写入 sourced ToolResult、action disposition 和 cursor 前崩溃。
3. 重启时 action 仍是 `Pending`，同一 invocation 的持久记录只能证明已知的
   `ExpectedFailure`，不能取回先前给模型的 bounded Observation 文本及 truncated
   标志；再次执行工具又会违背已结算调用不可重复执行的要求。

隔离红灯：

```powershell
pnpm exec vitest run --config vitest.pending-functional.config.ts \
  tests/functional/pending/ah7-settled-expected-failure-reentry.functional.test.ts
```

该测试预置已结算 `ExpectedFailure`、空 resultRef、未有 Session ToolResult；要求
重入恢复原观察且不再执行工具。当前得到 `OutcomeUnknown`。这不是外部效果未知：
P4 settlement 已知，只是观察证据缺失。源码事实：`ToolInvocationRecord` 仅保存
settlement/resultRef；Artifact 目前只在 Success 且 resultRef 为空时创建。

## 为什么不能局部补丁

用“工具先前失败”之类的通用文本替代原 Observation，会改变模型接收的信息；
把已知 `ExpectedFailure` 改成 `OutcomeUnknown` 会改变执行与恢复语义；重新运行
Idempotent/ReadOnly 工具可能得到不同的当下内容，不能冒充原已结算结果。
P3 的 action Observation source、P4 的 ToolInvocation settlement 和 Artifact 引用
之间缺少一个明确的持久交接合同。

## 设计归属与停线

System Design / DID 与 P3/P4/P9 的拥有文档需决定：每种 terminal settlement 的
bounded Observation 及版本/哈希由哪笔事务持久化、如何精确回放；Artifact/resultRef
是否承担该职责；旧记录证据不足时如何类型化失败关闭。建议见
`planning/proposals/tool-settlement-observation-replay-decision-draft.md`。

人工接受前，不在 `docs/design/**` 落字，不为此路径编造模型观察，也不把 AH7
ReadOnly Success 的通过误称为 AH7 全部闭合。
