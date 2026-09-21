# P8 — 03 Chain Consumers & Wake (PROPOSAL)

**Authority:** DID v1.10 §6A.6:1897-1906, §3.4:1116, §8.16, §5.4, §8.18; v1.9 G4; §12.2:3850-3852; S1 步骤 9; P5 `04` §3（交接点）, P7 wake-sink 先例。
**Status:** DESIGN CLOSURE DRAFT（GQ4/GQ5 关联）。

## 1. Consumer A：CompletionClaimed → StartVerification

```text
ExecutionSettled(CompletionClaimed { workRevision, claimRef }) 事件
  → P8 verification consumer（at-least-once，DID §5.4）
  → StartVerification via CommandGateway
     CommandId = deterministic f(workId, workRevision, claimRef)
     authority = StartVerificationAuthority（System origin, causationRef=eventId）
  → missionSnapshot = work.verificationMission 快照（同事务读取）
  → 幂等：同 CommandId 重放返回既有 Receipt；Work 已 Closed/revision 前移 → typed rejection 记录（不重放燃烧）
```

- Crash 恢复确定性（DID §12.2）：settlement 持久携带 workRevision+claimRef → replay 恢复（P5 已持久化，零代码缺口确认）。

## 2. Consumer B：WorkOutcomeAccepted → CompleteWork（GQ4 推荐形态）

```text
WorkOutcomeAccepted { workId, targetWorkRevision, verificationId } 事件
  → P8 completion consumer
  → CompleteWork via CommandGateway
     CommandId = deterministic f(workId, targetWorkRevision, verificationId)
     authority = CompleteWorkAuthority（System origin）
  → precondition 七连式由 handler 复验（consumer 不是 authority 豁免）
  → 幂等：Work 已 Completed → 既有 Receipt / TerminalLifecycleMutation 记录
```

- Acceptance 仍是 Parent 语义决定（人工判断"足够"）；Complete 是验证链的系统闭合——链两端对称（CompletionClaimed 与 WorkOutcomeAccepted 各驱动一步 deterministic 消费）。

## 3. Verdict wake 生产——双通道（source phase = P8；round-1 修订）

**通道 1：WakeCondition 释放（任意 verdict，含 PASS）。** 结论的产生（PASS/FAIL/UNKNOWN 任一）都是 `VerificationChanged` 等待条件的事实变化——satisfaction ⟂ quality 意味着质量敏感的下游只能用该条件表达"等该 Work revision 有已结论验证"：

```text
ConcludeVerification 提交事务内（照 P7 `06` §2 SatisfyDependency 先例）：
  扫目标 Workspace 各 Work 的 active WorkWait：
    conditions 含 VerificationChanged(_, observed=旧) → 释放（clear + wake）
```

**通道 2：WakeReason 路由（仅 FAIL/UNKNOWN）。** Producer 侧返工/补证据认知入口：

```text
  → wake(workspaceId = 目标 Work 所属 Workspace,
         reason = { _tag: "VerificationReturned" },
         detail = { verificationId, workId, workRevision, verdict })
     Fail    → reevaluate（S1 步骤 9：原 Agent 返工，不换人）
     Unknown → reevaluate（补证据/改方式/向上请求；UNKNOWN ≠ FAIL 不触发返工分支）
     Pass    → 不发本通道（Acceptance 是 Parent 认知，不是唤醒事件）
```

- `VerificationChanged` WakeCondition 的**形状变更**（GQ5，round-1 重写为诚实裁决）：P0 冻结形状为 `{ verificationId, observedRevision }`——verificationId-keyed 条件无法表达"等该 Work revision 出现已结论验证"（等待者无法预知 verificationId；无上限并发下更甚）。裁决请求：形状改为 `{ workId, observedWorkRevision }`（与 DependencyChanged 同构；refine → revision 前移 → 旧 wait 自然失效）。涉及 scheduler.ts 冻结类型修改，与 GQ6（并发无上限）并案。

## 4. Must Not Decide

- No consumer 绕过 Command Handler（DID §5.4）；No event=启动 Agent（只 reevaluate）。
- No wake 消费侧机制修改（P2/P7 wake-sink）；No 新 WakeReason/WakeCondition。
