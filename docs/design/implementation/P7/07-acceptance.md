# P7 — 07 Acceptance Stories

**Authority:** S1 步骤 10–11, S3 步骤 3/4/12/14; DID v1.10 §11 P7; P6 `06` 验收风格先例; P7 `01`–`06`.
**Status:** DRAFT (first draft for contract review).

全部 deterministic（Fake Provider / 直接命令提交），同一 durable DB，扩展既有 composition root。

## 1. Story A — 声明、阻塞与静止

1. child Work 声明 `DeclareDependency(WorkBound(parent work))` → `DependencyDeclared`。
2. child Agent `Yield(DependencyChanged(depId, rev 0))` → WorkWait 落库。
3. 断言：classify 将该 Work 移出 runnable（blocking 判定，`03` §2）；无 runnable → 静止；provider turn 计数 = 0（No.20）。
4. 未 Yield 的第二个依赖（Unsatisfied 但无 wait）**不**阻塞 classify（等待是认知决定，G3 blocking 定义）。

## 2. Story B — 生产、投递与自动满足

1. parent Work `ProduceDeliverable(sourceWorkRevision 绑定)` → `DeliverableProduced`。
2. P7 coordinator 消费事件 → candidate lookup → matcher=true → `SatisfyDependency`（authority source=P7Coordinator，deterministic CommandId）→ `DependencySatisfied`。
3. 事务内 wake（DependencySatisfied, from 0 to 1）→ reevaluate → child Work 回 runnable → §8.18A 决策继续。
4. coordinator 重放 → 幂等（同 Receipt）。
5. matcher 反例（kind 不匹配）→ `DependencyNotSatisfiable`，状态不变。
6. 并发：两个 deliverable 竞争 → 首者赢，次者 typed rejection。

## 3. Story C — Deliver primitive（G2）

1. child `Deliver(deliverableId)` directive → SendMessage(kind=Deliver) → parent Inbox（Message 条目，summary 含 deliverable）+ `MessageSent`。
2. 断言：成功 delivery 产生 `ChildDelivered` wake（同一提交边界）。
3. 断言：Deliver 本身**不**满足任何 Dependency（`02`；满足仍走 Story B 的 matcher 链）。
4. sender ≠ deliverable source Workspace → `AuthorityDenied`。
5. Report 通道零 Dependency 副果（P6 D2 回归）。

## 4. Story D — 修订、撤销与 producer-loss（G1）

1. `ReviseDependencyContract`（revision++）→ `DependencyContractRevised`；旧 satisfaction 不被重解释。
2. `WithdrawDependency` → `DependencyWithdrawn`；`MarkDependencyUnfulfillable` → 事件 + Attention 事实。
3. producer-loss：WorkBound producer Work Cancelled → 批量 Unfulfillable（domain 已有函数端到端接线）+ wake。
4. 显式 agent `SatisfyDependency` directive（ConsumerExecution authority）与 coordinator 路径提交**同一 Command**、同一 matcher（G6 单命令面）。

## 5. Story E — Wait-for graph / Deadlock（G4）

1. 两 Work 互 WorkBound 依赖 + 双侧"先 Declare 后 Yield"（断言在第二个 WorkWait upsert 的复检点发现）+ Project 内全部 Workspace classify = (current=None, runnable=∅) → `DeadlockAttentionRequested`（cycle 成员、依赖清单）。
2. 断言：无任何自动 lifecycle mutation（Work/Dependency 状态不变）。
3. 解除一侧（Withdraw）→ 该提交触发复检，hasDeadlock=false，不再产生新的 `DeadlockAttentionRequested`（既有事实不可变；"resolved" 呈现语义归 L6/P10 治理）。
4. B-2 保守退化回归（WorkspaceBound）：目标 ws 恰 1 个 Open Work → 退化边参与，互等场景照发 attention；≥2 个 eligible producer 的对称互等场景 → **不**发 `DeadlockAttentionRequested`（OR 选择性，非 hard-deadlock）——SCC 假死锁反例断言。
5. B-2 零候选：目标 ws 无 Open Work 且未退休 → 不发 `DeadlockAttentionRequested`（不做 hard-deadlock 判定）。
6. B-4 复检触发回归：cycle 存在期间目标 ws 新 Work 指派（eligible set 1→2）→ 复检后退出 hard-deadlock 判定；0→1 → 退化边开始参与；producer 侧 Work Completed/Cancelled 同为复检点。
7. 幽灵边回归：依赖已 Satisfied 但 consumer WorkWait 尚未清除（wake 未消费）窗口内复检 → 不发 `DeadlockAttentionRequested`（有效边判定含 Unsatisfied 合取，`03` §3）。

## 6. Story F — classification 对齐（G3 inherited evolution）

1. P5 provisional runnable-source 套件按 P7 期望更新后全绿（current/runnable/blocking 三态）。
2. classify 是唯一 runnable 权威：构造"有 WorkWait + 无 wait 依赖"与"无 WorkWait + 有 wait 依赖"矩阵，断言 decide() 输出与 classify 一致（呈现输入等价性，`03` §2）。

## 7. 机械断言清单

```text
- 六命令事件序列与拒绝集逐条 = `01`
- Deliver 链 wake/Inbox/不满足三断言 = `02`
- classify 权威 + blocking 判定矩阵 = `03`
- coordinator 幂等/死信/单命令面 = `04`
- Deadlock 事实 + 零自动 mutation + B-2 三分支（1/≥2/0）+ B-4 复检触发 = `05`
- wake 事务边界 + observedRevision 递进 = `06`
- satisfaction immutable；Deliverable 溯源 sourceWorkRevision（No.49）
- No runnable → 零模型调用（No.20）
- P5/P6 回归护栏（runnable-source 套件按取代语义更新，其余不动）
```

## 8. Must Not Decide

- No 真实模型/human 在线 gating；No P8 行为进入断言（验证词出现即越界）。
- No UI/projection 呈现验收（P10）。
