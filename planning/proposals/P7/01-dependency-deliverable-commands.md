# P7 — 01 Dependency / Deliverable Commands (PROPOSAL)

**Authority:** DID v1.9 §1.8, §4.2, §5.3, §12.10, §12.11, §2.3, §3.6, §9.3; SD v1.3 §3.7/§3.8; P0 domain 冻结（dependency.ts 已实现）。
**Status:** DESIGN CLOSURE DRAFT（GQ1 待裁决后方可在契约层定稿 Withdraw/Mark/Revise 三命令）。

## 1. 语义总纲

```text
Message     = communication（P6，认知通道）
Deliverable = formal result（P7，绑定 source Work revision 的正式结果）
Dependency  = unmet result requirement（P7，canonical consumer 是 Work）
```

- 全部 ADT/转移/matcher 复用 P0 冻结实现（packages/domain/src/dependency.ts），P7 不改 domain 语义，只做事件载荷、命令 handler、repository、DDL、authority fact。
- matcher 算法、revision 绑定（satisfiedAtDependencyRevision immutable、旧 revision Deliverable 不满足新 revision requirement）、producer-loss 规则——全部照 DID §1.8/§12.11 执行，P7 无自由度。

## 2. `DeclareDependency`

### Payload

```ts
{
  readonly dependencyId: DependencyId;            // caller-preallocated
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;      // AnyProducer | WorkspaceBound | WorkBound
  readonly expectedDeliverable: ExpectedDeliverable; // kind + requiredArtifactRoles
  readonly expectedConsumerWorkRevision: WorkRevision; // optimistic precondition
  readonly provenance: Provenance;
  readonly revision: DependencyRevision;          // 初始 0
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| consumer Work 不存在 | `CommandRejection.WorkNotFound` |
| consumer Work lifecycle != Open | `DomainError.TerminalLifecycleMutation`(Work) |
| consumer Work revision 不匹配 | `DomainError.RevisionConflict` |
| 声明者 authority ≠ consumer Work 所在 Workspace 的 agent（或其 human 治理者） | `DomainError.AuthorityDenied` |
| WorkspaceBound/WorkBound 目标不存在或跨 Project | `DomainError.AuthorityDenied` |
| Retired Workspace 持有 consumer Work | `DomainError.TerminalLifecycleMutation`(Workspace) |

### Events: `DependencyDeclared { dependencyId, consumerWorkId, producerBinding, expectedDeliverable, revision }`

- authority fact（提案）：`DeclareDependencyAuthority { targetWorkspaceId, consumerWorkId }`——沿 P6 `SendMessageAuthority` 形态。

## 3. `ProduceDeliverable`

### Payload

```ts
{
  readonly deliverableId: DeliverableId;          // caller-preallocated
  readonly sourceWorkId: WorkId;
  readonly observedSourceWorkRevision: WorkRevision; // 乐观绑定：产出时点 source Work revision
  readonly kind: DeliverableKind;
  readonly artifacts: ReadonlyArray<{ role: ArtifactRole; artifactId: ArtifactId }>;
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| source Work 不存在 | `CommandRejection.WorkNotFound` |
| source lifecycle terminal (Cancelled) | `DomainError.TerminalLifecycleMutation`(Work) |
| observed revision 不匹配 | `DomainError.RevisionConflict` |
| 声明者 authority ≠ source Work 所在 Workspace agent | `DomainError.AuthorityDenied` |
| requiredArtifactRoles 中 role 无对应 artifact（对 Declare 侧不适用；对自动 satisfy 由 matcher 处理） | — |

**GQ5 关联（默认是，待确认）**：不要求 source Work 已 CompletionClaimed/Verified——Deliverable 是"正式结果"而非"已验证结果"；质量门归 P8（SD:322）。Work 可以多次 produce（不同 deliverableId / 不同 revision 绑定）；同 deliverableId 幂等。

### Events: `DeliverableProduced { deliverableId, sourceWorkId, sourceWorkRevision, kind, artifactRoles }`

## 4. `SatisfyDependency`

### Payload

```ts
{
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision; // 冻结：绑定当前 revision
  readonly deliverableId: DeliverableId;
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| dependency 不存在 | `CommandRejection.DependencyNotFound`（**P7 冻结新增枚举**） |
| dependency state != Unsatisfied | `DomainError.TerminalLifecycleMutation`(Dependency) |
| revision 不匹配 | `DomainError.RevisionConflict` |
| `matchesExpectedDeliverable(binding, expected, view) === false` | `DomainError.DependencyNotSatisfiable`（状态不变，DID:820） |
| deliverable 不存在 | `CommandRejection.DeliverableNotFound`（**P7 冻结新增枚举**） |

- 提交通道二选一：显式（authority 归属 **待 GQ7 裁决**——提案：consumer Work 所在 Workspace 治理链，与 Declare 对称）或 Coordination Consumer 自动（Event→Command deterministic CommandId = `f(deliverableId, dependencyId, revision)`，DID §5.4；System 语义同 P6 formation-consumer 先例）。
- 并发（冻结）：两 deliverable 竞争同一 dependency → 首提交者赢（state/revision CAS），败者收 `DependencyNotSatisfiable`/`TerminalLifecycleMutation` typed rejection；自动路径重投由 deterministic CommandId 幂等吸收。
- 同一提交边界内发 wake（见 `04`）。

### Events: `DependencySatisfied { dependencyId, targetDependencyRevision, deliverableId, satisfiedAtDependencyRevision }`

## 5. GQ1 提案：Withdraw / MarkUnfulfillable / Revise（DID §4.2/§12.10 待补行）

| 提案命令 | Payload 要点 | Preconditions | Events |
|---|---|---|---|
| `WithdrawDependency` | { dependencyId, targetDependencyRevision, reason } | Unsatisfied + revision + **consumer Work 所在 Workspace 治理权**（consumer 不再需要） | `DependencyWithdrawn` |
| `MarkDependencyUnfulfillable` | { dependencyId, targetDependencyRevision, justification } | Unsatisfied + revision + authority（Parent/human 裁决"当前合同无法满足"，S3 步骤12）+ 产生 Attention | `DependencyMarkedUnfulfillable` |
| `ReviseDependencyContract` | { dependencyId, targetDependencyRevision, newProducerBinding?, newExpectedDeliverable? } | Unsatisfied + revision + consumer 侧 authority；revision++；不重解释旧 satisfaction（DID:824） | `DependencyContractRevised`（**P7 冻结新增事件**，或并入 `DependencyDeclared` 语义——采纳时定） |

- producer-loss 批量后果（Work cancelled → withdraw；WorkBound loss → Unfulfillable 等）由对应治理命令事务内调用 domain 批量函数（已实现），事件逐条发出。

## 6. Repository / DDL（P7 契约层形状，DDL 细节归任务）

- `DependencyRepository` / `DeliverableRepository`（DID:2060-2061 已列举）：表 `dependencies`（state/revision CAS 同 FormationProposalStore 先例）、`deliverables`（immutable，无 update）、`deliverable_artifacts`。
- migration id 6（`p7_dependency_coordination`）。

## 7. Must Not Decide

- No matcher/算法/状态机修改（DID §1.8/§12.11 冻结，P0 已实现）。
- No Verification/Acceptance/CompleteWork 语义（P8）。
- No Message/Inbox 语义修改（P6）。
- No scheduler 决策表修改（P2 §8.18A）。
- No metadata query / regex / semantic matcher（DID:822 禁令）。
- No `Deliver` 独立命令（GQ2 裁决前；推荐组合方案 b 见 `05`）。
