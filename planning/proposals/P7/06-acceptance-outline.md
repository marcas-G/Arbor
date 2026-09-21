# P7 — 06 Acceptance Outline (PROPOSAL)

**Authority:** S1 步骤 10-11, S3 步骤 3/4/12/14; DID §11 P7; P6 `06` 验收风格先例。
**Status:** DESIGN CLOSURE DRAFT（概要；冻结版在契约落位时定稿）。

全部 deterministic（Fake Provider / 直接命令提交），同一 durable DB。

- **Story A — 声明与等待**：child Work 声明 Dependency(WorkBound(parent work))→ 事件→ Agent Yield(DependencyChanged)→ WorkWait 落库→ classify 将该 Work 移出 runnable→ 无 runnable → 静止（No.20：无模型调用，用 provider turn 计数=0 断言）。
- **Story B — 交付与自动满足**：parent Work ProduceDeliverable（sourceWorkRevision 绑定）→ consumer 管线自动 SatisfyDependency（deterministic CommandId；重放幂等）→ DependencySatisfied + wake → reevaluate → consumer Work 回到 runnable → scheduler 按 §8.18A 决策。含 matcher 反例（kind 不匹配 → DependencyNotSatisfiable，状态不变）。
- **Story C — 修订与撤销（GQ1 后定稿）**：ReviseDependencyContract（revision++，旧 satisfaction 不重解释）→ Withdraw（consumer 不再需要）→ MarkUnfulfillable（Attention 事实）。producer-loss：WorkBound producer Work Cancelled → 批量 Unfulfillable（domain 已有函数的端到端接线）。
- **Story D — Wait-for graph / Deadlock（GQ4 后定稿）**：两个 Work 互相 WorkBound 依赖 + 双方 WorkWait + 无其他 runnable → DeadlockAttentionRequested 事实（cycle 成员、依赖清单）；解除（withdraw 其中一边）→ 后续检测不再报（Attention 事实已存在不撤回，新事实表达现状）。
- **Story E — Deliver 组合（GQ2=b 后定稿）**：child deliver → parent 若有匹配 Dependency 自动满足 + parent Inbox 出现 Deliverable 通知；Report 通道零 Dependency 副果（P6 D2 回归）。
- **机械断言**：事件序列与拒绝集逐条=契约；satisfaction immutable（重放无变化）；Deliverable 溯源 sourceWorkRevision（No.49）；No runnable→零模型调用；P5/P6 回归护栏（P5 runnable-source 套件按取代语义更新为 P7 期望，其余不动）。
