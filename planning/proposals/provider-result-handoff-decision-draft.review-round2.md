# Provider 结果交接决策草案 — 第二轮审阅

日期：2026-09-30。
对象：`planning/proposals/provider-result-handoff-decision-draft.md`，本轮读取版本共 345 行，含“审阅意见处置（2026-09-30）”。

结论：第一轮 R1–R5 均已有实质性回应，原反例在提案方向上得到处理。本轮不重复列为未修复问题。但新增动作状态与恢复表仍有以下三项缺口，尚不建议据此关闭 Design Gap 或授权实现。

本文件为审阅意见，不是人工治理裁决。

## 上一轮处置核对

| 意见 | 复审核对 |
|---|---|
| R1 | 已区分 LogicalActionId 与 generation-scoped 命令身份，并将 P1/Gateway 纳入治理归属；具体身份与原子去重契约仍须在治理落字时冻结。 |
| R2 | 已要求新的成功写入原子提交，并优先本地收敛旧的完整成功证据。 |
| R3 | 已增加 Provider 失败及 repair 耗尽的直接结算路径；修复重试的恢复入口还需补全，见 R7。 |
| R4 | 已增加 SkippedStale、SkippedEarlySettlement 与逐动作 Observation。 |
| R5 | 已增加旧数据证据分类、幂等迁移及证据不足时的 Attention 路径。 |

## R6 / P1：OutcomeUnknown 不能按普通动作终态推进正常结算

位置：§6，第 189–195、219–220 行；关联 §3，第 97–104 行。

ActionRecord 将 `OutcomeUnknown(reconciliationRefs)` 列为一种终态，并规定全部动作有终态后进入 `TurnEffectsCommitted`；该状态随后允许下一模型回合或普通结算，没有对未知副作用设置单独门禁。

反例：一个 NonIdempotent 工具的外部 effect 已发生，但成功结算前崩溃。恢复记录 `OutcomeUnknown` 后，若按当前统一规则推进，就可能在现实尚未对账时继续决策或 `Completed`。这违反冻结的 P2 `06` §5：存在 unresolved side-effectful invocation 时，不得普通 Completed/Interrupted/Failed；应保持对账或以 OutcomeUnknown(ReconciliationRequired) 结算。

建议：区分“调用已停止”和“外部结果已确定”。在正常回合推进、直接 settlement 和恢复提交 settlement 前，统一检查未解决副作用；按工具四级语义进入 reconciliation/Attention，或提交 OutcomeUnknown 提案。不得把“没有 Applied 成功结果”理解成可以再执行。

验收：注入 effect 已发生、settlement 未提交的 NonIdempotent/Reconcilable 调用，断言不盲目重放、不普通完成，且只有对账证据满足既有规则后才推进。

依据：

- `docs/design/implementation/P2/06-recovery-skeleton.md` §2、§4–§5。
- `docs/design/implementation/P9/04-provider-tool-hardening.md` §1.3、§3。

## R7 / P2：恢复表遗漏 NextTurnReady 与持久修复重试状态

位置：§7，第 237–243 行；关联 §3，第 66–72、92–112 行。

状态图明确会持久化 `NextTurnReady` 和 `OutputRejected + Retry(nextRepairAttempt)`，但恢复表没有这两种状态的动作。正文另称旧 repair 记录以 `RejectedForRepair`/`RepairExhausted` 终止，这两个名称与 record.state 的枚举也尚未统一。

反例：DecisionStale 将剩余动作标记 SkippedStale 并提交 NextTurnReady 后、创建下一 Prepared 前崩溃；或者提交 Retry disposition 后、创建下一 repair 记录前崩溃。恢复表不能确定应从哪个入口继续。若退回解码或重作 repair 决策，会违反“不重新解释 disposition、不重复消耗预算”的要求。

建议：明确这些状态的恢复行、唯一 successor 身份和创建/查找规则；后继已经存在时必须接续既有记录，不重新 prepare 同一身份。统一 state 与 terminal disposition 的表达。增加“前驱已提交、后继未创建”和“后继已创建、前驱尚待收敛”两个故障窗口的验收。

依据：草案自身 §3 状态图、§7 恢复表、§10 不越级及稳定身份不变量。

## R8 / P2：统一验收断言与失败、停止、人工对账分支冲突

位置：§11，第 320–321 行。

新增注入场景已经覆盖 Provider 终止失败、repair 耗尽、旧数据证据不足等分支，但仍要求每个场景都满足“无重复 Provider 请求、新 generation 能收敛、最终 Transcript 只有一个答案”。

证据不足的迁移按 §8 应停在 Attention，不能保证自动产生答案；P14 `02` §4.2 对 Interrupted 明确允许 Answered 且 response body=null；Failed/OutcomeUnknown 会将消息释放为新 attempt，可能合法地产生新的 Execution 与 Provider 请求。DecisionStale/repair 也允许新的模型决策。因此测试必须区分去重身份、正确安全停止与成功回答，不能强迫所有失败用例产生答案。

建议：按分支列出期望 settlement/message/Attention 状态。将请求去重断言限定为“同一已有完整成功证据的 ProviderTurn 不再请求”，显式允许被契约授权的 transport retry、repair、新逻辑回合和新 conversation attempt。成功回复场景断言恰好一个逻辑回复；停止或等待人工对账场景断言正确处置且没有重复回复/外部动作。

依据：

- 草案 §7、第 235–241 行及 §8、第 261–273 行。
- `docs/design/implementation/P14/02-conversation-execution.md` §4.2。

## 范围

本轮为文档复审，核对冻结 P2/P9/P14 契约，使用明确的崩溃反例；未运行测试，未修改草案、冻结设计或实现。其他 Agent 可以直接读取本文件，按 R6–R8 逐项回应并修订草案。
