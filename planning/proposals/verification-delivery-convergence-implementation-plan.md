# Verification Delivery Convergence 实施准备

**Status:** READY FOR REVIEW — implementation-ready seams separated from governance gates

**Date:** 2026-10-02

## 1. 当前真实状态

```text
Work: wrk_01a0f834-681f-7b62-9455-aa83bba1e10b
Lifecycle: Open
Revision: 1
CompletionClaimed events: 5
WorkWait: VerificationChanged(workId, revision=1)
Verification rows: 0
Active main Execution: 0
Verification consumer offset: 已越过全部 CompletionClaim 事件
Dead letters: 0
```

当前 Work 的 VerificationMission 是完整结构，不是 placeholder：

```text
goal: 独立确认旧无界 conversation retry runtime 无法重新进入生产源码
required criteria:
  - p17-legacy-symbols-absent
  - focused-test-green
  - scope-isolated
```

## 2. 根因分层

### 2.1 可立即修复的实现偏差

P8 M-4 冻结 `ExecutionSettled(CompletionClaimed)` 的 consumer 输入为：

```ts
{ executionId, workId, workRevision, claimRef }
```

生产 emitter 当前只写：

```ts
{ executionId, settlement }
```

`workRevision/claimRef` 藏在 `settlement.result`，`workId` 完全缺失。
Verification Consumer 因而把真实事件记录为 `LegacyExecutionSettled` 并推进
offset。这是既有冻结合同下的实现缺陷，不是新 Design Gap。

### 2.2 必须治理的既有缺口

| Gap | 阻塞点 | 当前 Work 影响 |
|---|---|---|
| G-V2-2 | ToolObservation 的 canonical source identity 未冻结 | 阻塞正式工具证据绑定 |
| G-V2-3 | summary content→summaryRef 已有候选，但 Verification 不持久关联该 ref | 阻塞 ConcludeVerification |
| G-V2-4 | initialWork 的 VerificationMission 来源/lifecycle 未冻结 | 不阻塞当前显式 mission；阻塞通用 child initialWork 能力 |

不得用字符串、Session 文本或 Runtime 猜测填补这些字段。

## 3. 双轨执行策略

```text
Track A — IMPLEMENTATION READY
A1 Event fidelity
A2 Historical reconciliation
A3 StartVerification + spawn qualification
              ↓
        GATE: Verification Open

Track B — GOVERNANCE REQUIRED
B1 G-V2-2 evidence identity
B2 G-V2-3 summary durable binding
B3 G-V2-4 initial mission lifecycle
              ↓ accepted owning contracts
B4 Verifier evidence/conclusion implementation
B5 Parent Acceptance + CompleteWork
```

Track A 可以立即实施。Track B 在治理接受前只允许测试草图与设计审阅，不允许
生产语义落码。

## 4. Task DAG

### VDC-001 — CompletionClaim event fidelity

**Owner:** `SettleExecution`

TDD：

1. Work-bound `Completed(CompletionClaimed)` 必须产生顶层
   `executionId/workId/workRevision/claimRef/settlement`。
2. Coordination/Query/Yielded/Interrupted 不得伪造 Work 字段。
3. event payload 与完整 persisted settlement 同事务提交。
4. replay 保持相同 event/receipt，不产生第二事件。

实现来源：

```text
workId       <- Execution.binding.focus.Work.workId
workRevision <- CompletionClaimed.workRevision
claimRef     <- CompletionClaimed.claimRef
```

### VDC-002 — Historical CompletionClaim reconciliation

不能重置 consumer offset，也不能手写 Verification 行。

增加确定性 reconciliation：

1. 扫描 `ExecutionSettled` 中 nested `CompletionClaimed`；
2. 从 durable Execution binding 补取 `workId`；
3. 构造与 VDC-001 相同的 canonical trigger；
4. 调用同一个 Verification Consumer/StartVerification gateway path；
5. deterministic ids 继续由 `(workId, workRevision, claimRef)` 生成；
6. 已存在 Verification、已终结 Work、revision 漂移均记录 skip；
7. reconciliation checkpoint 独立持久化，restart 可重入。

当前 Work 应选择最早的有效 revision-1 claim 作为 deterministic replay
输入；one-Open index 和 deterministic identity 吸收其余重复 claim。

### VDC-003 — Verification start/spawn qualification

机械证明：

