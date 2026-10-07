# AH10 控制命令接管覆盖图

日期：2026-10-07

依据：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
和 `planning/results/AH10-generation-command-takeover-gap.result.md`。
本图为实现/测试排程，不扩展冻结语义。

| 动作 | Command 路径 | 现有跨代证据 | 下一退出门 |
|---|---|---|---|
| AssignWork | CommandGateway | handler 红转绿：FencingRejected、Committed 收敛、非 fencing 拒绝 | 持久 Work 完整字段核对；真实进程提交两侧 |
| ProduceDeliverable | CommandGateway | handler 分支 + 真双 daemon 旧拒绝回执事务前/后杀旧进程、新命令提交后 Action Pending 杀进程，三案均唯一产物/Provider | 其余控制动作的相同进程矩阵；持久 Deliverable/artifact 全事实核对 |
| DeclareDependency | CommandGateway | handler FencingRejected、Committed、拒绝和缺 canonical row；真双 daemon 旧 FencingRejected receipt 提交后杀进程、gen1 同 LogicalAction 接管，唯一 Dependency/Observation/Provider PASS | 提交前边界和已演化状态组合 |
| AcceptResult | CommandGateway | handler FencingRejected、Committed、拒绝和缺 Acceptance row | 真实进程资格及已完成 Work 恢复 |
| SendMessage | CommandGateway | handler Query/Reply 回执、Message 行与关闭 correlation | 真实进程资格、Report/DecisionRequest 扩展 |
| SelectCurrentWork | CommandGateway | handler FencingRejected、Committed 后 DecisionRequest Pending/Submitted、非 fencing 拒绝与历史 gen0 ID 定向测试 PASS | 仍需公开进程跨代资格及冲突状态组合 |
| RecordVerificationEvidence | CommandGateway | pending 红测：同 ID 重试因 `recordedAt` 变化出现不同请求指纹 | 先裁决时间来源并保持同 ID 同指纹，再做 receipt-first + Evidence criterion/source/execution 精确核对 |
| ConcludeVerification | CommandGateway | pending 红测：已提交结论读不回 P8 冻结的逐 criterion 快照 | 先补已冻结快照并裁决旧行迁移，再做 receipt-first + Verification 最终状态/summaryRef/verdict/criteriaResults 核对 |
| Deliver | `submitDeliver` 组合 Message handover，非 CommandGateway | pending SQLite 红测：旧代越过新 lease 写 Message/Event/Inbox；同 MessageId 重入无重复但失败；`planning/results/AH10-deliver-generation-fence.review.md` | 拟议 AH10-DG-01 先裁决写入 fencing/receipt 所有权；不强塞 Gateway，也不能把唯一键失败叫成功收敛 |

五类 Gateway handler 中相同的旧回执查询机械流程已收敛成内部 helper；
每类 Committed receipt 的 canonical fact 校验、非 fencing 拒绝的原有错误代数
仍留在 handler。新增动作逐项先红测后实现。若 `attemptOrdinal` 需要新的持久
来源，或要改变 `Deliver` 的 canonical handover 边界，按 Design Gap 停止该部分。
