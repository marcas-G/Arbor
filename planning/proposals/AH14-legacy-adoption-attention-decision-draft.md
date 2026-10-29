# AH14-DG-01：旧 Provider 证据不足时的持久 Attention 归属

状态：**设计缺口，待人工治理；不得在实现中自行落地。**
日期：2026-10-05

## 已证实的矛盾

`docs/design/implementation/P9/07-agent-loop-step-recovery.md` §3 要求：
旧版已成功 ProviderTurn 的身份、解码或动作副作用证据不充分时，停止接管、
生成持久 Attention；重复接管必须得到同一 Attention，且不得重放 Provider、
动作或输出。

`docs/design/implementation/P10/02-attention-readmodel.md` §1 与当前
`packages/projection-runtime/src/attention.ts` 把 Attention 来源封闭为六种，
没有“legacy adoption evidence insufficient”。这不是
`RuntimeSafetyEnvelope`（无进展/安全包络停止），也不是
`ReconciliationEscalated`（已知工具副作用待核对）。把它塞入任一现有来源
会误报原因。

隔离真实进程反例：
`tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts`
建立完整已结算 Provider 成功证据，但输出含动作、无动作 disposition；重启后
公开 `attention` 视图持续为 `rows: []`。测试命令：

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts
```

结果：**RED，公开 Attention 缺失**。正向“无动作、证据完整”场景的两侧
进程崩溃与重复重启已通过，不可替代此负向判据。

## 请求裁决

建议新增独立的 `LegacyAdoptionEvidenceInsufficient` Attention 来源，
由持久且可去重的恢复事实支撑。事实应绑定 Execution、ProviderTurn、
失败类别/证据指纹和目标 Workspace；同一证据重复恢复只产生同一事实，
新权威证据出现时才允许状态变化。该来源只报告需要人工/治理关注，
不得自行补造 action disposition、改写旧 Provider 结果或重试 Provider。

需要人工治理明确：事实的拥有文档、持久化/事件合同、去重与解除条件、
P10 Attention 来源词表及公开投影；若选择复用现有来源，须先证明其语义
与 P9 legacy evidence failure 完全等价。

## 实现退出门（裁决后）

1. 含动作/证据不足的旧成功结果不触发新 Provider、工具或 sourced 输出。
2. 公开 Attention 恰有一条，绑定准确 Workspace/Execution 和安全摘要。
3. 杀进程并至少两次重启后同一 Attention、不额外推进 Step。
4. 无动作且证据完整的正向 AH14 两侧测试保持通过。