- 创建恰好一个 Open Verification；
- missionSnapshot 等于 Work revision 1 的显式 mission；
- ownerWorkspaceId 为当前 owning Workspace snapshot；
- targetWorkRevision = 1；
- verifierExecutionId caller-preallocated；
- consumer crash at commit→spawn window 后，原 ID 被重新派发而不创建第二
  Verification；
- WorkWait 保持到 `VerificationChanged`，生产 Work Agent 不再被调度。

到这里停止自动推进。如果 B1/B2 未治理，不允许 Verifier 伪造 evidence identity
或 conclusion summaryRef。

### VDC-004 — G-V2-2 implementation（治理后）

按接受合同实现：

- Runtime 从 bound Tool invocation/result 生成 exact evidence source；
- verifier 模型只能选择证据语义，不能编造 invocation/result identity；
- Evidence row 保存足以回查原 ToolInvocation、ToolResult observation 和
  Verifier Execution 的绑定；
- stale/missing/foreign-execution source fail closed。

### VDC-005 — G-V2-3 implementation（治理后）

- verifier/Parent 提供 summary UTF-8 content；
- Runtime `BlobStorePort.put` 得到 content-addressed summaryRef；
- Blob resolve 校验成功后才提交 `ConcludeVerification`；
- Verification conclusion transaction 持久化 summaryRef；
- `VerificationConcluded` 携带 summaryRef；
- blob-only crash 允许孤儿 blob，但不允许无 summaryRef 的已提交结论。

### VDC-006 — Verifier Program / evidence / conclusion

当前 dogfood mission 的 Verifier 必须：

1. 读取隔离 Worktree 的唯一 diff；
2. 运行 focused test；
3. 运行 `git diff --check`；
4. 运行 architecture suite 或消费 producer 已产生的可验证记录；
5. 对三个 required criteria 分别记录 evidence；
6. 执行一次 mutation check 或引用 producer 的 mutation evidence 时证明来源；
7. deterministic aggregate 得出 Pass/Fail/Unknown；
8. 使用 summary content→BlobRef→durable Verification link 结论链。

### VDC-007 — Parent Acceptance and mechanical completion

若且仅若 Verification=Pass：

```text
AcceptWorkOutcome(workId, targetWorkRevision=1, verificationId)
→ WorkOutcomeAccepted
→ Completion Consumer
→ CompleteWork
→ seven-fold revalidation
→ Work.lifecycle = Completed
```

Fail/Unknown 不得自动接受。Revision 漂移后旧 Pass/Acceptance 不得完成新版本。

## 5. Test matrix

| ID | Scenario | Expected |
|---|---|---|
| V1 | exact CompletionClaim event | top-level four-field trigger present |
| V2 | non-Work settlement | no fake work fields |
| V3 | old nested claim backfill | one Verification created |
| V4 | five duplicate claims | one Open Verification |
| V5 | consumer crash after StartVerification commit | same verifierExecutionId re-spawned |
| V6 | Work revision changed | old claim skipped RevisionConflict |
| V7 | invalid mission | typed InvalidVerificationMission |
| V8 | tool evidence from foreign Execution | denied |
| V9 | summary blob write fails | no conclusion command |
| V10 | conclusion commit fails after blob write | orphan blob allowed; Verification Open |
| V11 | required criterion Fail | overall Fail; no acceptance |
| V12 | required criterion unresolved | Unknown; no acceptance |
| V13 | Pass + wrong verificationId acceptance | mismatch |
| V14 | exact Pass + exact Acceptance | Work Completed |
| V15 | restart at every boundary | no duplicate Verification/Acceptance/CompleteWork |

## 6. Exit criteria

1. Current dogfood Work owns exactly one Verification at revision 1.
2. Verification has an exact bound Verifier Execution.
3. Every required criterion owns resolvable durable evidence.
4. Concluded Verification owns durable summaryRef.
5. Parent Acceptance binds the exact Verification/revision.
6. Work becomes Completed only through `CompleteWork` revalidation.
7. WorkWait is cleared by VerificationChanged; no duplicate producer execution.
8. consumer offsets advance without dead letter.
9. restart/crash matrix passes.
10. `pnpm check` green and live evidence recorded.

## 7. Planned output files

```text
planning/tasks/verification-delivery-convergence.md
planning/results/verification-delivery-convergence.result.md
planning/proposals/verification-delivery-governance-decision-draft.md
```

No `docs/design/**` update and no Track-B production implementation occurs
until the governance decision is explicitly accepted.
