# P7 — 05 Wait-for Graph & Deadlock Attention

**Authority:** DID v1.10 §11 P7, §6.2, §7.1, §5.3 (DeadlockAttentionRequested, G4), §8.18A (G3); SD v1.3 §14 No.42/No.55, §15.3, §15.5 A3; S3 步骤 5/7/12.
**Status:** DRAFT (first draft for contract review). Cross-refs: `03` §2 (blocking), `04` §1 (coordinator 复检).

## 1. Wait-for Graph（确定性构建）

```text
节点：Open Work（consumer 视角）
边：  consumer Work --expectedDeliverable--> producer 目标
      目标由 ProducerBinding 决定：
        WorkBound(w)       → 普通 Work edge：节点 w
        WorkspaceBound(ws) → **hyperedge（choice / OR 语义）**：目标不是单个
                             Work，而是 ws 的 eligible producer candidate set
                             （结构判定：ws 的全部 Open Work）——任一候选可
                             产出即等待可被解除，因此 **不得 fan-out 成多条
                             普通 Work blocking edge**（会把 OR 选择性等待误报
                             为 SCC 死锁）
        AnyProducer        → 无边（只在匹配事实到达时满足，不构成等待边）
有效边：判定式整体引用 `03` §3 的 blocking(d, w) ——
        d.state = Unsatisfied ∧ consumer Work 引用该依赖 ∧ 存在 active
        WorkWait(DependencyChanged(该依赖))。**Unsatisfied 合取不可省略**：
        依赖已 terminal 而 consumer WorkWait 尚未被 reevaluate 清除的
        wake-latency 窗口内，该依赖不构成有效边（防幽灵边 → 虚假
        DeadlockAttentionRequested）。等待是认知决定——与 G3 一致。

WorkspaceBound 保守退化规则（本版冻结；OR-aware 检测留待未来治理升级）：
  |eligible producer set| == 1 → hyperedge 退化为普通 Work edge，参与
                                 确定性 cycle 检测
  |eligible producer set| == 0 → 不参与 hard-deadlock 判定。子情形如实
                                 区分：ws 已 Retired → producer-loss 规则
                                 （P0）已转 Unfulfillable+Attention；
                                 ws 空置未退休 → **无自动 attention 通道**
                                 （退休被该 unresolved 依赖自身封死，
                                 No.55 不会介入）——已知限制，见
                                 `planning/gaps/P7-GAP-01.md`
  |eligible producer set| >= 2 → 不参与 hard-deadlock 判定（OR 选择性存在，
                                 不能断定死锁；等待解除路径仍开放）
  （OR-aware choice/hypergraph 算法——choice-aware SCC——是本契约显式
    预留的升级缝，其引入属治理变更，不得在实现中自行发明）
```

- graph 是派生视图（Derived View），从 (dependencies × work_waits × works) 纯函数计算，不新增 canonical 实体。

## 2. Cycle 检测与 Deadlock Attention（G4 分层细化）

```text
检测（确定性，L1 纯函数 + L4 触发时机）：
  hasDeadlock(graph) = 存在 wait-cycle 且 cycle 上全部 Work 均 blocked
  （blocking 判定 = `03` §3 判定式，含 Unsatisfied 合取）且 Project 全称
  Idle：∀ ws ∈ Project：classify(ws) = (current = None, runnable = ∅)
  （No.42 "no runnable work" 的 gate 是 No.20 Idle 条件的 Project 量化——
    `03` §2 的 runnable 集已剔除 current，字面 "无 runnable" 会误伤正在
    推进 current 的 Workspace；classify 是唯一权威，`03` §2）
触发原则（冻结的是**原则**，不是封闭事件清单）：任何会改变 (a) runnability、
  (b) wait-for relation、(c) eligible producer candidate set、或 (d) Dependency
  open/terminal state 的 canonical fact 提交后，都必须触发复检。

当前推导集合（illustrative，非穷尽——以原则为准）：
  DependencyDeclared / DependencySatisfied / DependencyWithdrawn /
  DependencyMarkedUnfulfillable / DependencyContractRevised /
  DeliverableProduced /
  WorkWait upsert | clear（Yield 落库 / 唤醒消费）/
  Work lifecycle 变化（**含进入与离开 Open**：WorkAssigned（1→2 增长须
    退出 hard-deadlock 参与；0→1 增长可新形成可判定 cycle）与
    Cancelled | Completed（端点消失、eligible producer 集合收缩））/
  Workspace retirement（兜底触发，与原则 (c)(d) 一致：退休前置要求无
    Open Work，故端点通常已在 work-lifecycle 时点消失；保留 retirement
    复检作为防御性兜底）。
  双侧"先 Declare 后 Yield"形成的 cycle 因此必然在第二个 WorkWait upsert 的
  复检点被发现；producer 侧消失导致的图变化在 lifecycle/retirement 复检点
  被发现。
产出（事实事件，同一可靠提交边界）：
  DeadlockAttentionRequested { cycleWorkIds, dependencyIds, detectedAt }
呈现（L6，Projection）：Attention 视图/路由升级——P7 只产事实，呈现归
  Projection（与 DID §6.2 "Deadlock attention → L6 ✓" 相容：检测产可推导
  事实，L6 呈现之；§6.2 的 ✓ 标注呈现层，不排斥上游产事实）
```

- No.55 兜底：MarkedUnfulfillable 的 Attention 与 Deadlock Attention 是两类事实，分别发出。
- 实现须为 OR-aware 检测（choice-aware SCC）预留接缝：eligible-set 判定与 cycle 检测分离为可替换的纯函数边界（升级时仅替换检测器，图构建与原则不变）。
- S3 语义对齐：Attention ≠ 自动干预；升级/处置仍是 human/Parent 认知（S3 步骤 12 的"撤销/标记无法满足"是治理命令，不是 runtime 自动行为）。

## 3. Must Not Decide

- No 自动解除死锁的 runtime 行为（撤依赖/改合同是治理命令）。
- No 新 Domain 实体（graph 是派生视图）。
- No Attention 呈现/UI（P10）。
- No 跨 Project 等待图（Dependency 同 Project 约束沿 P6 Message 同款）。
