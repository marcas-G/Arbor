# P7 — 02 Runnability & Re-evaluation (PROPOSAL)

**Authority:** DID v1.9 §8.16:2847-2868, §8.18A, §11 P7; v1.9 G2; SD v1.3 §5.2, §7.5:795, §7.6; P2 `02` §7 / `05`; P5 `02`; S3 步骤 3/4。
**Status:** DESIGN CLOSURE DRAFT（GQ3/GQ6 待背书）。

## 1. 取代 provisional RunnableWorkSource（GQ3 冻结解读）

Port 形状不变（P2 冻结签名）；实现替换为 dependency-aware，其含义是：

```text
classify(workspaceId):
  current  = workspace.currentWorkId 且该 Work 属于 Open 集（与 P5 同）
  runnable = Open Work − current − {存在 active WorkWait 的 Work}，确定性排序
```

**classify 不读 Dependency 状态。** Dependency 通过两条正交通道影响调度：

1. **认知通道（Agent 侧）**：Agent 判断无可推进路径 → `Yield(waitSpec=[DependencyChanged(id, observedRevision)])` → P2 冻结的 WorkWait 机制把该 Work 移出 runnable（S3 步骤 3：依赖≠停摆；等待是认知决定，DID:2868 DeclareDependency 后不一定 Yield）。
2. **事实通道（Runtime 侧）**：`DependencySatisfied`（及 Withdrawn/Unfulfillable/ContractRevised）→ wake 信号（`04`）→ scheduler.reevaluate(workspace, DependencySatisfied) → §8.18A 决策表重算（P2 冻结，不改）。

推导依据：P2 `02` §7 "Runnability classification is P7-owned; P2 consumes it"；P5 `02` provisional 语义（current/open only，无 wait 维度）已被 P5 实现修正为 wait-aware（`decide()` 的 hasWait 输入）；"dependency-aware" 的最小一致解释 = 事实通道完整 + classify 保持 WorkWait 单一等待源。

## 2. 自动满足路径（DeliverableProduced → SatisfyDependency）

```text
DeliverableProduced 事件（produce 事务提交）
  → Coordination Consumer（at-least-once，DID §5.4）
  → candidate 扫描（GQ6 推荐：produce 时点，同 Project 全部 Unsatisfied Dependency
     的 matcher 评估——AnyProducer 全集；WorkspaceBound/WorkBound 由
     deliverable.sourceWorkId/sourceWorkspaceId 过滤）
  → 对每个 matcher=true 的 (deliverable, dependency)：
     SatisfyDependency via CommandGateway，
     CommandId = deterministic f(deliverableId, dependencyId, dependencyRevision)
  → matcher=false 或 revision 前移：跳过（at-least-once 重投由幂等吸收）
```

- Consumer 失败/死信走 P1 既有 consumer 基建；不阻塞 produce 事务。
- 不自动满足的兜底：human/agent 仍可显式提交 SatisfyDependency（同一 matcher 把关）。

## 3. Re-evaluation 触发（automatic runnable reevaluation）

| 事件 | 触发 |
|---|---|
| DependencySatisfied | wake 每个 WorkWait 含 `DependencyChanged(id, observedRevision<new)` 的 consumer Workspace（`04` §2） |
| DependencyWithdrawn / MarkedUnfulfillable / ContractRevised | 同上（observedRevision 变化即 wake） |
| DeadlockAttentionRequested | Attention 通道（L6），不直接调度 |
| 其余事件 | 不触发（Event≠启动 Agent，只 reevaluation，DID:1571） |

- 触发后的行为完全由 P2 §8.18A 决策表决定（No runnable → 静止，No.20：No Runnable Work → No Model Call）。

## 4. Must Not Decide

- No scheduler 决策表 / WorkWait 机制修改（P2）。
- No classify 依赖 Dependency 状态的公式（GQ3 背书后即冻结）。
- No 质量判断进入 runnable/satisfaction（P8）。
- No 模型轮询（No.53：等待期禁止模型调用）。
