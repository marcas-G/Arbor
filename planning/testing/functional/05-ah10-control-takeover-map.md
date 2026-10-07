# AH10 控制命令接管覆盖图

日期：2026-10-07

依据：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
和 `planning/results/AH10-generation-command-takeover-gap.result.md`。
本图为实现/测试排程，不扩展冻结语义。

| 动作 | Command 路径 | 现有跨代证据 | 下一退出门 |
|---|---|---|---|
| AssignWork | CommandGateway | handler 红转绿：FencingRejected、Committed 收敛、非 fencing 拒绝；真双 daemon current-Workspace exact CAPA grant：旧 FencingRejected receipt 提交前/后 kill/restart + Committed receipt/Action Pending 三案 3/3 PASS，唯一 Work/WorkAssigned/Observation，Provider decision 一次 | Direct-child placement 的授权/目标路径及更多状态组合 |
| ProduceDeliverable | CommandGateway | handler 分支 + 真双 daemon 旧拒绝回执事务前/后杀旧进程、新命令提交后 Action Pending 杀进程，三案均唯一产物/Provider | 其余控制动作的相同进程矩阵；持久 Deliverable/artifact 全事实核对 |
| DeclareDependency | CommandGateway | handler FencingRejected、Committed、拒绝和缺 canonical row；真双 daemon 旧 FencingRejected receipt 提交前/后杀进程 2/2 PASS，gen1 同 LogicalAction 接管，唯一 Dependency/Observation/Provider；新增 Committed receipt/Action Pending 后杀 gen0，gen1复用原receipt收敛唯一Dependency/Event/Observation | 已演化状态组合与其他命令分支 |
| AcceptResult | CommandGateway | handler FencingRejected、Committed、拒绝和缺 Acceptance row；真双 daemon旧 FencingRejected receipt提交前/后2/2，新代经`list_workspaces`取得真实resultRef后唯一Acceptance/Child Work Completed；新增 Committed receipt/Action Pending 后杀gen0，gen1复用原receipt收敛唯一Acceptance/Event/Observation并完成Child Work | 更多已演化状态组合；其他命令分支 |
| SendMessage | CommandGateway | Query 旧 FencingRejected receipt 提交前/后双 daemon 2/2；Committed Reply 在 Query Inbox 消费、correlation closed、Action Pending/无 Observation 崩溃后 receipt-first 收敛1/1；DecisionRequest 旧 receipt 提交前/后双 daemon2/2。DecisionRequest为同一ProviderTurn持久两条ToolCall：send_message→wait；ActionResult gate前同项目workflow-signals offset落后于MessageSent为预期暂停，gate释放后child WorkEpisode settle、offset越过目标sequence、唯一Parent InboxEpisode admitted。当前文件5/5 PASS | 其他消息种类（Report等）及剩余控制动作/状态组合 |
| SelectCurrentWork | CommandGateway | handler FencingRejected、Committed 后 DecisionRequest Pending/Submitted、非 fencing 拒绝与历史 gen0 ID 定向测试 PASS；真实 Scheduler `DecisionEpisode` 双 daemon：旧 gen0 FencingRejected receipt 提交前/后 kill 2/2；Committed receipt/Action Pending kill/restart 1/1，gen1从同一 settled ProviderTurn 的 pinned manifest 精确重放，收敛原 Execution `Completed(DecisionSubmitted)`、Step `SettlementProposed`、Action Applied、唯一 Observation/settlement receipt；guard负测拒绝错 Workspace/Manifest。该扩展不发新 Provider 请求。未覆盖 malformed replay 被拒绝后，`proposeSettlement(Failed)` 是否收敛原 `ActionsInProgress` Step（潜在 P2 follow-up，未确认产品缺陷） | 更多已演化状态组合；AH10 其他控制动作仍需进程资格 |
| RecordVerificationEvidence | CommandGateway | pending 红测：同 ID 重试因 `recordedAt` 变化出现不同请求指纹 | 先裁决时间来源并保持同 ID 同指纹，再做 receipt-first + Evidence criterion/source/execution 精确核对 |
| ConcludeVerification | CommandGateway | pending 红测：已提交结论读不回 P8 冻结的逐 criterion 快照 | 先补已冻结快照并裁决旧行迁移，再做 receipt-first + Verification 最终状态/summaryRef/verdict/criteriaResults 核对 |
| Deliver | `submitDeliver` 组合 Message handover，非 CommandGateway | pending SQLite 红测：旧代越过新 lease 写 Message/Event/Inbox；同 MessageId 重入无重复但失败；`planning/results/AH10-deliver-generation-fence.review.md` | 拟议 AH10-DG-01 先裁决写入 fencing/receipt 所有权；不强塞 Gateway，也不能把唯一键失败叫成功收敛 |

五类 Gateway handler 中相同的旧回执查询机械流程已收敛成内部 helper；
每类 Committed receipt 的 canonical fact 校验、非 fencing 拒绝的原有错误代数
仍留在 handler。新增动作逐项先红测后实现。若 `attemptOrdinal` 需要新的持久
来源，或要改变 `Deliver` 的 canonical handover 边界，按 Design Gap 停止该部分。
