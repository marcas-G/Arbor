# P8 — 01 Verification / Acceptance Commands

**Authority:** DID v1.10 §3.5/§3.6/§4.2/§5.3/§12.10/§12.11 (Work + Verification truth tables), §12.8 C7; SD v1.3 §9.1/§9.6/§9.7; 不变量 22/23/49; P0 domain（verification.ts/work.ts/dependency.ts Acceptance 冻结实现）。
**Status:** FROZEN — DID v1.27 VDC + Verifier Execution Settlement addenda.

FT-DG-03: registered strict codecs and typed internal semantic validators
derive their closed field/ID/union rules from the exact command payloads in
this document and EvidenceRecord/Mission contracts in `04`. This does not
change P8 verdict, authority, Acceptance, or consumer semantics (DID §4.1B).

## DID v1.27 addendum — conclusion action settlement

The model-facing `arbor_conclude_verification` action executes the following
ordered boundary:

```text
summary bytes → BlobStore.put → byte-for-byte get verification
→ ConcludeVerification through CommandGateway
→ committed Receipt
→ idempotent Verification wake delivery
→ Completed(VerificationConcluded { verificationId, verdict })
```

A rejection or operational failure at any step before the final boundary must
not produce the Completed result. Blob-before-command may leave an orphan Blob.
Command/wake/settlement crash windows replay the same deterministic command and
idempotent wake. The Completed result is an Execution fact only: it is neither
Parent Acceptance nor Work completion.

## VDC addendum — evidence identity and conclusion summary

`RecordVerificationEvidence(kind="ToolObservation")` carries Runtime-bound
source identity `{ toolInvocationId, observationRef, executionId, callRef }`.
The verifier model may choose and explain an observation but cannot author those
identity fields. The record is rejected unless the invocation/result pair is
terminal, sourced and visible to the exact Verifier Execution.

For a normal `ConcludeVerification`, the model-facing semantic input contains
summary content, not `summaryRef`. Runtime writes the exact UTF-8 bytes to
BlobStore, verifies the returned content-addressed ref and submits the existing
command with that `summaryRef`. The Verification conclusion row and
`VerificationConcluded` event retain `summaryRef` durably. Parent governance
supplies summary content only for `Unknown(Orphaned)`.

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
| mission 无效（v1.11 G1 结构化后：goal 空/criterionId 缺失/无 required criterion） | `CommandRejection.InvalidVerificationMission`（**P8 冻结新增枚举**——不用 AuthorityDenied 承载结构错误） |
| authority fact 不符（consumer System 或 Parent 治理链） | `DomainError.AuthorityDenied` |
| **同 (workId, targetWorkRevision) 已有 Open Verification**（v1.11 G2；孤儿先按 Unknown(Orphaned) 结论再 re-Start——G5） | `CommandRejection.VerificationAlreadyOpen { workId }`（**P8 冻结新增枚举**——不复用 ActiveExecutionConflict，避免 P0 载荷演进） |

- 并发（v1.11 G2）：**同一 (workId, targetWorkRevision) 至多一个 Open Verification**；concluded 历史不受限；重验证=新 verificationId（DID §12.11 冻结）。
- Events: `VerificationStarted { verificationId, workId, targetWorkRevision, missionDigest }`。

## 2. `RecordVerificationEvidence`（verifier-only）

- Payload: `{ verificationId, evidence: EvidenceRecord }`（结构见 `04`）。
- Preconditions: verification state == Open；**authority = `VerifierExecutionAuthority { verificationId, executionId }`**（exact-bound：仅该 Verification 的某个 Verifier Execution；B-1）；evidence append-only（同 evidenceId 幂等）。
- Events: 无（evidence 是 runtime record，DID §3.7/§5.3 无 evidence 事件——如实不加）。

## 3. `ConcludeVerification`（verifier-only）

- Payload: `{ verificationId, verdict: "Pass" | "Fail" | "Unknown", criteriaResults, summaryRef, conclusionReason?: "Orphaned" }`（criteriaResults 结构 v1.11 G1；`Orphaned` 仅随 Unknown，G5 孤儿结论路径——见下）。
- Preconditions: Open；verifier authority；mission/evidence record valid——criterion 级结果齐全且每条绑 evidenceRef（SD §9.6/不变量 26）；整体 verdict 必须等于确定性聚合（v1.11 G1：任一 **required** Fail→Fail；无 required Fail 但有 required 未决→Unknown；全 required Pass→Pass；optional 不阻塞——域纯函数 L1）。
- **Orphaned 路径（G5）**：`conclusionReason: "Orphaned"` 时豁免 evidence 齐全前置（孤儿定义上无活 Verifier）；提交者为 Parent Workspace 治理链 authority（显式治理动作，非 verifier-only）——用途仅限为 re-Start 清障，事件载荷携带 conclusionReason。
- 域转移：concludeVerification（P0 冻结）；verdict 此后 immutable。
- Events: `VerificationConcluded { verificationId, workId, targetWorkRevision, verdict, evidenceRefs, summaryRef }`；同事务产 wake（`03` §3）。模型控制动作在 committed Receipt 与 wake 交付后产生 `Completed(VerificationConcluded { verificationId, verdict })`；该 Execution result 不进入 CompletionClaim consumer。

## 3A. `RetryVerification`（authenticated human orphan governance）

`RetryVerification` is the sole explicit governance surface for the frozen P8
G8 orphan path. It is available only to authenticated local-human governance
for Root-owned Work or authenticated human governance of the exact direct
Parent Workspace for child Work. It is never Agent-originated, grantable,
scheduler-driven, or an Attention write.

