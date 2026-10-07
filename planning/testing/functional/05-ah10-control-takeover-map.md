# AH10 控制命令接管覆盖图

日期：2026-10-07

依据：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
和 `planning/results/AH10-generation-command-takeover-gap.result.md`。
本图为实现/测试排程，不扩展冻结语义。

| 动作 | Command 路径 | 现有跨代证据 | 下一退出门 |
|---|---|---|---|
| AssignWork | CommandGateway | handler 红转绿：FencingRejected、Committed 收敛、非 fencing 拒绝 | 持久 Work 完整字段核对；真实进程提交两侧 |
| ProduceDeliverable | CommandGateway | handler 分支 + 真双 daemon 旧拒绝→新代唯一产物 | 持久 Deliverable/artifact 事实核对；两侧 kill/restart |
| DeclareDependency | CommandGateway | handler FencingRejected、Committed、拒绝和缺 canonical row | 真实进程资格与已演化状态组合 |
| AcceptResult | CommandGateway | handler FencingRejected、Committed、拒绝和缺 Acceptance row | 真实进程资格及已完成 Work 恢复 |
| SendMessage | CommandGateway | handler Query/Reply 回执、Message 行与关闭 correlation | 真实进程资格、Report/DecisionRequest 扩展 |
| SelectCurrentWork | CommandGateway | 未有 AH10 专项 | receipt-first + Workspace 当前选择/DecisionRequest 收敛；保留 gen0 DecisionId 编码 |
| RecordVerificationEvidence | CommandGateway | 未有 AH10 专项 | receipt-first + Evidence 行的 criterion/source/execution 精确核对 |
| ConcludeVerification | CommandGateway | 未有 AH10 专项 | receipt-first + Verification 最终状态/summaryRef/verdict/criteriaResults 核对 |
| Deliver | `submitDeliver` 组合 Message handover，非 CommandGateway | pending SQLite 红测：旧代越过新 lease 写 Message/Event/Inbox；同 MessageId 重入无重复但失败；`planning/results/AH10-deliver-generation-fence.review.md` | 拟议 AH10-DG-01 先裁决写入 fencing/receipt 所有权；不强塞 Gateway，也不能把唯一键失败叫成功收敛 |

五类 Gateway handler 中相同的旧回执查询机械流程已收敛成内部 helper；
每类 Committed receipt 的 canonical fact 校验、非 fencing 拒绝的原有错误代数
仍留在 handler。新增动作逐项先红测后实现。若 `attemptOrdinal` 需要新的持久
来源，或要改变 `Deliver` 的 canonical handover 边界，按 Design Gap 停止该部分。
