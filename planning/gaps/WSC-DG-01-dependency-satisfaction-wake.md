# WSC-DG-01 — DependencySatisfied 不递增 revision，严格 revision wake 无法清 wait

## 状态

**RESOLVED — `ACCEPT_DEPENDENCY_SATISFACTION_CLEARS_WAIT_WITHOUT_REVISION_ADVANCE`；
DID WSC-1 + P7 `06`/`07` 已落字并实现。**

## 机械反例

冻结实现同时规定：

1. `satisfyDependency` 从 `Unsatisfied` 进入 `Satisfied` 时保持 Dependency revision；
2. `SatisfyDependencyResult.wakeSignals` 产生
   `fromRevision === toRevision`；
3. `WakeSink` 只有在 `observedRevision < toRevision` 时清除
   `DependencyChanged` wait。

因此最小反例为：

```text
Dependency revision = 0, state = Unsatisfied
WorkWait observes DependencyChanged(dependencyId, observedRevision = 0)
SatisfyDependency commits state = Satisfied, revision = 0
Wake signal carries fromRevision = 0, toRevision = 0
WakeSink predicate: 0 < 0 = false
WorkWait remains
Scheduler sees hasWait = true and returns Idle
```

证据位置：

- `packages/application/src/commands/satisfy-dependency.ts`：明确断言
  `fromRevision == toRevision`；
- `packages/application/src/wake-sink.ts`：严格 `< toRevision`；
- `packages/execution-runtime/src/scheduler.ts`：当前 Work 有 wait 时不 Admit；
- `tests/p7-satisfy-dependency.test.ts`：冻结预期 `0 → 0`；
- `tests/p7-wake-pipeline.test.ts`：只证明 `0 → 1` 能清除，没有覆盖真实
  satisfaction 的 `0 → 0`。

## 建议裁决

推荐保持 Dependency revision 合同不变，将 `DependencySatisfied` 解释为独立的终态
事实：WakeSink 对相同 `dependencyId` 的 `DependencyChanged` wait 无条件幂等清除，
不再要求 revision 严格前进。理由：

- satisfaction 本身已经是 canonical state transition；
- Satisfied 为终态，不存在相同 revision 下回到 Unsatisfied；
- replay 时 wait 已清除，重复 DELETE 与 reevaluate 均幂等；
- 不扩大 Dependency/Command/Event/DDL 迁移面。

备选方案是 satisfaction 递增 Dependency revision，但会修改 Domain transition、事件、
payload、测试和下游绑定，迁移面明显更大。

## 关闭条件

1. 人工治理在 P7/DID owning contract 选择一种语义；
2. 用真实 `fromRevision === toRevision` 场景证明 wait 被清除；
3. 重复事件无害，目标忙碌时不产生第二个 active main；
4. Scheduler 在 wait 清除后能够 Admit 或选择 runnable Work。

## Resolution

- DependencySatisfied 保持 revision-stable；
- 相同 dependencyId 的 DependencyChanged wait 按终态事实无条件幂等清除；
- 非终态 Dependency revision change 保持严格 revision 前进规则；
- WorkflowSignalConsumer 使用 DomainEvent + canonical repository snapshot
  驱动 clear → reevaluate；
- `tests/p7-wake-pipeline.test.ts` 与
  `tests/workflow-signal-consumer.test.ts` 覆盖真实 `0 → 0` 场景与重复安全性。
