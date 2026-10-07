# AH14-DG-01 治理决策稿审阅

日期：2026-10-07

对象：`planning/proposals/AH14-legacy-adoption-attention-decision-draft.md`

结论：**失败证据充分；决策稿尚未固定，不能接受后直接实施。**

正向 AH14 等价 fixture 的两侧进程崩溃与重复重启已通过；隔离负向用例
`tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts`
证明旧成功输出含动作、无可证明 disposition 时，公开 Attention 始终为空。
P9 `07` §3/§5 明确要求证据不足产生持久 Attention；P10 `02` §1 的现有
六种来源和当前投影均无对应语义。不能将正向 PASS 或一般 RuntimeSafetyStop
替代这个负向判据。

提交人工治理前还需在固定提案中明确：

1. **归属与严重度。** 新事实属于 P9 恢复事实还是通用 Attention 事实；
   映射为 `Attention` 还是 `Action Required`，尤其是“无法在现有 Authority
   下继续”和“未知外部效果”不得混成一种原因。
2. **持久身份。** Execution、ProviderTurn、证据指纹/失败类别的唯一键，
   同证据重复恢复不新增事实；权威证据变化后何时允许重新评估、何时撤除投影。
3. **写入与可见性。** 恢复失败、事实落盘、公开 Attention 可见三者的事务/
   恢复窗口；安全摘要不得携带不可信 Provider 原文。定义杀进程两侧判据。
4. **合同落点。** 由人工治理列出需要改动的 P9/P10 所属合同、事件或持久化
   载体、投影及迁移兼容。未接受前不得直接改 `docs/design/**` 或产品 Runtime。

这些是提案待裁决项，不是授权本审阅自行选择新的业务语义。待固定提案、
接受标识和 SHA-256、所属文档落地复核齐备后，才可按 pending 红测实施。
