# SCRC Overflow Successor Chain — 治理决策草案

## 状态

**DRAFT / 等待人工治理。** 关联 `SCRC-DG-02`。

## 问题

Inference ProviderTurn 因 ContextLimitExceeded 失败后，Compaction 会产生新的
ContextEpoch/request/Manifest。旧 ProviderTurn identity 不可修改；现有
AgentLoopStep 又只绑定一个 providerTurnId。复用旧 Turn、伪装 repairAttempt 或随机
生成未持久后继都会破坏恢复与幂等。

## 建议裁决 OVS-1…OVS-7

1. 一个 AgentLoopStep 可以拥有有序 `ProviderTurnLink[]`；AgentLoopStep identity
   `(executionId, logicalStepNo, repairAttempt)` 不变。
2. Link role 封闭为：`Inference | OverflowCompaction | OverflowReplacement`。
3. Identity 为 `(AgentLoopStep identity, overflowOrdinal, role)`；v1 只允许
   `overflowOrdinal = 0`，从而机械保证最多一次恢复。
4. 原 Inference Turn 以 ContextLimitExceeded terminal 事实保留；不得修改其 Manifest。
5. Compaction checkpoint/epoch 提交后，唯一 `OverflowReplacement` Turn 使用新
   Manifest；它仍属于同一 AgentLoopStep，不消耗 output repairAttempt。
6. 只有原 Turn 尚无 durable AssistantMessage/ToolCall/ToolResult/ControlResult 或外部
   effect 时可创建 chain；否则 Stop/Attention，禁止 replay。
7. replacement 再次 ContextLimitExceeded terminal；不创建第二条 chain。

## 持久合同

建议 migration 0020 新增：

```text
agent_loop_step_provider_turns
  execution_id
  logical_step_no
  repair_attempt
  overflow_ordinal
  role
  provider_turn_id UNIQUE
  predecessor_provider_turn_id?
  context_epoch
  manifest_id?
  state = Prepared | SettledSuccess | SettledFailure
  PRIMARY KEY(step identity, overflow_ordinal, role)
```

既有 `agent_loop_steps.provider_turn_id` 继续指原 Inference Turn，保持历史兼容；chain
table 只记录 overflow successor，不重写 migration 0017/0019。

## 恢复

```text
original ContextLimitExceeded
→ ensure OverflowCompaction link
→ completed checkpoint + epoch
→ ensure OverflowReplacement link
→ run/replay replacement
→ continue same AgentLoopStep action phase
```

每个 ensure 操作 source-key 幂等；任一 identity/binding mismatch 产生 Attention。

## 非目标

- 不泛化无限 ProviderTurn graph；
- 不改变 Work/Execution settlement；
- 不把 ordinary transport retry 放进 chain；
- 不把 output-contract repair 混入 overflow ordinal；
- 不允许 durable effect 后恢复。

## 接受口令

```text
ACCEPT_SCRC_OVERFLOW_SUCCESSOR_CHAIN
```
