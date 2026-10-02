# Verifier Execution Settlement 治理裁决草案

**Status:** READY FOR MANUAL GOVERNANCE

**Decision token:** `ACCEPT_VERIFIER_EXECUTION_SETTLEMENT`

**Date:** 2026-10-02

## 1. 要解决的问题

Verifier 已成功提交 canonical `ConcludeVerification` 后，Verification 是真实的
Concluded，但 Agent Loop 没有能如实表达这一结果的 Execution settlement，最终
被轮次上限记为 `Failed(max turns reached)`。

失败证据见：

```text
planning/gaps/verification-execution-settlement-gap.md
```

## 2. 推荐裁决

在 `CompletedResult` 增加：

```ts
{
  readonly _tag: "VerificationConcluded";
  readonly verificationId: VerificationId;
  readonly verdict: VerificationVerdict;
}
```

它只表示：该 ExecutionBound verifier 已经成功提交不可变的 Verification
conclusion。它不表示 Parent 接受，也不表示 Work 完成。

```text
VerificationConcluded execution result
  != Verification Pass
  != Parent Acceptance
  != Work Completed
```

## 3. Runtime 落法

`arbor_conclude_verification` 控制动作按以下顺序执行：

1. summary UTF-8 bytes → BlobStore；
2. 回读并逐字节验证；
3. 通过 CommandGateway 提交 `ConcludeVerification`；
4. 命令必须返回 Committed；
5. 交付幂等 Verification wake；
6. 返回
   `Settle(Completed(VerificationConcluded { verificationId, verdict }))`。

任何一步失败都不得产生 Completed settlement。

## 4. Crash / replay 语义

| crash 点 | 重启行为 |
|---|---|
| Blob 写后、命令前 | 允许孤儿 Blob；Verification 保持 Open |
| 命令提交后、wake 前 | 同 commandId replay 读取既有 Receipt；wake 幂等重放 |
| wake 后、Execution settle 前 | 同一控制 action 恢复，重放 Receipt/wake，然后 settle |
| Execution settle 后 | terminal；不得再次驱动 |

命令 ID、evidence IDs 与 summary content-addressed ref 均保持既有确定性规则。

## 5. Consumer / orphan 规则

- `VerificationConcluded` CompletedResult 不是 `CompletionClaimed`，不得触发新的
  Verification Consumer 输入。
- orphan scanner 只处理 Open Verification；已经 Concluded 的 Verification 不因
  verifier Execution 后续恢复而转为 orphan。
- 旧 verifier Execution 的 Failed/Interrupted 历史保留，不回写。

## 6. 所有权落点

接受后只修改拥有相应语义的文档：

- `docs/design/03-detailed-implementation-design.md`：CompletedResult ADT 与
  AgentAction→settlement 边界；
- `docs/design/implementation/P8/01-verification-commands.md`：结论控制动作的
  settle 顺序；
- `docs/design/implementation/P8/02-verifier-runtime.md`（若当前文件名不同则落在
  P8 拥有 verifier lifecycle 的对应文件）：crash/replay 与 orphan 关系。

不修改 Verification verdict、Acceptance、Work lifecycle、DDL 或权限语义。

## 7. 机械验收

1. conclude command rejected → Execution 不 Completed；
2. conclude committed → exact `VerificationConcluded` CompletedResult；
3. crash at command/wake/settle 三个边界均可重入；
4. `ExecutionSettled` 不被 CompletionClaim consumer 误消费；
5. Pass Verification 仍需独立 Parent Acceptance；
6. live dogfood verifier 不再出现“结论成功但 Execution Failed”；
7. `pnpm check` green。

## 8. 手工裁决

接受本草案时回复：

```text
ACCEPT_VERIFIER_EXECUTION_SETTLEMENT
```

拒绝或修改时，指出希望保留的 settlement 词汇或恢复语义；实现不得自行复用
`QueryCompleted` / `CoordinationCompleted`。
