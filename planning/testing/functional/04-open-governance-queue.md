# 功能测试补齐：未决治理队列

日期：2026-10-07

此表是排程，不是人工接受或实现授权。隔离红测必须保持真实失败；
`docs/design/**` 只在固定提案获人工明确接受后，按既有委托落地完全一致的合同。

| 缺口 | 失败证据 / 决策材料 | 当前门 | 排程关系 |
|---|---|---|---|
| FT-DG-01 | F21 浏览器资源挂载与未登记路径旁路；`planning/proposals/ui-project-resource-admission-decision-draft.md` | 审阅可提交，未接受 | 与 FT-DG-03 共用 CreateProject 认证/收据边界，须联合核对 |
| FT-DG-03 | F23 非法 MessageId/AcceptanceId 可 Committed；`planning/proposals/external-command-runtime-codec-decision-draft.md` | 审阅可提交，未接受 | 与 FT-DG-01 联合核对；先固定 codec/旧收据规则再实施 |
| AH7-DG-01 | 非 Success 结算缺可重放 bounded Observation；`planning/proposals/tool-settlement-observation-replay-decision-draft.md` | 审阅可提交，未接受 | 阻挡 AH7 非成功观察恢复资格 |
| AH7-DG-02 | generic shell 标记 Reconcilable 却无 reality-proof port；`planning/proposals/reconcilable-shell-reality-proof-decision-draft.md` | 审阅可提交，未接受 | 阻挡 AH7 主动外部现实核对资格 |
| 拟议 AH7-DG-03 | P4 `02` 执行前消费 Approval 与 P4 `06` 同 settlement 事务冲突；`planning/proposals/AH7-approval-settlement-atomicity-governance-draft.md` | 精准红测与审阅齐备，未接受 | 先裁决审批消费/预留语义，再补两侧 crash 资格 |
| AH14-DG-01 | 旧证据含动作时公开 Attention 缺失；`planning/proposals/AH14-legacy-adoption-attention-decision-draft.md` | 负向红测齐备，提案尚需固定严重度、事实身份与写入窗口 | 不得以正向 AH14 2/2 代替负向证据 |
| 拟议 AH10-DG-01（Deliver） | 过期 generation 的 Deliver 仍提交 Message/Event/Inbox；`planning/proposals/AH10-deliver-generation-fence-governance-draft.md` | 真实 SQLite handler 红测与审阅齐备，未接受 | P7 Message handover 与 P1 fenced logical action 的所有权需裁决；不能仅凭 MessageId 唯一键视为接管完成 |
| Submitted DecisionEpisode binding terminalization（拟议 P2/P9 治理项） | 临时 DB 中有效 foreign Workspace / Manifest 各一案；gen1 真实 lease 后皆 settle Execution Failed，却遗留 Step ActionsInProgress + Action Pending；`planning/proposals/agent-loop-submitted-binding-rejection-terminalization-draft.md` | 两案隔离 daemon RED 已独立复跑；处置提案等待人工治理，未接受、未授权生产修复；默认功能套件排除 | 不得把失败负测计为 PASS。需由 P2/P3/P9 owning contract 明确错绑时的 durable terminal/Attention/reconciliation disposition 后，才实现并重新资格测试 |
| 拟议 VCS-DG-01（验证命令重放/快照） | 同 CommandId 因 `recordedAt` 漂移产生 `IdempotencyConflict`；已结论 Verification 丢失 P8 冻结的 `criteriaResults`；`planning/proposals/verification-evidence-replay-and-snapshot-governance-draft.md` | 两条真实 Gateway/SQLite 隔离红测和审阅齐备，未接受 | P8 的快照目标不重裁；需决定稳定时间来源与历史已结论行处置，之后才能闭合两类验证控制动作的 AH10 |

AH10 DecisionEpisode expired-lease redispatch was reclassified as an
implementation defect under the existing P2-06/P9/EGP contract and is closed
by `planning/results/AH10-select-current-work-takeover.result.md`; it is not an
open governance item. Remaining unblocked work includes other AH10 canonical
control actions and AH7 failure/multi-action crash-recovery cases. AH7 的普通 A→B
双动作真实进程场景和同 ToolInvocationId 的双连接/双 OS 进程同步竞争已有局部
PASS，但不替代进程崩溃/重启资格，也不关闭 DG-01/02/03。所有分支的最终
声明还须回到 `01-functional-journey-catalog.md` F01–F23 与
`02-agent-loop-step-crash-qualification.md` AH1–AH14 逐项审核。

FT-DG-02 was accepted and landed in System Design v1.10 / DID v1.32, then
implemented and qualified by the default F22 browser journey. It is closed;
F21 and F23 remain separate open governance gaps. The old pending F22 file is
retained only as a skipped pre-fix reproduction and is not part of active
release qualification.

2026-10-08 资格增量：AH15 Inbox promotion 与 AH17 checkpoint/epoch 边界均已在
集成构建产物上完成真实进程提交前/后 kill/restart 2/2；证据分别见
`planning/results/AH15-inbox-input-promotion-crash.result.md` 与
`planning/results/AH17-checkpoint-epoch-crash.result.md`。这是局部边界资格，
AH18 repeated overflow、AH19 ProviderNative binding 和 SCRC-008 整体仍开放；
此队列中的 AH7/AH10/FT 项状态不因上述结果改变。

AH18 另有待补的实现/进程资格窗口：ordinal-0 OverflowCompaction link 已持久化，
但 Summary ProviderTurn 为 NotFound/Unsettled 时，恢复目前 fail-closed，尚未对
同一稳定 ProviderTurn ID 创建或接管 Summary。P3 的 P20 空链确定性回归只验证
原 ContextLimit receipt 足以事务性建链并继续同一调用，不覆盖上述 kill/restart
窗口；真实 second terminal overflow 崩溃矩阵也未完成；不得据此宣布 AH18 关闭。
AH19 仍开放 ProviderNative match/mismatch portable rebuild 与 Native checkpoint
recovery；Summary AH17 两侧资格不覆盖该 profile。
