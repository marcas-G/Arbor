# P8 — 01 Verification / Acceptance Commands (PROPOSAL)

**Authority:** DID v1.10 §3.5/§3.6/§4.2/§5.3/§12.10/§12.11 (Work + Verification truth tables), §12.8 C7; SD v1.3 §9.1/§9.6/§9.7; 不变量 22/23/49; P0 domain（verification.ts/work.ts/dependency.ts Acceptance 冻结实现）。
**Status:** DESIGN CLOSURE DRAFT。

## 1. `StartVerification`

### Payload

```ts
{
  readonly verificationId: VerificationId;        // caller-preallocated
  readonly workId: WorkId;
  readonly observedWorkRevision: WorkRevision;    // optimistic: bind at start
  readonly missionSnapshot: VerificationMission;  // 从 work.verificationMission 快照 + 来源叠加（SD §9.4）
  readonly targetDeliverables?: ReadonlyArray<DeliverableId>;  // P7 不可变交付物（可选）
}
```

Handler 内解析：`targetArtifactVersions`（从 targetDeliverables 的 artifacts 派生）、`targetEnvironmentRevision?`（mission 含可执行验证时必填——`04` §3）、`verificationExecutionIds`（spawn 后回填）。

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| work 不存在 | `CommandRejection.WorkNotFound` |
| work lifecycle != Open | `DomainError.TerminalLifecycleMutation`(Work) |
| observedWorkRevision 不匹配 | `DomainError.RevisionConflict` |
| mission 无效（GQ2 后：goal 空/criteria 结构非法） | `CommandRejection.InvalidVerificationMission`（**P8 冻结新增枚举**——不用 AuthorityDenied 承载结构错误） |
| authority fact 不符（consumer System 或 Parent 治理链） | `DomainError.AuthorityDenied` |

- 并发：无 Open 上限（GQ6）；重验证=新 verificationId（DID §12.11 冻结）。
- Events: `VerificationStarted { verificationId, workId, targetWorkRevision, missionDigest }`。

## 2. `RecordVerificationEvidence`（verifier-only）

- Payload: `{ verificationId, evidence: EvidenceRecord }`（结构见 `04`）。
- Preconditions: verification state == Open；**authority = `VerifierExecutionAuthority { verificationId, executionId }`**（exact-bound：仅该 Verification 的某个 Verifier Execution；B-1）；evidence append-only（同 evidenceId 幂等）。
- Events: 无（evidence 是 runtime record，DID §3.7/§5.3 无 evidence 事件——如实不加）。

## 3. `ConcludeVerification`（verifier-only）

- Payload: `{ verificationId, verdict: "Pass" | "Fail" | "Unknown", criteriaResults, summaryRef }`（criteriaResults 结构 GQ2）。
- Preconditions: Open；verifier authority；mission/evidence record valid——criterion 级结果齐全且每条绑 evidenceRef（SD §9.6/不变量 26）；整体 verdict 必须等于确定性聚合结果（required: 任一 FAIL→FAIL；无 FAIL 有 UNKNOWN→UNKNOWN；全 PASS→PASS——域纯函数，L1）。
- 域转移：concludeVerification（P0 冻结）；verdict 此后 immutable。
- Events: `VerificationConcluded { verificationId, workId, targetWorkRevision, verdict, evidenceRefs }`；同事务产 wake（`03` §3）。

## 4. `AcceptWorkOutcome`

- Payload: `{ acceptanceId, workId, targetWorkRevision, verificationId, actor }`。
- Preconditions: work Open；verification 结论为 **Pass** 且 (workId, targetWorkRevision, verificationId) 三元绑定精确匹配当前 revision（DID §3.6 冻结式）；authority = Parent Workspace 治理链（`AcceptanceAuthority`：parent Workspace agent/human；Root 内 milestone=User 显式 human——SD §9.7 落法，B-3）。
- 不变式：PASS ≠ 不足（Parent 判不足→不提交+AssignWork 补充 Work——契约注记：DID §4.2 无 Reject 命令且 SD §9.7 已完全决定该表达，非缺口）。
- **幂等（round-1 补）**：acceptanceId + (workId, targetWorkRevision) 双唯一——同 acceptanceId 重放返回既有 Receipt；同 (workId, revision) 不同 acceptanceId → typed rejection（每 revision 至多一条 Acceptance 记录；重 Acceptance 在 refine 后新 revision 上自然允许）。
- Events: `WorkOutcomeAccepted { acceptanceId, workId, targetWorkRevision, verificationId, actor }`。

## 5. `CompleteWork`

- Payload: `{ workId, expectedWorkRevision }`。
- Preconditions（DID §3.6:1201-1211 七连式逐条，L2 强制）：work Open；current-revision **Pass** Verification；current-revision Acceptance 且 acceptance.verificationId 匹配；expectedWorkRevision 匹配。
- 提交者：GQ4 裁决——推荐 WorkOutcomeAccepted→deterministic consumer（`03` §2）；authority `CompleteWorkAuthority`（System origin, causationRef=事件）。
- 域效果：completeWork（P0 冻结，含 VerificationAcceptanceMismatch）→ `WorkCompleted`；若为 currentWork → 原子清 workspace.currentWorkId（DID §12.11 Work 表行）。

## 6. Authority facts 清单（P8 契约冻结形态）

```text
StartVerificationAuthority  { targetWorkspaceId, workId }
VerifierExecutionAuthority { verificationId, executionId }   // exact-bound, verifier-only 两命令
AcceptanceAuthority         { targetWorkspaceId, workId, verificationId }  // Parent 治理链 / milestone human
CompleteWorkAuthority       { targetWorkspaceId, workId }    // consumer System 或显式
```

## 7. Must Not Decide

- No verdict/聚合规则/状态机修改（SD §9.6 + DID §12.11 + P0 实现）。
- No revision 绑定语义修改（DID §12.8 C7）。
- No "PASS 重新判 FAIL"（SD §9.7 禁令）。
- No P7 satisfaction/质量正交破坏（v1.10 G2）。
- No evidence domain event、No new WakeCondition/WakeReason。
- No Environment change 生产（P11）；No Attention 呈现（P10）。
