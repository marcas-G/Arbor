# 功能测试补齐：未决治理队列

日期：2026-10-07

此表是排程，不是人工接受或实现授权。隔离红测必须保持真实失败；
`docs/design/**` 只在固定提案获人工明确接受后，按既有委托落地完全一致的合同。

| 缺口 | 失败证据 / 决策材料 | 当前门 | 排程关系 |
|---|---|---|---|
| FT-DG-01 | F21 浏览器资源挂载与未登记路径旁路；`planning/proposals/ui-project-resource-admission-decision-draft.md` | 审阅可提交，未接受 | 与 FT-DG-03 共用 CreateProject 认证/收据边界，须联合核对 |
| FT-DG-03 | F23 非法 MessageId/AcceptanceId 可 Committed；`planning/proposals/external-command-runtime-codec-decision-draft.md` | 审阅可提交，未接受 | 与 FT-DG-01 联合核对；先固定 codec/旧收据规则再实施 |
| FT-DG-02 | F22 已完成 Work 链接不可读取；`planning/proposals/completed-work-public-view-decision-draft.md` | 审阅可提交，未接受 | 独立于 F21/F23，但不能靠 CurrentWork=null 代替终态 View |
| AH7-DG-01 | 非 Success 结算缺可重放 bounded Observation；`planning/proposals/tool-settlement-observation-replay-decision-draft.md` | 审阅可提交，未接受 | 阻挡 AH7 非成功观察恢复资格 |
| AH7-DG-02 | generic shell 标记 Reconcilable 却无 reality-proof port；`planning/proposals/reconcilable-shell-reality-proof-decision-draft.md` | 审阅可提交，未接受 | 阻挡 AH7 主动外部现实核对资格 |
| 拟议 AH7-DG-03 | P4 `02` 执行前消费 Approval 与 P4 `06` 同 settlement 事务冲突；`planning/proposals/AH7-approval-settlement-atomicity-governance-draft.md` | 精准红测与审阅齐备，未接受 | 先裁决审批消费/预留语义，再补两侧 crash 资格 |
| 拟议 AH10-DG-02（DecisionEpisode 接管调度） | 真实 Scheduler 创建的 `DecisionEpisode` 在 gen0 lease 过期后，第二 daemon 未获取 gen1 lease；`planning/results/AH10-select-current-work-takeover.result.md`、`planning/proposals/AH10-decision-episode-takeover-dispatch-gap-draft.md` | 隔离 pending 红测独立复现；完整 `pnpm check` 通过且排除 pending；尚未接受/未授权实现 | 先人工确认 AH10/G7 recovery 与 DecisionEpisode/Scheduler 的续发所有权；失败发生于旧 receipt/fencing 前，不能记为 SelectCurrentWork takeover PASS |
| AH14-DG-01 | 旧证据含动作时公开 Attention 缺失；`planning/proposals/AH14-legacy-adoption-attention-decision-draft.md` | 负向红测齐备，提案尚需固定严重度、事实身份与写入窗口 | 不得以正向 AH14 2/2 代替负向证据 |
| 拟议 AH10-DG-01（Deliver） | 过期 generation 的 Deliver 仍提交 Message/Event/Inbox；`planning/proposals/AH10-deliver-generation-fence-governance-draft.md` | 真实 SQLite handler 红测与审阅齐备，未接受 | P7 Message handover 与 P1 fenced logical action 的所有权需裁决；不能仅凭 MessageId 唯一键视为接管完成 |
| 拟议 VCS-DG-01（验证命令重放/快照） | 同 CommandId 因 `recordedAt` 漂移产生 `IdempotencyConflict`；已结论 Verification 丢失 P8 冻结的 `criteriaResults`；`planning/proposals/verification-evidence-replay-and-snapshot-governance-draft.md` | 两条真实 Gateway/SQLite 隔离红测和审阅齐备，未接受 | P8 的快照目标不重裁；需决定稳定时间来源与历史已结论行处置，之后才能闭合两类验证控制动作的 AH10 |

当前仍可不等治理继续的工作：AH10 其他 canonical 控制动作的 receipt-first
接管与两侧进程资格；但 DecisionEpisode expired-lease 续发需先审阅拟议
AH10-DG-02，不应绕过 gen1 lease 缺失；AH7 更多失败/多动作交错的崩溃恢复矩阵。AH7 的普通 A→B
双动作真实进程场景和同 ToolInvocationId 的双连接/双 OS 进程同步竞争已有局部
PASS，但不替代进程崩溃/重启资格，也不关闭 DG-01/02/03。所有分支的最终
声明还须回到 `01-functional-journey-catalog.md` F01–F23 与
`02-agent-loop-step-crash-qualification.md` AH1–AH14 逐项审核。