Payload:

```ts
{
  readonly workId: WorkId;
  readonly verificationId: VerificationId;
  readonly expectedWorkRevision: WorkRevision;
  readonly summaryContent: string;
  readonly successorVerificationId: VerificationId; // Runtime-preallocated
  readonly verifierExecutionId: ExecutionId;         // Runtime-preallocated
}
```

The external envelope supplies the authenticated actor and stable CommandId;
the client supplies neither authority nor a BlobRef. Runtime stores and
byte-verifies `summaryContent` and binds the content-addressed ref to this
command. The exact `OrphanConclusionAuthority` binds Project, actor, current
governing owner, Work, open Verification, expected Work revision, and the
complete set of exact bound Verifier ExecutionIds.

In one canonical command transaction the handler revalidates that the Work is
Open at `expectedWorkRevision`, the exact Verification is Open for that Work
and revision, and the non-empty set of its exact bound Verifier Executions is
fully settled. Old execution ownership is checked against the Verification's
captured owner snapshot; human authority is resolved against the Work's
current governing owner. It atomically writes the old immutable
`Unknown(Orphaned)` conclusion/event, one successor Verification with the
existing frozen mission and current owner snapshot, durable verifier-spawn
intent, immutable retry-origin fact, and the Command receipt. A failure commits
none of these facts. Exact CommandId replay returns the same successor IDs and
receipt only after the current P12 visibility and human-authorization check
still succeeds for the same original actor and source Work/Verification. A
revoked authorization, changed governing owner that no longer authorizes the
original actor, different actor/project/source, or foreign target is denied by
the Resolver before Gateway reads any receipt. No evidence or PASS is
fabricated.

### Permanent exact replay origin (DID v1.46)

`retry_verification_origins` is the permanent canonical non-receipt fact that
binds the originating CommandId to its project, original actor, source
Verification/Work, successor Verification/verifier Execution, and creation
time. The physical fields, uniqueness/FK/immutability rules, retention and
migration placeholder are owned by P1 `04`; the row lives at least as long as
its permanent Command receipt and is independent of Domain Event pruning. It
does not store summary content, expected revision, payload, fingerprint,
Handler schema version, fingerprint algorithm version, or receipt JSON.

For a historical Concluded source, P12 resolves the candidate CommandId only
through that origin fact and rechecks the original actor, project, source
Work/Verification scope, and current human governance authority. The replay-
only authority is not accepted by the `RetryVerification` handler. Resolver
does not compare summary, expected revision, or successor IDs: with the same
CommandId and source scope, a changed value reaches Gateway's full tuple
comparison and returns the existing non-disclosing
`TerminalRejected(IdempotencyConflict)` receipt. A different source/project/
actor is rejected before Gateway. If the origin exists but its receipt is
absent, Gateway returns the fixed safe
`PersistenceCorruption<"CommandStore">` disposition without invoking the
handler or writing an attempt, receipt, Event, Verification, Execution, or
spawn intent.

Legacy successful P8 receipts acquire an origin only when the retained
`VerificationConcluded(Unknown, Orphaned)` and `VerificationStarted` event pair
plus the canonical successor Verification's persisted preallocated verifier
Execution ID prove the same CommandId, project, actor, source, and successor
identities. If a physical verifier Execution/binding has been admitted, it
must agree. Missing/pruned/duplicate/malformed/conflicting evidence is never
guessed from receipt JSON, Session text, or pruned Events. The migration
preserves the old receipt, records `UnboundLegacy`, and admits the human-only
P6 Governance Inbox item described in P6 `02`; an UnboundLegacy external replay
is a generic Resolver denial.

#### Accepted P6 current-route mechanics (DID v1.47)

The accepted P6 item uses the existing `Governance` kind and stable
`retry-verification-unbound:<commandId>` key, with typed
`RetryVerificationUnboundLegacy` content derived from the immutable
disposition. Its recipient is recomputed from current canonical Work/Workspace
governance facts and current P8 human authorization; the Inbox row is not
authority. Root Work follows current Root-local human governance, and child
Work follows its current exact direct Parent Workspace human route. The item is
human-only, queryable only under that current route, and read-only/no-consume;
it is not promoted to Agent Session or P10 Attention. Route moves and failure
to move atomically follow P6 `02` / P1 `03`; these mechanics do not relax this
P8 section's current-authorization-before-Gateway rule.
This migration disposition is not a P10 Attention source and does not add a
new command or automatic retry loop.

After commit, the existing P8 VerificationRuntime performs admission and
binding backfill with the same preallocated successor IDs. Restart/replay
retries only that spawn. If the successor later orphans, it remains Open with
derived Attention until a separate authenticated human invocation; no loop or
automatic retry is permitted. P10 may remain stale until its existing
freshness barrier catches up; only then may the UI report the old orphan row
absent, while the old `Unknown(Orphaned)` conclusion remains visible.

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
OrphanConclusionAuthority   { projectId, workId, verificationId, expectedWorkRevision,
                              exactSettledVerifierExecutionIds, currentOwnerId,
                              authenticatedHumanPrincipal } // Root local human or exact Parent Workspace human
```

## 7. Must Not Decide

- No verdict/聚合规则/状态机修改（SD §9.6 + DID §12.11 + P0 实现）。
- No revision 绑定语义修改（DID §12.8 C7）。
- No "PASS 重新判 FAIL"（SD §9.7 禁令）。
- No P7 satisfaction/质量正交破坏（v1.10 G2）。
- No evidence domain event、No new WakeCondition/WakeReason。
- No Environment change 生产（P11）；No Attention 呈现（P10）。
