# P7 — 03 Wait-for Graph & Deadlock Attention (PROPOSAL)

**Authority:** DID v1.9 §11 P7, §6.2:1609, §7.1:2047; SD v1.3 §14 No.42/No.55, §15.3:1577, §15.5 A3; S3 步骤 5/7/12。
**Status:** DESIGN CLOSURE DRAFT（GQ4 分层细化待确认）。

## 1. Wait-for Graph（确定性构建）

```text
节点：Open Work（consumer 视角）
边：  consumer Work --expectedDeliverable--> producer 目标
      目标由 ProducerBinding 决定：
        WorkBound(w)      → 节点 w
        WorkspaceBound(ws)→ ws 的全部 Open Work（当且仅当存在）或 ws 汇聚节点
        AnyProducer       → 无边（AnyProducer 依赖不构成等待边，只在匹配事实到达时满足）
有效边：仅当 consumer Work 存在 active WorkWait(DependencyChanged(该依赖))
        （等待是认知决定——与 GQ3 一致：未 Yield 的依赖不进 wait-for graph）
```

- graph 是派生视图（Derived View），从 (dependencies × work_waits × works) 纯函数计算，不新增 canonical 实体。

## 2. Cycle 检测与 Deadlock Attention（GQ4 分层细化）

```text
检测（确定性，L1 纯函数 + L4 触发时机）：
  hasDeadlock(graph) = 存在 cycle 且 cycle 上全部 Work 均有 active WorkWait
  且（No.42）受影响集合内无其他 runnable Work
触发时机（实现选择）：DependencySatisfied/Withdrawn/ContractRevised 事务后
  的 Coordination Consumer 步骤内评估（同 `02` §2 的消费管线，不新增 daemon——
  破坏条件的变更恰好是需要复检的时点）
产出（事实事件，同一可靠提交边界）：
  DeadlockAttentionRequested { cycleWorkIds, dependencyIds, detectedAt }
呈现（L6，Projection）：Attention 视图/路由升级——P7 只产事实，呈现归
  Projection（与 DID §6.2 "Deadlock attention → L6 ✓" 相容：检测产可推导
  事实，L6 呈现之；§6.2 的 ✓ 标注呈现层，不排斥上游产事实）
```

- No.55 兜底：MarkedUnfulfillable 的 Attention 与 Deadlock Attention 是两类事实，分别发出。
- S3 语义对齐：Attention ≠ 自动干预；升级/处置仍是 human/Parent 认知（S3 步骤 12 的"撤销/标记无法满足"是治理命令，不是 runtime 自动行为）。

## 3. Must Not Decide

- No 自动解除死锁的 runtime 行为（撤依赖/改合同是治理命令）。
- No 新 Domain 实体（graph 是派生视图）。
- No Attention 呈现/UI（P10）。
- No 跨 Project 等待图（Dependency 同 Project 约束沿 P6 Message 同款）。
