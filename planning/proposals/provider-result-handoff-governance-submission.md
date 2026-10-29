# Provider 结果交接与 Agent 回合恢复 — 人工治理提交单

## 状态

**READY FOR MANUAL GOVERNANCE DECISION / 未批准。**

本提交单不修改 `docs/design/**`，不授权实现，也不关闭
`DOGFOOD-DG-01`。

## 固定审阅对象

- 提案：`planning/proposals/provider-result-handoff-decision-draft.md`
- SHA-256：`BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F`
- 第一轮审阅：`provider-result-handoff-decision-draft.review.md`
- 第二轮审阅：`provider-result-handoff-decision-draft.review-round2.md`
- 第三轮审阅：`provider-result-handoff-decision-draft.review-round3.md`

第三轮复核未发现新增 P1/P2 问题，确认 R1–R8 已在提案层面得到实质回应，
建议将上述固定版本提交人工治理裁决。该结论不是治理批准或实现证据。

## 请求裁决

请人工治理明确选择：

1. **ACCEPT**：接受“持久 AgentTurn + 可重放 Provider 结果 + 幂等
   Session/动作交接”方向，并授权在提案 §12 所列所有者文档中落字；
2. **REVISE**：列出必须修改的具体条款，产生新提案哈希并重新审阅；
3. **REJECT**：给出替代恢复语义及其所有者文档。

若选择 ACCEPT，仍需分别完成：正式设计变更、实现计划、迁移/恢复实现、提案
§11 的故障注入验收，以及 DOGFOOD-DG-01 原始等价 fixture 的收敛证明。任何一步
都不能由本提交单自动视为完成。

## 当前证据保全

- 原始失败数据库保持只读证据，不直接修改或推断结算；
- 已生成的量化研究文本已单独整理，但不冒充权威 Transcript；
- 密集 Provider 输出导致调度饿死的实现缺陷已有回归修复；
- 已结算 ProviderTurn 到 Agent/Session/Execution 的恢复语义继续由
  DOGFOOD-DG-01 阻塞，直到治理明确批准。
