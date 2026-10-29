# Provider 结果交接治理裁决记录

## 裁决

**ACCEPT — 2026-09-30。**

人工治理接受“持久 `AgentLoopStep` + 可重放 Provider 结果 + 幂等
Session/动作交接”的方向，并授权修改拥有该语义的冻结设计合同。

## 固定裁决对象

- 提案：`provider-result-handoff-decision-draft.md`
- 提案 SHA-256：`BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F`
- 治理提交单：`provider-result-handoff-governance-submission.md`
- 提交单 SHA-256：`908610EE54ED33B3AA5448264E8C18A32EFB333B372D18934D97EC1993EB3A08`
- 审阅链：第一轮 R1–R5、第二轮 R6–R8、第三轮无新增 P1/P2 阻塞、
  治理提交单审阅无阻塞。

上述固定文件继续保持不变；本记录只保存人工裁决，不回写被审阅版本。

## 接受的设计方向

1. `AgentLoopStep` 是 Provider 结果到 Session、动作、Observation 与 Execution
   settlement 之间的持久交接状态；租约只是写权限，不是业务进度载体。
2. 完整成功的 Provider 结果是可重放的本地事实；恢复不得再次请求同一
   `ProviderTurn`。
3. `ModelOutput`、动作结果、Observation、successor 与 settlement proposal
   必须以事务或稳定幂等键收敛。
4. `LogicalActionId` / `LogicalSettlementId` 标识 Agent 语义；每个租约
   generation 使用新的 `CommandId`。旧 generation 的 `FencingRejected`
   仍对该 Command terminal，但不永久毒化逻辑动作。
5. `ReconciliationPending` 阻止下一回合和普通 Completed/Interrupted/Failed；
   只能继续对账、进入 Attention，或提交既有
   `OutcomeUnknown(ReconciliationRequired)`。
6. repair 与 next-turn successor 的完整身份在前驱提交时持久化，恢复只做
   `ensureSuccessor`，不重算决定、不重复消耗预算。
7. 旧数据必须按证据迁移；证据不足进入持久 Attention，不猜测、不重放。
8. DOGFOOD-DG-01 的等价状态（单一成功 ProviderTurn、完整事件、匹配
   Execution/Session/Manifest、无工具动作、尚无来源明确的 ModelOutput）被授权
   分类为 `ProviderResultAvailable`；实际数据库仍须等实现授权和迁移验收后处理。

## 授权边界

本裁决只授权设计合同落字及一致性审阅。它**不授权**：

- 编写/启用 migration `0017_agent_loop_step_handoff`；
- 重放或修改保全的失败数据库；
- 实现 AgentLoopStep store、恢复扫描或自动 settlement；
- 在设计合同落字和一致性审计完成前自动关闭 `DOGFOOD-DG-01`。

实现必须另行形成计划并取得明确授权。设计合同落字和一致性审计解决
`DOGFOOD-DG-01` 的设计问题；实现、故障注入与原始等价 fixture 则是后续独立
completion gate，不能因 Design Gap 已解决而推定完成。
