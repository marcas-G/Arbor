# P7 — 04 Wake Integration (PROPOSAL)

**Authority:** DID v1.9 §8.16:2814-2835, §8.18:2920-2935, v1.7 G3 职责三分; SD v1.3 §7.6:813, §14 No.53; P2 `05`; P6 settlement wake 先例（specialist-settlement.ts 的 wakeReason 模式）。
**Status:** DESIGN CLOSURE DRAFT。

## 1. 职责边界（复述冻结三分，P7 落 source 侧）

```text
P2 owns: durable WorkWait 注册/清除、timer/wake 机器、lost-wake-up 防护
P7 owns: DependencyChanged wake-signal 生产（本次实现）
P6 已接: InboxAdvanced→InputArrived（settlement/specialist wakeReason 先例）
```

## 2. DependencyChanged wake 生产（同一提交边界）

```text
SatisfyDependency（及 Withdraw/MarkUnfulfillable/ContractRevised）handler 事务内：
  新 dependency.revision = r'
  对每个 consumer Work 的 active WorkWait：
    若 conditions 含 DependencyChanged(dependencyId, observedRevision=r) 且 r < r'
      → 发布 wake(workspaceId=consumer Work 所属 Workspace,
                 reason={_tag:"DependencySatisfied"|"InputArrived", dependencyId, from:r, to:r'})
  （WakeReason 选用：满足→DependencySatisfied；撤销/无法满足/改约→InputArrived，
   两者已在 domain scheduler.ts:9-18 冻结）
```

- 注册等待与检查事实变化同一一致性边界（SD:813）——由 handler 事务保证；若 observedRevision 已前移（r ≥ r'），不发 wake（该等待早已被更高版本事实唤醒或将被其消费）。

## 3. 消费侧（P7 补齐的最小管线）

| 现状缺口 | P7 交付 |
|---|---|
| `reevaluate` 忽略 `_wakeReason` | wakeReason→目标 workspace 集合路由（DependencySatisfied→consumer Work 的 Workspace；其余→reason 携带的目标） |
| `AdmissionOutcome.wakeReason` 零消费方 | 统一 wake sink：daemon-lite（composition 内的后台 fiber：消费 journal 事件表驱动 reevaluate 循环）或同步 consumer 管线直调——**实现选择**，契约只冻结"事件提交后最终至少触发一次 reevaluate，at-least-once，幂等" |
| `clearWorkWait` 零调用 | reevaluate 判定 Work 已 runnable 时清除对应 wait（P2 冻结机制的正确接线） |

- 禁止模型轮询（No.53 原文：等待期间禁止**模型轮询**）：一切唤醒由 durable 事实驱动。
- `ChildDelivered` WakeReason（scheduler.ts:14 已预留）的启用归 GQ2(iii) 裁决；P7 wake 生产默认仅 DependencySatisfied/InputArrived 两态。

## 4. Must Not Decide

- No WorkWait/timer 机制修改（P2）。
- No 新 WakeCondition/WakeReason 变体（既有白名单足够）。
- No 跨 Project wake。
