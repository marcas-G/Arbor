# Arbor Detailed Implementation Design

**Version:** 1.5  
**Status:** TOP-LEVEL ARCHITECTURE FROZEN — governance patch (P0 + P1-RELEVANT CLOSURE)  
**Supersedes:** v1.4  
**Date:** 2026-09-20  
**Depends on:** `Arbor System Design Specification v1.3`  
**Owns:** 可编码 ADT/API 语义、Effect A/E/R、Command/Event、Failure、Invariant enforcement、Ports、transaction/fencing、Model Context、Persistence、Package DAG、phase-scoped closure 与技术基线  
**Does not own:** P1–P8/G1–G8、S1–S4 行为正文、顶层领域/Runtime 语义；若实现发现这些语义需要改变，必须回到上游文档修订  
**Scope:** 将已冻结的系统级设计落实为可实现且可测试的契约。v1.4 是 governance patch：闭合 P0 planning 审阅发现的 DG-01…DG-06，不改变 C1–C10 / X1–X11 的语义结论；v1.5 闭合 P1 pre-implementation 审阅发现的 P1-DG-01…05 与 P1-DG-10，P1+ 的 exact DDL、逐 Command payload/signature、Prompt 正文与经验参数仍按 phase-scoped closure 管理。

**Governance changes (v1.3 → v1.4):**

- DG-01: `Dependency` producer expressed as `ProducerBinding` ADT; an undefined producer-binding term was removed.
- DG-02: `ExpectedDeliverable` + deterministic matcher frozen; `Deliverable` gains `kind` and role-tagged artifacts.
- DG-03: explicit `projectPolicyRevision` / `workspacePolicyRevision` distinct from aggregate `revision`.
- DG-04: `PermissionGrantId` prefix `pgr_` added to Appendix A.
- DG-05: `AgentBinding` split into `ResponsibilityBoundAgentBinding` / `ExecutionBoundAgentBinding`; Workspace constrained.
- DG-06: canonical architecture-test location `tests/architecture/**`.

**Governance changes (v1.4 → v1.5):**

- P1-DG-01: parameterized `CommandResolution<Result, Rejection>`; Application-owned `CommandRejection = DomainError | FencingRejected | ExecutionStopping` (§6A.15).
- P1-DG-02: single-transaction command resolution; `commands.resolution = Committed | TerminalRejected` only; `CommandAttempt` is a non-authoritative operational trace (§9.9).
- P1-DG-03: idempotency identity unified on `semantic_request_fingerprint` + `schema_version` + `fingerprint_algorithm_version`; concrete algorithm is a P1 phase contract (§4.1, §9.9).
- P1-DG-04: authoritative fence validation separated from stop/quiescence admission; `FencingRejected` is only for invalid ownership/fence; stop admission returns Application `ExecutionStopping` (§9.7, §11).
- P1-DG-05: `CreateProject` single-transaction bootstrap contract; no Session Domain Event (§4.1, §12.11).
- P1-DG-10: `TransactionPort` / `CommandStore` / `DomainEventJournal` classified as Persistence ports (Appendix B aligned to §7.2).

`Problem & Goals` and `Scenarios` are unchanged.

---

## 0. 文档定位与冻结规则

Arbor 的系统级语义由 `Arbor System Design Specification v1.3` 拥有。本文不重新讨论问题定义、G1–G8、S1–S4，也不在实现层静默修改顶层领域语义；本文只回答如何把这些系统约束落实为可编码、可持久、可并发验证和可恢复的实现契约：

1. 哪些对象是长期 Identity，哪些只是 Value Object / Runtime Record / Projection；
2. 哪些状态必须成为 Canonical Truth，哪些只能是认知状态或 UI 投影；
3. 哪些 mutation 通过 Domain Command，哪些属于 Runtime Operational State；
4. 哪些 Invariant 由纯函数、Command Handler、数据库事务、Runtime、Sandbox 或 Projection 强制；
5. Agent 的 Prompt / Instruction / Context / Tool / Skill 如何被工程化，而不是散落在代码和字符串中；
6. SQLite、Repository、Event Journal、Lease/Fencing 与 Recovery 如何闭环；
7. TypeScript / Effect monorepo 如何通过依赖方向强制架构，而不是只靠文档约定；
8. 开发阶段如何从纯 Domain Kernel 逐步形成长期、多 Workspace、可验证、可恢复的 Agent 系统。

### 0.0.1 文档解耦规则

```text
Problem & Goals
→ owns WHY / WHAT

Scenarios
→ owns observable workflow

System Design
→ owns domain/runtime/invariant semantics

Detailed Implementation Design
→ owns executable contracts and mechanism
```

DID 可以把系统概念细化为 Value Object、Runtime Record、Port、schema、package 或 transaction protocol，但不得仅因实现便利创造新的顶层业务真相。若某个实现约束证明系统语义不可实现，应以失败测试、并发/恢复反例或接口断点为证据回到 System Design 修订。

### 0.1 冻结规则与 Closure 规则

从 v1.1 起遵循以下规则：

- 不再因为实现便利随意增加顶层 Domain Entity；
- 新概念首先判断属于 Domain、Runtime、Projection、Model Context 还是 Adapter；
- 硬 Invariant 不得仅由 Prompt 或 LLM 自觉保证；
- Canonical mutation 必须进入正式 Application / Runtime mutation path；
- Prompt / Model Context 的变化视为行为代码变化，需要版本、Provenance 与回归测试；
- 实现阶段若发现设计不成立，必须以失败测试、并发冲突、恢复失败或接口断点为依据修改，而不是因为“代码写起来麻烦”就改变边界；
- **顶层架构冻结，Pre-implementation Closure 继续开放**：凡是现在可以通过推理确定、且会显著影响接口/状态/一致性的二级问题，应在编码前继续闭合；只有需要真实模型评测、性能测量或运行证据的问题才允许显式延后。

### 0.2 三层真相模型

Arbor 最终采用三层信息结构：

```text
Canonical Truth
    Project / Workspace / Work / Responsibility
    Permission / Dependency / Deliverable / Verification
                ↓
Cognitive State
    Session / Checkpoint / Recent Frontier / Mode
    Active Skills / Working Plan / OutcomeGap
                ↓
Model-visible Projection
    Instructions / Context Fragments / Tools / Skills
    Output Contract / Continuation
```

其中：

- **Canonical Truth** 只能通过正式 mutation path 改变；
- **Cognitive State** 可以错误、压缩、重建和被新证据纠正；
- **Model-visible Projection** 是某一 Provider Turn 对前两层的有限投影，不具有反向修改 Canonical Truth 的权力。

### 0.3 Pre-implementation Closure 判定规则

实现前的未决问题按两问处理：

```text
Q1. Can this uncertainty be removed by reasoning now?
Q2. Will the choice materially constrain later interfaces/state/consistency?
```

若两者均为 Yes，则必须在编码前闭合；若必须依赖真实实现、模型行为或性能数据，则只冻结：

```text
mechanism
configuration boundary
measurement method
replacement boundary
```

而不伪造“最佳参数”。因此 v1.1 的 `FROZEN` 只表示：Domain/Runtime/Model Context/Persistence/Package 的顶层边界不再随意推翻；状态转移真值表、精确 Command/Port contract、Prompt 正文和性能默认值仍可在 Closure 阶段继续收敛。

### 0.4 Effect 是架构承载体，不只是异步工具

Arbor 的 TypeScript 实现以 Effect 的三参数模型作为 Application/Runtime contract 的直接表达：

```text
Effect<A, E, R>

A = successful result
E = expected typed failures the caller may handle
R = exact capabilities/services required to run the computation
```

因此：

```text
Domain/Application result semantics → A
Error Algebra                     → E
Ports / dependency requirements  → R
Adapters / construction graph     → Layer
```

Effect 的 Error channel 与 Requirement channel 都属于 Arbor 的正式架构，不允许退化为 `Effect<A, Error, AppEnv>`。

---

# DID-0 — Effect Execution Contract & Dependency Model

## 0A.1 统一函数契约

Arbor 的 effectful API 统一采用：

```text
Effect<A, E, R>
```

其中：

- `A` 只表达该操作成功完成时的结果；
- `E` 只表达调用方可以合理预期和处理的 typed failure；
- `R` 只表达该 computation 真正需要的 capability/service；
- defect / invariant violation 不塞入 `E`；
- interruption / cancellation 不伪装成普通 `CancelledError`；
- 正常业务替代结果优先使用 `A` 中的 ADT，而不是滥用 Error channel。

示例语义：

```text
AssignWork
→ Effect<
    AssignWorkReceipt,
    WorkspaceNotFound
      | ProjectClosed
      | AuthorityDenied
      | ResponsibilityViolation
      | RevisionConflict,
    WorkspaceRepository
      | WorkRepository
      | TransactionPort
      | DomainEventJournal
      | Clock
  >
```

## 0A.2 Domain 中的 Effect

Domain 不依赖 infrastructure service，但可以使用 Effect 统一错误组合：

```text
Pure total function
→ A

Pure transition with expected domain rejection
→ Effect<A, DomainError, never>
```

因此 Domain 的关键边界不是“能不能 import Effect”，而是：

```text
Domain R = never
```

Domain 允许 `Schema / Brand / Option / Either / Data / Match / Effect<A,E,never>` 等纯建模能力；禁止 `Context.Service / Layer / SQL / HTTP / filesystem / Provider / runtime Clock service` 等 infrastructure requirement。

## 0A.3 Port = Effect Service

Infrastructure / runtime capability 通过 Effect service 暴露。Port interface 必须语义化，不能泄漏具体 Adapter：

```text
WorkspaceRepository.get(...)
→ Effect<Workspace, WorkspaceRepositoryError>
```

而不是：

```text
WorkspaceRepository.get(...)
→ Effect<Workspace, SqliteError, SqlClient>
```

底层 `SqlClient` 是 `WorkspaceRepositoryLive` 的构造依赖，不是 Port 调用者依赖。

## 0A.4 Layer 负责依赖构造

Service 的实现依赖在 `Layer` 构造阶段解决：

```text
SqliteClient Layer
        ↓
WorkspaceRepositoryLive
WorkRepositoryLive
TransactionPortLive
        ↓
Application/Runtime
```

Composition Root 负责最终提供完整 Layer graph。业务函数不接收 global `AppContext`，也不通过 constructor 参数手工层层传 repository/provider/tool。

## 0A.5 Requirement channel 必须精确

禁止：

```text
Effect<A, E, ArborServices>
```

其中 `ArborServices` 是所有 service 的万能集合。

每个 computation 的 `R` 必须由真实调用自然推导，只包含实际需要的 service。`R` 中意外出现 `SqlClient`、具体 Provider Adapter、SQLite implementation 等，应视为 architecture leak。

## 0A.6 Error channel 也用于架构审计

Application / Runtime public boundary 不允许出现：

```text
SqliteError
NodeFsError
OpenAISdkError
raw HttpError
```

底层实现错误必须在语义边界翻译成当前层的 typed error。`E` 中出现 adapter-specific error 表示抽象泄漏。

## 0A.7 Effect 编码规则

正式工程规则：

1. Expected/recoverable failure → typed `E`；
2. Impossible state / invariant violation → defect / `Cause`；
3. Stop/cancellation → interruption；
4. Normal alternatives → success ADT；
5. Port 使用 Effect service；Adapter 通过 Layer 提供；
6. Service implementation dependency 在 Layer construction 时解决，不泄漏到 Port 方法的 `R`；
7. 禁止 global AppEnv / Service Locator；
8. `R` 保持最小、精确；
9. 底层 implementation error 必须 map 成上层 semantic error；
10. Domain transition 的 infrastructure requirement 永远为 `never`；
11. 恢复优先使用窄的 tagged-error 处理，而不是无差别 catch-all；
12. `E` 与 `R` 的异常扩张纳入 architecture test / review。

---

# 1. DID-1 — Domain Object Classification & Aggregate Boundary

## 1.1 对象分类总表

| 对象 | 分类 | 核心语义 |
|---|---|---|
| `Project` | Aggregate Root | 项目最高治理、配置和 Environment 边界 |
| `Workspace` | Aggregate Root | 长期 Responsibility Identity；责任树节点 |
| `Work` | Aggregate Root | 一个阶段性、可验收的 outcome requirement |
| `Execution` | Aggregate Root / Runtime Domain | 一次可恢复、可 fencing 的执行 episode |
| `Session` | Runtime Aggregate Root | 长期认知连续性，而非业务权威状态 |
| `Verification` | Aggregate Root | 独立 Agentic Verification unit |
| `Dependency` | Aggregate Root | Consumer Work 对 Expected Deliverable 的正式等待 |
| `Deliverable` | Durable Entity | Work 产生的正式、版本稳定、可消费结果 |
| `ProducerBinding` | Value Object / ADT | Dependency 允许的生产者范围（AnyProducer / WorkspaceBound / WorkBound） |
| `ExpectedDeliverable` | Value Object | Dependency 的版本化结果 contract（kind + required artifact roles） |
| `DeliverableKind` | Branded String Value | Deliverable 的结果类型 |
| `ArtifactRole` | Branded String Value | Deliverable artifact 的角色 |
| `DeliverableMatchView` | Derived View | deterministic matcher 的输入视图 |
| `Message` | Durable Communication Record | 需要人/Agent 认知消费的通信 |
| `Acceptance` | Durable Record | Parent/User 对某 Work revision + Verification 的接受 |
| `Artifact` | Durable Entity | 不可变/版本化的具体 payload 引用 |
| `Decision` | Durable Entity | 正式治理/设计决策，可 supersede |
| `PermissionGrant` | Durable Entity | scope、issuer、lifetime 明确的权限授予 |
| `ResourceOwnershipClaim` | Durable Record | Workspace 对 canonical backing resource 的正式 write ownership |
| `ResponsibilityDefinition` | Value Object | Workspace 长期语义契约 |
| `ResourceBoundary` | Value Object | Responsibility 在现实资源上的可执行投影 |
| `ResourceAddress` | Value Object / ADT | Environment-facing 资源地址，不直接用于最终 overlap 判定 |
| `CanonicalResourceRegion` | Value Object | resolver 后的 backing resource space + normalized region；ownership overlap 的比较对象 |
| `VerificationMission` | Value Object | Verification 的目标、criteria 与风险要求 |
| `ResponsibilityBoundAgentBinding` | Value Object | Workspace 的长期执行配置 |
| `ExecutionBoundAgentBinding` | Value Object | Execution-scoped 临时角色配置 |
| `AgentBinding` | Umbrella Vocabulary | 上述两类的联合术语，不是 Workspace 字段类型 |
| `AgentProfile` | Reusable configuration | 默认 HOW，不定义长期 WHAT |
| `EffectiveFacts` | Projection | Canonical State + Curated Knowledge 的当前投影 |
| `Inbox` | Projection | 尚未被认知消费的重要输入集合 |
| `WorkspaceStatus` | Projection | 从 Work / Execution / Dependency 等事实派生 |
| `AgentExecutionState` | Runtime Record | 当前 Execution 的 mode、skills、turn 等控制状态 |

## 1.2 Project 与 Workspace Tree

`Project` 与 `Workspace` 均为独立 Aggregate Root。Project 不保存整棵 Workspace 对象图。

```text
Project P1
└── Root Workspace R
    ├── Workspace A
    │   └── Workspace A1
    └── Workspace B
```

Canonical relation：

```text
Workspace.projectId
Workspace.parentWorkspaceId
```

规则：

- 每个 Project 恰好一个 Root Workspace；
- Root 仍然是普通 Workspace，不引入 `RootWorkspace` 子类型；
- `parentWorkspaceId` 创建后 immutable；
- 不提供普通 `ReparentWorkspace`；
- Children/Subtree 是 query/projection，不保存 `childrenIds[]` 双向真相；
- Workspace Tree 不跨 Project。

因此：

```text
Identity != Location
Workspace tree grows by child creation, not reparent mutation.
```

## 1.3 Workspace / Work / Execution

三个对象独立持久：

```text
Workspace 1 ── N Work
Work      1 ── N Execution
```

`Workspace` 只保存少量当前组织引用：

```text
workspaceId
projectId
parentWorkspaceId
responsibilityDefinition
resourceBoundary
agentBinding
primarySessionId
currentWorkId?
lifecycle: Active | Retired
```

`Work` 维护自身生命周期：

```text
Open | Completed | Cancelled
```

`Current / Pending` 不存入 Work。它由以下事实推导：

```text
Open + workspace.currentWorkId == work.id → Current
Open + workspace.currentWorkId != work.id → Pending
```

`Execution` 是短期可恢复执行 episode。Execution outcome 与 Work lifecycle 分离：

```text
Execution Completed != Work Completed
Execution Failed    != Work Cancelled
```

## 1.4 Current Work 选择修订

早期 `PromoteWork` 要求 Workspace 只有在 `currentWorkId == None` 时才能选择 Work。审计后修订为：

```text
SelectCurrentWork
```

允许：

```text
W1(Current, Open, blocked)
↓
W2(Open, runnable)
↓
currentWorkId = W2
W1 自动退回 Pending projection
```

硬约束仍然是：

```text
CurrentWorkId <= 1
```

`SelectCurrentWork` 只在存在 `WorkspaceExecution(focus = Work(oldCurrentWork))` 的 Active Main Execution 时禁止；`focus = Coordination` 的 Active Main Execution 可以在校验候选 Work 后提交 `SelectCurrentWork`。

## 1.4A Workspace Lifecycle / Retirement / Lineage

```text
WorkspaceLifecycle = Active | Retired
```

`Retired` terminal。禁止 `ReparentWorkspace / MoveWorkspace / mutate-parent MergeWorkspace`。跨责任树的组织调整采用 **replacement, not relocation**：创建 Successor Workspace/subtree，显式迁移责任对应的新 Work、Context references、Resource Ownership 与 Dependency，再 bottom-up Retire 旧 subtree。

`RetireWorkspace` 前置条件：

```text
workspace != Root
workspace.lifecycle == Active
no Active Main Execution
currentWorkId == None
no Open Work
no Active Child Workspace
no active ResourceOwnershipClaim
no unresolved incoming Dependency whose ProducerBinding is
  WorkspaceBound(thisWorkspace) or WorkBound(a Work owned by thisWorkspace)
  (unless resolved/replaced in the same governance change)
```

Retired Workspace 不得 AssignWork、AdmitExecution、CreateChildWorkspace 或修改 Responsibility。`Work.workspaceId` immutable；未完成事项迁移时在 Successor 创建新的 Work，并通过 Provenance 指向被替代 Work，而不是移动原 Work。Session/Memory/Decision/Artifact 的 ownership 也不改写，只通过 bootstrap/reference 派生新的 successor cognition。

组织 lineage 使用普通 durable record：

```text
WorkspaceLineage {
  predecessorWorkspaceId
  successorWorkspaceId
  relation: Supersede | Split | Merge | ResponsibilityTransfer
  decisionId
  recordedAt
}
```

Lineage 不是 Aggregate Root。

## 1.5 ResponsibilityDefinition、ResourceBoundary 与 Resource Ownership

Workspace 的语义契约：

```text
ResponsibilityDefinition
├── purpose
├── ownedResponsibilities
├── obligations
├── includes
├── excludes
└── interfaces
```

它回答：

> 这个 Workspace 为什么长期存在、负责什么、不负责什么、对外提供什么边界。

`ResourceBoundary` 独立存在，回答：

> 当前 Responsibility 在 Project Environment 中允许读取、写入或消费哪些现实资源。

二者以及正式 write ownership 的关系：

```text
ResponsibilityDefinition
    semantic contract
          ↓
ResourceBoundary
    allowed executable scope
          ↓
ResourceAddress[]
          ↓ ProjectEnvironment resolver
CanonicalResourceRegion[]
          ↓ ownership validation
ResourceOwnershipClaim[]
```

三者不得合并：

```text
ResourceBoundary      = 这个责任允许作用到哪里
ResourceOwnershipClaim= 哪些 canonical region 当前由它正式拥有 write ownership
Permission            = 这一次具体动作是否被授权
```

### ResourceAddress ADT

第一版至少允许用可扩展 ADT 表达：

```text
ResourceAddress
├── FileTree(...)
├── GitWorktree(...)
├── DatabaseNamespace(...)
└── ExternalResource(...)
```

`ResourceAddress` 是语义/环境地址，不直接作为 uniqueness key。不同地址可能 alias 到同一个现实资源，例如 Git Worktree 最终落到某个 filesystem subtree。

因此 `ProjectEnvironmentPort` 必须提供确定性的 resolve/canonicalize boundary：

```text
ResourceAddress
        ↓ resolve
CanonicalResourceRegion {
  resourceSpaceId
  normalizedRegion
}
```

`contains(a,b)` 与 `overlaps(a,b)` 定义在同一 `resourceSpaceId` 下的 `CanonicalResourceRegion` 上；跨 resource space 默认不 overlap，除非 Environment resolver 明确把二者归一到同一 backing space。

核心规则：

- Semantic boundary guides；Resource boundary enforces；
- Responsibility change 可以导致 ResourceBoundary 变化；
- ResourceBoundary 因目录、worktree、数据库 namespace 等环境映射变化时可以独立更新；
- Read visibility 可以重叠；
- formal write ownership 默认不重叠；
- ownership enforcement 比较 canonical backing resource，而不是原始 path/string；
- Permission 不能扩大 ResourceBoundary，也不能覆盖 write ownership invariant；
- `ResourceOwnershipClaim` 是 durable record，不升级为新的 Aggregate Root。

Resource resolution 可能访问 filesystem/worktree/mount/external namespace，因此不得在 SQLite write transaction 内执行慢 I/O。第一版 enforcement 语义冻结为：

```text
resolve/canonicalize ResourceAddress outside write transaction
→ CanonicalResourceRegion[] + observedEnvironmentRevision

BEGIN IMMEDIATE
→ verify observedEnvironmentRevision is still current
→ load potentially conflicting ownership claims
→ deterministic overlaps()
→ insert/update claims with resolvedAtEnvironmentRevision
→ COMMIT
```

若 Environment revision 已变化，返回 `ResourceResolutionStale` 并重新 resolve；不得用旧 mapping 提交 ownership。具体索引、query 优化与 DDL 留给 P1 exact schema closure。


## 1.6 Agent 不作为长期 Domain Entity

Arbor v1 不存在 `AgentId` 和独立长期 `Agent` Aggregate。

```text
Workspace = long-lived responsible identity
Agent     = runtime execution role
```

长期 Agent 连续性来自：

```text
WorkspaceId
+ ResponsibilityDefinition
+ ResponsibilityBoundAgentBinding
+ Primary Session
+ Workspace Memory
```

`AgentBinding` 是 umbrella vocabulary，分两类：

```text
ResponsibilityBoundAgentBinding
    → Workspace
    → long-lived session / memory

ExecutionBoundAgentBinding
    → Execution
    → temporary mission
```

`Workspace.agentBinding` 的类型是 `ResponsibilityBoundAgentBinding`；
`ExecutionBoundAgentBinding` 只属于 Execution-scoped 临时 context，不得存入 Workspace。

`AgentProfile` 定义默认 HOW；`ResponsibilityDefinition` 定义 WHAT。Profile 不成为责任或权限来源。

## 1.7 Session

`Session` 是独立 Runtime Aggregate Root，用于持久化认知连续性，而不是业务真相。

```text
SessionBinding
├── WorkspacePrimary(workspaceId)
└── ExecutionScoped(executionId)
```

长期 Workspace 当前只引用一个 `primarySessionId`，历史 Session 可以保留并被 supersede。Workspace 主 Execution admission 时必须 snapshot 当前 `primarySessionId` 为 `execution.sessionId`；该 Execution 后续始终写同一 Session。`ReplacePrimarySession` 只影响未来 Execution，并要求当前不存在 Active Main Execution。

Session 保存：

- cognitive history references；
- `ContextEpoch`；
- checkpoint；
- provider continuation metadata；
- model/output continuation state。

Session 不保存：

- Responsibility canonical truth；
- Current Work canonical truth；
- Permission；
- Dependency 状态；
- Verification verdict；
- Resource ownership。

长期认知结构：

```text
Checkpoint + Recent Frontier
```

## 1.8 Dependency / Deliverable / Message

三者严格分开：

```text
Message     = communication
Deliverable = formal result
Dependency  = unmet result requirement
```

`Dependency` canonical consumer 是 `Work`，而不是模糊的 Workspace→Workspace 关系。Lifecycle 为 `Unsatisfied | Satisfied | Withdrawn | Unfulfillable`；后三者 terminal：

```text
Dependency
├── dependencyId
├── consumerWorkId
├── producerBinding: ProducerBinding
├── revision: DependencyRevision
├── expectedDeliverable: ExpectedDeliverable
├── state: Unsatisfied | Satisfied | Withdrawn | Unfulfillable
├── satisfiedByDeliverableId?
└── satisfiedAtDependencyRevision?
```

`ProducerBinding` 只有三种，表达“这个需求允许由谁提供”：

```text
ProducerBinding
├── AnyProducer
├── WorkspaceBound(workspaceId)
└── WorkBound(workId)
```

`ExpectedDeliverable` 表达“需要提供什么东西”，不包含 producer：

```text
ExpectedDeliverable
├── kind: DeliverableKind
└── requiredArtifactRoles: readonly ArtifactRole[]
```

`DeliverableKind` 与 `ArtifactRole` 是 branded string value（不是 Entity ID）。

`Deliverable` 必须关联：

```text
Deliverable
├── deliverableId
├── sourceWorkId
├── sourceWorkRevision: WorkRevision
├── kind: DeliverableKind
└── artifacts: readonly { role: ArtifactRole, artifactId: ArtifactId }[]
```

Dependency satisfaction 是 deterministic structural matching。matcher 的输入被显式冻结，避免 Domain 函数自行访问 Repository：

```text
DeliverableMatchView
├── deliverableId
├── sourceWorkId
├── sourceWorkspaceId
├── kind
└── artifactRoles: ReadonlySet<ArtifactRole>

matchesExpectedDeliverable(
  producerBinding,
  expectedDeliverable,
  candidate: DeliverableMatchView
) -> boolean
```

算法固定为：

```text
1. producerBinding 匹配 candidate 来源
   AnyProducer            → true
   WorkspaceBound(ws)     → candidate.sourceWorkspaceId == ws
   WorkBound(work)        → candidate.sourceWorkId == work
2. candidate.kind == expected.kind
3. expected.requiredArtifactRoles 中每个 role 都在 candidate.artifactRoles 中
4. 三项全部成立 → true；否则 false
```

matcher 返回 false 时 `SatisfyDependency` 被拒绝，Dependency 状态不变。

P0 不引入 metadata query DSL、regex predicate、semantic similarity、LLM matcher 或 arbitrary JSON predicate；以后需要时以新的设计变更增加。

`Dependency` 的 `expectedDeliverable` 随 Dependency revision 形成明确 contract。`SatisfyDependency` 必须绑定当前 `targetDependencyRevision`，并同时读取 `producerBinding` 与 `expectedDeliverable`；已满足记录 immutable，后续 contract 改变应形成新的 revision/Dependency，而不是静默重解释旧 satisfaction。

旧 Work revision 的 Deliverable 不因 Work 后续 refine 自动满足新 revision 的 requirement。

`Message` 只用于需要认知处理的 Query / Reply / Report / DecisionRequest / HumanInput 等通信，不作为 universal system envelope。`Inbox` 是未消费输入的 projection。

---

# 2. DID-2 — Identity Model

## 2.1 Typed IDs

所有独立持久 Identity 使用强类型 ID：

```text
ProjectId
WorkspaceId
WorkId
ExecutionId
SessionId
VerificationId
DependencyId
DeliverableId
MessageId
ArtifactId
DecisionId
PermissionGrantId
AcceptanceId
EvidenceId
MemoryId
CommandId
EventId
ProviderTurnId
ToolInvocationId
WorkerId
```

明确不存在：

```text
AgentId
RootWorkspaceId
PrimarySessionId
```

Root/Primary 是关系角色，不是新实体类型。

## 2.2 ID 规则

- 底层采用 UUIDv7 类可时间排序随机标识；
- 增加 `prj_ / ws_ / wrk_ / exe_ / ses_ ...` prefix 便于运行时校验和调试；
- TypeScript 使用 nominal/branded type，运行时使用 Schema codec；
- ID 不编码名称、父子路径、业务 location 或 sequence；
- Entity state evolution 不改变 Identity；
- Human-friendly `W-42` 等仅是 projection/display code。

核心：

```text
Identity != Name != Location != Order
```

## 2.3 Event ordering 与 local ordinal

`EventId` 与 `EventSequence` 分离。Event Journal 使用 Project-local sequence 或 journal partition sequence，不依赖 UUID / timestamp 作为严格顺序。

局部概念使用 scoped ordinal：

```text
ContextEpochNumber
LeaseGeneration
ResponsibilityRevision
ResourceBoundaryRevision
ArtifactRevision
WorkRevision
DependencyRevision
```

`WorkRevision` 是 `Work` identity 内部单调递增的 semantic revision：Work 创建时从初始 revision 开始，`RefineWork` / semantic `SteerWork` 使其递增；`Deliverable.sourceWorkRevision`、`Verification.targetWorkRevision`、`Acceptance.targetWorkRevision` 都用它绑定具体 Work version。`DependencyRevision` 同理用于 `Dependency.revision` / `targetDependencyRevision` / `satisfiedAtDependencyRevision`。

`WorkRevision` / `DependencyRevision` 是 scoped ordinal / branded value，**不是** Entity Identity：不加入 §2.1 Typed IDs，也不加 prefix。

不为每个内部 record 无限制创造全局 UUID。

---

# 3. DID-3 — Core Aggregate State Model

## 3.1 Project

核心字段：

```text
ProjectId
name
rootWorkspaceId
projectPolicy
projectPolicyRevision
default configuration
environmentRef
lifecycle: Open | Closed
revision
```

`revision` 是 Aggregate optimistic-concurrency revision：Project 的每次 canonical mutation 都递增。`projectPolicyRevision` 只在 `projectPolicy` 语义发生变化时递增；`UpdateProjectPolicy` 同时递增二者。

关键 Invariant：

- 一个 Project 恰好一个 Root Workspace；
- Project Closed 后不再 admission 新自主 Execution；
- Project Policy 构成下级 capability/policy ceiling。

## 3.2 Workspace

核心字段：

```text
WorkspaceId
ProjectId
ParentWorkspaceId?
name
ResponsibilityDefinition
ResponsibilityRevision
ResourceBoundary
ResourceBoundaryRevision
ResponsibilityBoundAgentBinding
PrimarySessionId
CurrentWorkId?
WorkspacePolicy
workspacePolicyRevision
revision
```

`revision` 是 Aggregate optimistic-concurrency revision：Workspace 的每次 canonical mutation 都递增。`workspacePolicyRevision` 只在 `WorkspacePolicy` 语义发生变化时递增；`UpdateWorkspacePolicy` 同时递增二者，而 `SelectCurrentWork` / `ReplacePrimarySession` 等只递增 aggregate `revision`。

关键 Invariant：

- Parent immutable；
- 最多一个 Current Work；
- Current Work 必须属于本 Workspace；
- Responsibility/ResourceBoundary 变化 revision++；
- Primary Session 必须是 `WorkspacePrimary` binding；
- `ReplacePrimarySession` 要求不存在 Active Main Execution；replacement 不改变已 admission Execution 的 `sessionId`。

## 3.3 Work

核心字段：

```text
WorkId
ProjectId
WorkspaceId
Objective
Why
Constraints
CompletionExpectation
VerificationMission
Provenance
Lifecycle
revision
```

生命周期：

```text
Open → Completed
Open → Cancelled
```

Completed / Cancelled 默认 terminal。

Producer 不得自行削弱 Objective / CompletionExpectation / required VerificationMission。

## 3.4 Execution

Execution Binding：

```text
WorkspaceExecution {
  workspaceId
  focus: Work(workId) | Coordination
}

ExecutionBoundAgentBinding {
  parentExecutionId?
  mission
}
```

Workspace 可以因 Query / Decision / Human Input 等 coordination input 被唤醒，因此 Workspace Execution 不强制存在 WorkId。

### Admission-time fixed binding

Execution admission 时固定：

```text
executionId
projectId
binding
sessionId
admittedAt
settlement?: ExecutionSettlement
```

- `WorkspaceExecution` snapshot 当前 Workspace `primarySessionId`；
- `ExecutionBoundAgentBinding` 绑定其 `ExecutionScoped` Session；
- `execution.sessionId` admission 后 immutable；
- Primary Session replacement 不改变任何已 admission Execution。

### ExecutionSettlement 是 sum type

Execution settlement 必须同时表达 technical outcome 与与之匹配的 semantic terminal result，但实现上使用 discriminated union，禁止任意 `outcome × result` 笛卡尔积：

```text
ExecutionSettlement
├── Completed(CompletedResult)
│   ├── Yielded(reason, waitSpec)
│   ├── CompletionClaimed
│   ├── CoordinationCompleted
│   └── QueryCompleted
├── Interrupted(InterruptedResult)
│   └── StopRequested / other controlled interruption
├── Failed(ExecutionFailure)
└── OutcomeUnknown(ReconciliationRequired)
```

关键约束：

- `CompletionClaimed` 必须持久携带足够的 claim/reference 与 target Work revision，使 event replay 可以可靠触发后续 Verification；
- Worker crash、lease expiry 或旧 Worker resurrection **本身不直接 settle Execution**；Recovery 可以继续同一 durable Execution；
- `OutcomeUnknown` 表示存在未解决的现实副作用歧义，reconciliation 前禁止盲目 replay；
- `Completed != Work Completed`，`Failed != Work Cancelled`。

Execution admission 与 Worker lease acquisition 分离：

```text
Admit durable Execution
↓
Dispatch Worker
↓
Worker acquires lease
↓
execute
```

### Stop / Quiescence

`StopExecution` 提交后立即关闭该 Execution 的新 ProviderTurn、ToolInvocation、Execution-originated canonical Command 与 Specialist spawn admission。已经 in-flight 的 ToolInvocation 按 SideEffectSemantics cancel/reconcile；只要仍存在 unresolved side-effectful ToolInvocation，Execution 就不得 settle 为普通 Completed/Interrupted/Failed，只能继续 reconcile 或 `OutcomeUnknown(ReconciliationRequired(invocationRefs))`。`CancelWork` 与 Stop 分离：Work 可先成为 Cancelled，相关 Execution 随后完成 quiescence。



## 3.5 Verification

Verification 保存：

```text
VerificationId
WorkId
TargetWorkRevision
MissionSnapshot
TargetDeliverables
TargetArtifactVersions
TargetEnvironmentRevision?
EnvironmentSnapshotRef?
EvidenceRefs
VerificationExecutionIds
Verdict?: Pass | Fail | Unknown
```

规则：

- concluded verdict immutable；
- 重新验证创建新 Verification；
- Producer、Verifier、Acceptance 三层分离；
- Verifier 默认只读 Producer formal output；
- Verification 绑定具体 Work/Deliverable/Artifact 版本。


## 3.6 Acceptance / Deliverable / Dependency revision binding

`Acceptance` 落实为：

```text
Acceptance
├── workId
├── targetWorkRevision
├── verificationId
├── actor
└── acceptedAt
```

`CompleteWork` 必须在同一 semantic decision 中验证：

```text
work.lifecycle == Open
AND verification.workId == work.id
AND verification.targetWorkRevision == work.revision
AND verification.verdict == Pass
AND acceptance.workId == work.id
AND acceptance.targetWorkRevision == work.revision
AND acceptance.verificationId == verification.id
```

Work refine 后，旧 Verification / Acceptance 记录仍保留，但自动变为“不适用于当前 revision”，不得被复用完成新 revision。

`Deliverable.sourceWorkRevision`（`WorkRevision`）与 `Dependency.targetDependencyRevision`（`DependencyRevision`）形成消费链：

```text
Work revision (WorkRevision)
→ Deliverable(sourceWorkRevision: WorkRevision)
→ SatisfyDependency(targetDependencyRevision: DependencyRevision)
```

`SatisfyDependency` 用 `producerBinding` + `expectedDeliverable` 对 `DeliverableMatchView` 做 deterministic structural matching（见 §1.8）。不新增独立 `OutputContract` Domain Entity；ExpectedDeliverable 仍是 Dependency 内的版本化 contract。

## 3.7 Runtime Supporting Records

以下对象不作为富 Aggregate：

```text
AgentExecutionState
ProviderTurn
ToolInvocation
CommandAttempt
CommandReceipt
SessionEntry
MessageConsumption
EvidenceRecord
DomainEvent
UsageRecord
```

其中 `AgentExecutionState` 保存当前 episode 的控制状态：

```text
executionId
focus
wakeReason
currentMode
activeSkillRefs[]
turnNo
recentDirectiveRefs[]
recentActionFingerprints[]
updatedAt
```

它与 Workspace/Session 分离：

```text
Workspace            = long-lived responsibility state
Session              = long-lived cognitive continuity
AgentExecutionState  = current episode control state
```

---

# 4. DID-4 — Command Model

## 4.1 Command logical request / attempt / receipt

```text
Command = immutable logical request to change canonical state
Event   = committed domain fact after successful canonical change
```

### CommandEnvelope

领域意图使用：

```text
CommandEnvelope<C>
├── commandId
├── projectId
├── actor              // declared actor
├── issuedAt
├── causationRef?
├── correlationRef?
└── payload
```

`CommandId` 是 **immutable logical request identity**。系统同时计算稳定 `semanticRequestFingerprint`（至少覆盖 commandType、projectId、declared actor、schemaVersion 与 semantic payload）：

```text
same CommandId + same semanticRequestFingerprint
→ same logical request

same CommandId + different semanticRequestFingerprint
→ IdempotencyConflict
```

修改 expected revision、target revision、scope、actor intent 或其他语义 payload 后，已经是新的 logical request，必须使用新的 CommandId。

`semanticRequestFingerprint` 的**具体 canonical serialization 与 hash 算法**在 P1 phase contract 冻结，并随 `fingerprint_algorithm_version` 持久化；P0 的 32-bit FNV-1a 是 interim，不是冻结算法。持久化列名统一为 `semantic_request_fingerprint`。

### CommandSubmissionContext

`CommandEnvelope` 不承载可信执行来源。Runtime 额外提供不可由模型/调用 payload 伪造的 authenticated context：

```text
CommandSubmissionContext
├── External {
│     principal
│   }
├── ExecutionOrigin {
│     principal
│     executionId
│     fencingGeneration
│   }
└── System {
      principal
      causationRef
    }
```

Declared Actor 与 authenticated principal 分开验证。Execution-originated mutation 的 fencing token 来自 Runtime context，不来自模型输出。

### CommandAttempt

同一 logical Command 可以存在多个 operational attempt：

```text
Command cmd_1
├── Attempt #1 → RetryableOperationalFailure
├── Attempt #2 → RetryableOperationalFailure
└── Attempt #3 → Committed
```

Attempt 使用 `(commandId, attemptNo)` local ordinal，不创建新的全局 Entity identity。

允许 same CommandId retry 的前提是**语义请求完全未变**。例如 transient persistence unavailability / lock contention 可以新建 attempt；如果 caller 必须 reload state 并修改 payload/precondition 才能继续，则创建新的 logical Command。

### CommandReceipt / Resolution

Authoritative resolution：

```text
CommandResolution
├── Committed(result)
└── TerminalRejected(typedError)
```

`CommandReceipt` 是该 resolution 的稳定外部/内部表示，不是 Domain Event。

规则：

- semantic rejection（如 AuthorityDenied、WorkNotOpen、显式 expected revision mismatch）可成为 durable `TerminalRejected`；
- terminal rejection 不产生 Domain Event，因为 Domain truth 未变化；
- transport / transient persistence failure 不产生 authoritative Resolution；调用方使用同一 CommandId 重试，可产生新的 attempt；
- `FencingRejected` 对该 Execution-originated logical Command 是 terminal；旧 Worker 不得普通 retry；
- 同一 CommandId 一旦进入 Committed 或 TerminalRejected，后续同 payload retry 直接返回已存在 Receipt；
- Command 不按 CRUD setter 设计，而按领域意图设计。


## 4.1A GovernanceChangeSet / coupled governance mutation

Public API 仍使用语义 Command，不暴露万能 patch command。`ChangeResponsibility` 等 Command 在 Application 内部可以计算 `GovernanceMutationPlan`，并在一个 semantic transaction 中同时更新：

```text
ResponsibilityDefinition + revision
ResourceBoundary + revision + basisResponsibilityRevision
ResourceOwnershipClaim set
relevant Workspace policy facts
Domain Events
```

每个 committed state 必须满足：

```text
ResourceOwnershipClaim ⊆ ResourceBoundary
ResourceBoundary.basisResponsibilityRevision == Workspace.responsibilityRevision
```

禁止依赖“先改 Responsibility、下一条命令再改 Boundary”的危险中间状态。

## 4.2 Public / Governance Commands

### Project

```text
CreateProject
UpdateProjectPolicy
CloseProject
```

### Workspace / Governance

```text
CreateChildWorkspace
ChangeResponsibility
UpdateResourceBoundary
UpdateWorkspacePolicy
ReplacePrimarySession
```

### Work

```text
AssignWork
SelectCurrentWork
RefineWork
CompleteWork
CancelWork
SteerWork
```

### Coordination

```text
DeclareDependency
SatisfyDependency
ProduceDeliverable
SendMessage
```

### Verification / Acceptance

```text
StartVerification
RecordVerificationEvidence
ConcludeVerification
AcceptWorkOutcome
```

### Permission / Decision

```text
GrantPermission
RevokePermission
RecordDecision
```

## 4.3 Internal Runtime Commands

对外不必暴露，但仍进入 Application mutation pipeline：

```text
AdmitExecution
SettleExecution
StopExecution
RecordEnvironmentChange
```

这些 mutation 会改变未来系统行为或产生 Domain Event，因此不应作为裸 Repository update。

## 4.4 Domain Semantic Mutation 与 Runtime Operational Mutation

规则修订为：

```text
Domain/Governance semantic mutation
→ Application Command Pipeline

Runtime operational mutation
→ owning Runtime Port
```

Runtime operational examples：

```text
Lease heartbeat
Session entry append
Provider turn trace
Tool invocation trace
Consumer offset
Projection update
```

但 Execution admission/settlement、Primary Session replacement、Environment change 等影响未来行为的变化仍使用 internal Command。

---

# 5. DID-5 — Domain Events & Consumers

## 5.1 Event pipeline

```text
Command
↓
Authority / Preconditions / Invariants
↓
DB Transaction
├── Canonical State
├── Command Result
└── Domain Event Journal
↓
COMMIT
↓
Event Dispatcher
├── Scheduler Consumer
├── Coordination Consumer
├── Projection Consumer
├── Context/Knowledge Consumer
└── Operations Consumer
```

核心：

```text
Events notify; Canonical State decides.
Consumers react; Commands mutate.
At-least-once + Idempotency.
```

## 5.2 Event Envelope

```text
DomainEvent<E>
├── eventId
├── projectId
├── sequence
├── eventType
├── eventVersion
├── occurredAt
├── aggregateRef
├── actor
├── causedByCommandId?
├── causedByEventId?
├── correlationRef?
└── payload
```

Event payload 只描述有意义的 change fact，不复制完整 Aggregate snapshot。

## 5.3 核心 Event Catalog

```text
ProjectCreated
ProjectPolicyChanged
ProjectClosed

WorkspaceCreated
ResponsibilityChanged
ResourceBoundaryChanged
ResourceOwnershipChanged
WorkspacePolicyChanged
WorkspaceRetired
WorkspaceLineageRecorded
PrimarySessionReplaced

WorkAssigned
CurrentWorkChanged
WorkRefined
WorkCompleted
WorkCancelled
WorkSteered

DependencyDeclared
DependencySatisfied
DependencyWithdrawn
DependencyMarkedUnfulfillable
DeliverableProduced
MessageSent

VerificationStarted
VerificationConcluded
WorkOutcomeAccepted

ExecutionAdmitted
ExecutionStopRequested
ExecutionSettled

PermissionChanged
DecisionRecorded
EnvironmentChanged
HumanInterventionApplied
```

高频 Provider Turn、Tool Invocation、Lease Renew、stream delta 不进入 Project Domain Event Journal，而进入 Execution Trace / Runtime Records。

## 5.4 Consumer 规则

- Consumer 使用 at-least-once delivery；
- Consumer 不直接绕过 Command Handler 修改 Domain；
- Event→Command 使用 deterministic CommandId，保证重投幂等；
- Projection failure 不回滚 Domain transaction；
- Projection/Context stale 通过 retry/catch-up/rebuild 恢复；
- Event 不自动等于“启动 Agent”，只触发 runnable reevaluation。

---

# 6. DID-6 — System Invariant Enforcement Map

## 6.1 六层 Enforcement

| Layer | 责任 |
|---|---|
| L1 `Domain Pure Logic` | 单 Aggregate 内部合法性、ADT、terminal transition |
| L2 `Command Handler / Application` | 跨 Aggregate、Authority、业务前置条件 |
| L3 `Persistence / Transaction` | 并发唯一性、幂等、CAS、fencing、原子性 |
| L4 `Runtime Coordination` | Scheduler、Lease、Recovery、external-effect lifecycle |
| L5 `Tool/Sandbox` | 对现实资源的物理限制 |
| L6 `Projection/Diagnostics` | Deadlock、Attention、Human override propagation 等可推导事实 |

硬规则：

```text
Hard invariant != Prompt instruction
```

## 6.2 Enforcement Matrix

| Invariant | L1 | L2 | L3 | L4 | L5 | L6 |
|---|---:|---:|---:|---:|---:|---:|
| Parent immutable | ✓ | ✓ |  |  |  |  |
| Workspace Tree 同 Project |  | ✓ | ✓ |  |  |  |
| CurrentWork <= 1 | ✓ | ✓ | ✓ |  |  |  |
| Active Main Execution <= 1 |  |  | **✓** | ✓ |  |  |
| Write ownership 不重叠 |  | ✓ | ✓ |  | **✓** |  |
| Parent/Sibling authority |  | **✓** |  |  |  |  |
| Work terminal lifecycle | **✓** | ✓ |  |  |  |  |
| Verification + Acceptance before Complete |  | **✓** |  |  |  |  |
| Producer/Verifier 隔离 |  | ✓ |  | ✓ | **✓** |  |
| Session cognition-only | schema | ✓ |  |  |  |  |
| Dependency satisfaction immutable | ✓ | ✓ |  |  |  |  |
| Deadlock attention |  |  |  |  |  | **✓** |
| Command idempotency |  | ✓ | **✓** |  |  |  |
| State + Event atomic |  |  | **✓** |  |  |  |
| Consumer idempotency |  |  |  | **✓** |  |  |
| Lease fencing |  |  | **✓** | **✓** |  |  |
| Tool authority chain |  | ✓ |  | **✓** | **✓** |  |
| OutcomeUnknown reconcile |  |  |  | **✓** |  |  |
| Human override propagation |  |  |  |  |  | **✓** |
| Verification version binding | ✓ | ✓ |  |  |  |  |

## 6.3 Fencing 范围与原子性

Fencing 不只保护 `Execution` row，而保护所有 Worker-originated durable write：

```text
Execution semantic mutation
Session append
ProviderTurn settlement
ToolInvocation settlement
Agent-produced canonical command
```

所有此类 durable mutation 都携带：

```text
executionId + fencingGeneration
```

但语义分两层：

```text
CommandGateway / Runtime pre-check
→ 只用于快速失败

authoritative fence validation
→ 必须在 canonical mutation 的 SAME transaction 内完成
```

对于 Execution-originated semantic command，至少以下动作处于同一事务一致性快照/提交边界：

```text
fence validation
+ canonical reads used by decision
+ authority/precondition evaluation inputs
+ canonical writes
+ Command resolution
+ Domain Event append
```

Adapter 可以通过 transaction-scoped connection 或带 generation 条件的 CAS/UPDATE 实现，但不能采用“事务外检查 fence → 事务内盲写”的 TOCTOU 模式。

旧 Worker 即使恢复也不能污染当前现实状态。`FencingRejected` 是 persistence enforcement 的权威拒绝；该 Worker 必须停止 durable mutation。


## 6.4 LLM 与 Runtime 的职责边界

```text
LLM judges semantics.
Runtime guarantees invariants.
DB enforces structural concurrency truth.
Sandbox enforces physical boundaries.
```

LLM 可以参与 Responsibility Formation、Work planning、semantic conflict detection、Verification investigation、Memory extraction；但不能成为 parent immutability、permission ceiling、lease、command idempotency、state+event atomicity 的最终 enforcement point。

---

# 6A. Pre-implementation Closure — Error Algebra & Failure Semantics

## 6A.1 Error、Outcome、Control Flow、Unknown 必须分开

Arbor 将“不正常”严格区分为：

| 类别 | 语义 | 典型例子 | Effect 表达 |
|---|---|---|---|
| Normal Alternative | 合法替代结果 | Verification.Unknown、Tool ExpectedFailure | `A` 中 ADT |
| Blocked / Deferred | 当前不能继续但系统未坏 | unresolved Dependency、GovernanceBlocked | `A` 中 control result / Yield |
| Rejection | 请求与 Canonical State/Authority 不兼容 | WorkNotOpen、AuthorityDenied | typed `E` |
| Conflict | stale/concurrent attempt 失效 | RevisionConflict、FencingRejected | typed `E` |
| Operational Failure | 外部设施失败 | ProviderUnavailable | typed `E` |
| Ambiguous Outcome | 外部副作用是否发生未知 | Tool OutcomeUnknown | settlement/state，不是 generic error |
| Defect | 理论不可能状态/程序 bug | invariant violation | defect / Cause |
| Interruption | 明确取消/停止 | StopExecution、shutdown | interruption |

核心规则：

```text
Normal outcome != Error
Blocked        != Failed
Execution fail != Work cancellation
```

## 6A.2 不存在万能 `ArborError`

Package/API 内部使用 narrow tagged error algebra。函数签名应精确反映调用方可处理的失败，不允许把所有错误压成：

```text
Effect<A, Error>
```

或者：

```text
{ success: false, message: string }
```

外部 API 可以统一映射成 presentation `Problem` DTO，但这不改变内部 typed error。

## 6A.3 FailureDisposition

Runtime 对 typed error 的处理通过独立纯分类得到，而不是把 `retryable: true` 写死在每个 Error 上：

```text
FailureDisposition
├── ReturnToCaller
├── RetrySameLogicalCommand
├── RetryWithBackoff
├── WaitForStateChange
├── ReconcileBeforeRetry
├── SettleExecutionFailed
├── SettleExecutionOutcomeUnknown
└── EscalateAttention
```

同一个错误在不同 operation context 下可以产生不同 disposition。

## 6A.4 Persistence translation

SQLite / SQL implementation errors 不越过 Adapter boundary。典型映射：

```text
partial unique violation on active main execution
→ ActiveExecutionConflict

CAS affectedRows = 0
→ RevisionConflict

lease generation mismatch
→ FencingRejected

DB unavailable / I/O failure
→ PersistenceUnavailable
```

内部 row decode 出现违反当前 schema 且不存在合法 migration 路径的 impossible state，应视为 corruption/defect，而不是普通 DomainError。

## 6A.5 Conflict 语义

必须区分 **operational contention** 与 **semantic stale precondition**。

### Operational contention

例如：

```text
temporary DB lock / busy
transient transaction abort
persistence temporarily unavailable
```

如果 logical payload 与它依赖的语义前提没有改变，可以：

```text
same CommandId
→ new CommandAttempt
```

Runtime 只在确认 attempt 等价时进行 bounded retry/backoff。

### Semantic stale precondition

若 Command payload 明确携带：

```text
expectedRevision = 17
```

而 canonical state 已经是：

```text
actualRevision = 18
```

则这是该 logical request 的 `RevisionConflict`。若 caller 必须 reload / re-evaluate 并把 expected revision 改成 18，payload 已变化，因此：

```text
old CommandId
→ TerminalRejected(RevisionConflict)

re-evaluated request
→ new CommandId
```

`FencingRejected` 更严格：它表示提交者已经失去 execution ownership，该 Execution-originated logical Command terminal，旧 Worker 禁止普通 retry。

同时区分：

```text
LeaseLost       = worker/runtime 的本地所有权知识
FencingRejected = persistence enforcement 给出的权威拒绝
```

Lease loss / fencing rejection 都不自动让 Work 失败或取消；Worker crash/lease expiry 也不直接决定 durable Execution settlement。


## 6A.6 Execution Settlement

Execution 不再只保存四值 outcome，而保存合法 sum type：

```text
ExecutionSettlement
├── Completed(CompletedResult)
├── Interrupted(InterruptedResult)
├── Failed(ExecutionFailure)
└── OutcomeUnknown(ReconciliationRequired)
```

精确定义：

- `Completed(...)`：episode 正常到达稳定边界；result 必须说明是 `Yielded`、`CompletionClaimed`、`CoordinationCompleted`、`QueryCompleted` 等哪一种语义；
- `Interrupted(...)`：外部控制明确提前结束，并且不存在 unresolved ambiguous side effect；
- `Failed(...)`：当前 episode 无法继续，正常恢复策略已耗尽或错误不可恢复；
- `OutcomeUnknown(...)`：存在外部副作用可能已经发生但系统无法确定，必须先 reconciliation。

关键规则：

```text
Execution Completed != Work Completed
Execution Failed    != Work Cancelled
technical outcome   != semantic terminal result
```

Worker crash、daemon crash、lease expiry 本身不直接产生 settlement；Recovery 根据 durable trace、lease 与 external-effect settlement 决定继续同一 Execution、settle 或产生后续动作。

`CompletionClaimed` settlement 必须能够 durable 地驱动：

```text
ExecutionSettled(CompletionClaimed)
→ event consumer
→ deterministic StartVerification CommandId
→ StartVerification
```

consumer 不直接绕过 Command Handler 创建 Verification。


## 6A.7 Tool failure model

```text
ToolInvocationSettlement
├── Success
├── ExpectedFailure
├── Interrupted
├── OutcomeUnknown
└── RuntimeFailure
```

`pytest failed`、`git conflict`、shell exit 1 等通常是模型需要认知的 `ExpectedFailure Observation`，不应导致 Agent fiber 失败。

ToolDefinition 必须声明：

```text
SideEffectSemantics
├── ReadOnly
├── Idempotent
├── Reconcilable
└── NonIdempotent
```

Retry rule：

```text
ReadOnly      → transient retry allowed
Idempotent    → same invocation key replay allowed
Reconcilable  → unknown 时先 reconcile 再决定 replay
NonIdempotent → ambiguity 时禁止自动 replay
```

Authority/Permission denial 在 ToolRuntime 内是 rejection，但应投影成模型可理解的 `ToolInvocationDenied` Observation，而不是崩溃 Execution。

## 6A.8 Provider failure model

至少区分：

```text
RateLimited
ProviderUnavailable
AuthenticationFailed
RequestRejected
StreamInterrupted
ProtocolViolation
```

`ModelOutputContractViolation` 不属于 Provider transport failure，而属于 Model Context / Agent Runtime：请求已经成功，只是模型输出不符合当前 Output Contract。允许 bounded repair；repair policy 耗尽后才 settle Execution Failed。

## 6A.9 ProviderTurn 与 ProviderAttempt

逻辑一次模型决策是 `ProviderTurn`，固定一份 `ModelContextManifest` 与 OutputContract；transport retry 是该 Turn 下的多个 `ProviderAttempt`：

```text
ProviderTurn T17
├── Attempt #1 → transient network failure
└── Attempt #2 → success
```

`ProviderAttempt` 使用 Turn-local ordinal，不需要新的全局 Entity ID。Provider retry 不得被误记为 Agent 多思考了一轮。

## 6A.10 Model Context control results

`prepareTurn()` 的 success/control ADT：

```text
TurnPreparation
= Ready(PreparedModelTurn)
| NeedsCompaction(CompactionRequest)
| GovernanceBlocked(GovernanceIssue)
```

其中 `NeedsCompaction` 与 `GovernanceBlocked` 都是合法 control result，属于 `A`。

`ContextUnsatisfiable` 不属于该 ADT，而属于 typed `E`：Mandatory/Pinned context 在当前允许模型策略下无法合法构造。

因此语义合同为：

```text
prepareTurn(...)
→ Effect<
    TurnPreparation,
    ContextUnsatisfiable | <narrow translated operational failures>,
    ModelContextRequirements
  >
```

具体 port failure 继续按 A/E/R 原则保留窄的 semantic error，不合并成万能 `ContextPreparationError`。

Instruction conflict 也不天然是 Error：可由 Authority/Scope/Composition 确定性消解的冲突是 Resolver 正常工作；只有无法消解的同级 canonical conflict 才形成 `GovernanceBlocked`。


## 6A.11 Verification 与 Waiting

`Verification.Unknown` 永远是合法 Verdict，不是 Error；unresolved Dependency / pending Decision / Human approval 也不是 Work failure。

```text
blocked
→ Work remains Open
→ current Execution yields/settles
→ future event wakes Workspace
```

## 6A.12 Error translation boundary

低层错误跨语义边界前必须翻译：

```text
SQLite / SDK / OS error
↓ adapter translation
Persistence / Provider / Tool semantic error
↓ runtime handling
Agent-facing Observation / Application error
↓ API mapping
Problem DTO
```

Agent 与用户不看到 SQL、SDK object、raw stack、secret；Operations 保留完整 Effect Cause、correlation、Execution/Turn/Invocation references。

## 6A.13 Domain Event 与 Failure

Command terminal rejection 不是 Domain Event，因为 Domain truth 未变化；但它可以是 durable `CommandReceipt(TerminalRejected)`，用于保证同一 logical request 的稳定 resolution。Execution 真正 settle 后产生 `ExecutionSettled`。Domain Event Journal 不是错误日志。

## 6A.14 Error 不直接改变 Work lifecycle

ProviderUnavailable、WorkerCrash、ToolRuntimeFailure、ContextUnsatisfiable、ExecutionFailed 都不能自动将 Work 改为 Cancelled。Work Cancelled 只来自正式治理意图。

## 6A.15 Failure algebra layering

三类 failure 必须分开，且各有归属：

```text
1) DomainError — pure domain transition 的 expected rejection。
   Domain 不得依赖 Application 的任何 rejection 类型。
   DomainError =
     IdempotencyConflict | AuthorityDenied | RevisionConflict | WorkNotOpen |
     TerminalLifecycleMutation | RetirePreconditionFailed |
     ActiveExecutionConflict | VerificationAcceptanceMismatch |
     DependencyNotSatisfiable | PermissionRevoked

2) CommandRejection (Application-owned)
   = CommandResolution.TerminalRejected 的 payload
   = DomainError | FencingRejected | ExecutionStopping
     - FencingRejected: ownership/fence 无效。
     - ExecutionStopping: fence 仍有效，但 stopRequestedAt != null，
       禁止新的 execution-originated mutation。
       (ExecutionStopRequested 仍是既有 Domain Event / stop-request fact
        名称，不新增 DomainError tag。)

3) OperationalFailure — 非 authoritative、非 terminal；不进入
   CommandResolution；不冻结为顶层单一 closed union，由 owning layer
   按 phase 细化（如 PersistenceUnavailable / transport / transient）。
```

`CommandResolution` 是参数化 ADT：

```text
CommandResolution<Result, Rejection> =
    Committed(Result)
  | TerminalRejected(Rejection)

Domain 内部：CommandResolution<R, DomainError>
Application boundary：CommandResolution<R, CommandRejection>
```

规则：

```text
FencingRejected 属于 Application CommandRejection，不是 DomainError。
OperationalFailure 不产生 authoritative resolution，可 retry。
```

---

# 7. DID-7 — Ports / Runtime Interfaces

## 7.1 Port 原则

Port 在实现层正式建模为 Effect service；`R` channel 是依赖契约的一部分，而不是隐藏实现细节。Port 只用于隔离：

> 调用方需要一种能力，但不应该知道能力如何实现。

确定性领域逻辑如 `AuthorityEvaluator`、`RunnableEvaluator`、`DeadlockAnalyzer` 不因为“像服务”就必须成为 Infrastructure Port。

## 7.2 Port Catalog

### Persistence

```text
ProjectRepository
WorkspaceRepository
WorkRepository
ExecutionRepository
SessionRepository
VerificationRepository
DependencyRepository
DeliverableRepository
AcceptanceRepository
DecisionRepository
PermissionGrantRepository
ResourceOwnershipRepository
ArtifactMetadataRepository
MessageStore
CommandStore
TransactionPort
DomainEventJournal
```

### Runtime / External capability

```text
ProviderPort
ToolRuntimePort
ProjectEnvironmentPort
SandboxPort
WorkerDispatchPort
BlobStorePort
KnowledgeQueryPort
KnowledgeStorePort
ProjectionQueryPort
ModelCapabilityPort
AgentContextSourcePort
ToolCatalogPort
SecretStorePort
Clock
IdGenerator
```

## 7.3 Repository API follows Invariants, not CRUD

明确禁止通用：

```text
Repository<T> {
  findById
  save
  delete
}
```

关键 Repository 直接编码并发语义。

`ExecutionRepository` 示例：

```text
tryAdmitMainExecution(...)
tryAcquireLease(executionId, workerId)
renewLease(executionId, workerId, generation, expiry)
settleIfCurrentLease(...)
findExpiredActiveExecutions(...)
findUnsettledExecutions(...)
```

Execution admission 与 lease acquisition 分开，满足：

```text
Durable Admission
↓
Worker Dispatch
↓
Lease Acquisition
```

## 7.4 TransactionPort 与 transaction propagation

Semantic Command 的权威 resolution 必须建立在一个 transaction scope 上。语义合同：

```text
TransactionPort
creates ONE semantic transaction scope

within that scope:
  all participating Repository reads/writes
  authoritative fencing validation
  Command resolution
  DomainEventJournal append

observe/write through
the same transactional database session
```

因此禁止：

```text
TransactionPort.transact(...)
  ├── WorkspaceRepository → connection A
  ├── WorkRepository      → connection B
  └── DomainEventJournal  → connection C
```

即使 API 表面被 `transact()` 包裹，只要各 Repository 自行取得独立 connection，就不满足 Arbor transaction semantics。

具体实现可以选择：

```text
TransactionScope service
fiber-local transaction context
adapter-managed scoped connection
```

v1.2 不冻结具体机制，只冻结“一个 semantic command = 一个共享事务数据库会话”的可观察保证。

### Successful mutation

```text
BEGIN
→ load/register logical Command
→ validate authoritative fence if ExecutionOrigin
→ load canonical state
→ authority / preconditions / invariants
→ apply domain transition
→ write canonical state
→ resolve Command = Committed
→ append Domain Events
COMMIT
```

Canonical state、Committed Receipt 与 Domain Events 原子提交。

### Terminal rejection

若 authority/precondition/revision/fencing evaluation 得到 terminal semantic rejection：

```text
BEGIN
→ read consistent canonical state
→ evaluate terminal rejection
→ resolve Command = TerminalRejected
COMMIT
```

不产生 Domain Event，但同一 `CommandId + semanticRequestFingerprint` 后续 retry 必须稳定返回该 Receipt。

### Retryable operational failure

若失败发生在 logical request 尚未被 authoritative resolve 的 operational layer：

```text
ROLLBACK semantic transaction
→ no authoritative CommandReceipt is committed
→ record CommandAttempt outcome
→ bounded retry may create next attempt
```

并发重复 attempt 最终只能有一个 authoritative resolution；其它 attempt 必须在提交前/提交冲突后重新读取 `CommandReceipt`。


## 7.5 ProviderPort

AgentRuntime 只看：

```text
ProviderPort.runTurn(
  PortableModelRequest,
  ProviderExecutionContext
)
→ Stream<CanonicalProviderEvent>
```

ProviderRuntime 负责：transport、auth、stream、timeout、safe retry、protocol normalization、usage extraction。

Model Context 负责 semantic compilation；ProviderRuntime 不重写 Arbor instruction 语义。

## 7.6 ToolCatalogPort 与 ToolRuntimePort

Tool metadata 与 Tool invocation ownership 分离。

### ToolCatalogPort

Model Context 只需要当前可见 action vocabulary 的 metadata：

```text
ToolDefinition
Schema
model-facing description
capability metadata
SideEffectSemantics
version/hash
```

因此通过 `ToolCatalogPort` 查询，不依赖 `tool-runtime` implementation。

### ToolRuntimePort

AgentRuntime 只看：

```text
invoke(ToolIntent, ToolExecutionContext)
→ CanonicalToolObservation
```

ToolRuntime 内部负责：

```text
Resource resolution
Authority / Permission re-check
Admission
Sandbox
Invocation persistence
Executor
Settlement
Observation normalization
```

`ToolCatalogPort` 决定“有哪些定义可以被 ModelContext 选择”；ModelContext 决定某个 Turn 暴露哪些 Tool；ToolRuntime 决定实际 invocation 是否被授权。

```text
Catalogued Tool
!= Visible Tool
!= Authorized Tool Invocation
```

组织性 Command 不伪装成任意 Tool side effect；需要改变 Canonical Domain truth 的 AgentDirective 继续通过 CommandGateway/Application。


## 7.7 Effect Service / Layer Contract

所有 Runtime / Infrastructure Port 使用 Effect service 暴露；具体实现通过 `Layer` 提供。规则：

```text
Port API
    must expose semantic A/E
    must not expose adapter implementation dependency

Live Layer
    may require SqlClient / fs / SDK / config / secret store
    resolves implementation dependencies during construction
```

因此：

```text
ModelContext.prepareTurn
```

的 `R` 应只出现 `AgentContextSourcePort | KnowledgeQueryPort | ModelCapabilityPort | ...`，不能出现 SQLite client 或具体 Provider SDK。

同理，一个 Application command handler 的 `R` 只包含该 command 实际使用的 repositories/transaction/clock/event services，不允许为了方便统一扩大成 `ArborServices`。

`E` 与 `R` 都纳入 architecture review：

```text
implementation-specific E → abstraction leak
unexpected concrete R     → dependency leak
```

## 7.8 Blob / Artifact 分离

`BlobStorePort` 只负责内容字节：

```text
put
get
stream
```

`ArtifactMetadataRepository` 负责 Control DB metadata。`ArtifactService` 在内部协调二者，避免 `artifact-local` adapter 直接访问 SQLite。

## 7.9 SecretStorePort

Project Policy、ResponsibilityBoundAgentBinding / ExecutionBoundAgentBinding、EnvironmentRef 中只保存 `SecretRef`，不保存明文 credential。

Provider/Tool Runtime 在执行边界通过 `SecretStorePort` 解析 credential；Agent 默认不看到 raw secret。

---

# 8. DID-7A — Model Context Control Plane

## 8.1 定位

Arbor 不把 Prompt 视为几个字符串模板，而把模型可见上下文作为独立控制平面：

```text
Model Context = Agent Control Plane
```

Agent 行为由以下共同决定：

```text
Model
+ Instruction Programs
+ Context Projection
+ Tool Surface
+ Skills
+ Output Contract
+ Runtime Constraints
```

`AgentRuntime` 是执行该控制平面的 Loop Orchestrator，而不是 Prompt/Context/Tool Policy 的 God Service。

## 8.2 Model Turn Pipeline

```text
Execution
↓
Agent Policy Resolution
├── binding
├── responsibility
├── work / mission
├── cognitive mode
├── permission state
├── environment
├── available skills
└── tool surface
↓
Instruction Resolution
↓
Context Planning / Retrieval / Budget
↓
ModelContextPlan
├── Instructions
├── Context
├── Tools
├── Skills
├── Output Contract
└── Continuation
↓
Model-family Compiler
↓
PreparedModelTurn
├── PortableModelRequest
└── ModelContextManifest
↓
ProviderPort
```

`prepareTurn()` 的 `A` 返回：

```text
Ready(PreparedModelTurn)
| NeedsCompaction(CompactionRequest)
| GovernanceBlocked(GovernanceIssue)
```

`ContextUnsatisfiable` 属于 typed `E`，不属于 success/control ADT。并非每一个 Execution step 都需要 LLM 调用。

## 8.3 六类 Model Context Surface

| Surface | 作用 |
|---|---|
| Instruction | 模型应该怎样行为 |
| Context | 模型当前应该知道什么事实 |
| Tool Surface | 当前可见的 action vocabulary |
| Skill | 按需加载的专业工作流 |
| Output Contract | 当前 Turn 可产生哪些结构化结果 |
| Continuation | 如何维持跨 Turn 认知连续性 |

Prompt/Instruction guides；Runtime/Sandbox enforces。

## 8.4 Prompt Program Families

Arbor v1 预置 14 类 Prompt Program：

```text
P1  Base Agent Protocol
P2  Responsibility-bound Agent Protocol
P3  Execution-bound Agent Protocol
P4  Work Execution Program
P5  Responsibility Formation Program
P6  Communication / Coordination Program
P7  Cognitive Mode Programs
P8  Skill Selection / Skill Execution Program
P9  Verification Program
P10 Workspace Bootstrap / Handoff Program
P11 Continuation / Resume Program
P12 Compaction Program
P13 Human Interaction / Steer Program
P14 Query / Inspection Program
```

此外还有 6 类动态 Model Context Surface：

```text
S1 Model-family Instructions
S2 Permission / Sandbox Instructions
S3 Project / Workspace / Work scoped instructions
S4 Tool Definitions
S5 Environment Context
S6 User / Parent current input
```

## 8.4A Information Trust Metadata

所有可进入 Model Context 或 Memory Candidate 的 fragment 都保留正交元数据：

```text
provenanceKind:
  CanonicalInternal | AuthenticatedHuman | AuthenticatedAgent |
  ToolObservation | ExternalRetrieved | ImportedArtifact | ModelDerived

instructionCapability:
  CanonicalInstruction | InstructionCandidate | DataOnly

epistemicStatus:
  Established | Supported | Unverified | Conflicting | Derived
```

Runtime 编译出的 canonical governance/control 才能标为 `CanonicalInstruction`。ExternalRetrieved、ToolObservation、ImportedArtifact、普通 Child Message 与 ModelDerived 默认 `DataOnly`；它们的文本不能自行提升 authority。Memory promotion 必须保留 Provenance，并通过 persistence-eligibility/merge policy；模型文本中的“请永久记住”不构成持久化授权。

## 8.5 InstructionFragment

Instruction 不是 `{id, text}`，而是结构化资产：

```text
InstructionFragment
├── identity / revision / hash
├── semanticKind
├── source
├── scope
├── authorityRole
├── strength: Hard | Soft
├── compositionMode
├── activationCondition
├── lifetime
├── cacheClass
├── budgetClass
├── modelCompatibility
└── contentRef
```

核心原则：

```text
Instruction precedence != prompt text order
```

## 8.6 Authority × Scope × Composition

Authority ladder：

```text
A0 Runtime Safety / System Invariant
A1 Project Governance
A2 Responsibility Governance
A3 Work Governance
A4 Execution Strategy
A5 Skill / Mode Guidance
A6 Advisory / Contextual Guidance
```

解析顺序：

```text
Authority > Specificity > Composition > Text order
```

Composition Mode：

```text
Extend
Specialize
Constrain
ReplaceScope
Advisory
```

`ReplaceScope` 必须针对命名 slot，且 slot 明确声明 `replaceable = true`。Skill/Workspace custom instruction 不允许无意覆盖 Runtime Safety、Responsibility Boundary、Permission Semantics 或 Work Objective。

User text 不自动获得最高 Authority。涉及 Work/Responsibility 改变的自然语言输入必须转成正式 Governance Command 后才成为新的 Canonical instruction source。

## 8.7 Instruction Conflict

Resolver 输出：

```text
ResolvedInstructionSet
├── Effective[]
├── Suppressed[]
├── Conflicts[]
└── GovernanceIssues[]
```

第一版识别：

```text
AuthorityConflict
ScopeConflict
GoalConstraintConflict
CapabilityConflict
ReplacementConflict
```

自然语言语义冲突可以由 LLM 辅助检测；Authority/Capability resolution 由 deterministic Runtime 执行。

## 8.8 Context 分层

Context 正式分七层：

```text
C0 Control Context
C1 Mission / Task Context
C2 Coordination Context
C3 Cognitive Continuity
C4 Evidence / Environment
C5 Retrieved Knowledge
C6 On-demand Modules
```

### C0 Control

每 Turn 从 Canonical State fresh reconstruction：

```text
Base/Binding Protocol
ResponsibilityDefinition
Effective authority / permission
ResourceBoundary
hard Project/Workspace instruction
Output Contract
```

### C1 Mission

```text
Current Work / Mission
Objective
Constraints
CompletionExpectation
VerificationMission summary
Work revision
```

C0/C1 默认 Pinned，不因普通 token pressure 删除。

### C3 Cognitive Continuity

采用：

```text
Checkpoint + Recent Frontier
```

而不是完整 Session History。

## 8.9 Retention Class

Context Fragment 使用：

```text
Pinned
Protected
Compressible
Evictable
```

预算不足时：

```text
evict irrelevant optional
↓
shrink retrieved knowledge
↓
reduce artifact excerpts
↓
compress observations/history
↓
checkpoint / new epoch
↓
never silently drop hard control facts
```

若 Pinned + Protected 本身无法装入模型窗口，返回 `ContextUnsatisfiable`，不静默 truncate。

## 8.10 Budget / Cache

Model Context Budget：

```text
B_ctx = B_model - B_output - B_protocol - B_tools
```

先 reserve output，再规划输入。

Fragment CacheClass：

```text
Stable
SemiStable
TurnDynamic
OnDemand
Synthetic
```

Compiler 尽量保持 Stable Prefix 稳定；Authority 与 physical prompt position 分离。

## 8.11 Skills

Skill 是 On-demand Instruction Module，而不是 Tool。

模型默认只看到：

```text
name
short description
when-to-use
```

使用时再加载 body/reference/script。Skill 不能提升 capability，也不能覆盖更高 Authority instruction。

## 8.12 Cognitive Mode

Mode 属于 Execution cognitive state，而不是 Work lifecycle。

典型通用模式：

```text
Orient
Investigate
Plan
Execute
Diagnose
Integrate
```

Mode 可以影响 Prompt、Context Budget、Tool Surface、Skill hints 与 Output Contract。Agent 可以提出 `ChangeMode`，Runtime 校验 Profile 支持后生效。

## 8.13 Compaction

Compaction 拆为两部分：

### Cognitive Compression

总结：

```text
progress
important findings
failed approaches
open questions
current hypotheses
pending actions
relevant refs
```

### Control Reinjection

从 Canonical State fresh inject：

```text
Responsibility
Current Work
Constraints
Permissions
ResourceBoundary
Dependencies
Project rules
```

因此：

```text
Checkpoint preserves cognition;
Canonical State restores control.
```

Compaction 可以由 token pressure、semantic boundary 或 model/provider boundary 触发，不是简单的“达到 90% 就 summarize”。

## 8.14 Context Progressive Disclosure

Artifact、Skill、Memory、历史报告默认按 metadata/summary/excerpt/reference 进入 Context，需要时再由 Tool 加载更多。

Raw Tool Result：

```text
Raw payload
↓
Artifact/Blob storage
↓
ToolRuntime CanonicalObservation
↓
ModelContext selection/compression
↓
Model-facing Observation
```

如果内容被截断/压缩，必须向模型保留 epistemic status 与原始 ArtifactRef。

## 8.15 Agent Control Loop

Arbor 使用两层 Loop：

```text
Deterministic Execution Control Loop
+
Agentic Goal Pursuit Protocol
```

Agent 每 Turn 产生结构化 `AgentDirective`：

```text
InvokeTool
Communicate
DeclareDependency
RequestGovernance
SpawnSpecialist
ProposeChildWorkspace
LoadSkill
ChangeMode
CompletionClaim
Yield
```

Agent 的核心认知变量是 `OutcomeGap`：

```text
Expected outcome
- currently established evidence
= OutcomeGap
```

Agent 不机械执行原 Plan，而持续选择最能减少关键 OutcomeGap 的高价值 action。

## 8.16 Yield / Durable Wait / Completion / Dependency

`Yield` 不是“暂时停一下”的模糊结果，而是注册 durable waiting condition：

```text
Completed(
  Yielded {
    reason: YieldReason
    waitFor: WaitSpec
  }
)

WaitSpec = { mode: Any, conditions: NonEmptyArray<WakeCondition> }
```

第一版 `WakeCondition` 只允许：

```text
DependencyChanged(id, observedRevision)
DecisionChanged(id, observedRevision)
VerificationChanged(id, observedRevision)
InboxAdvanced(workspaceId, observedSequence)
EnvironmentChanged(environmentRef, observedRevision)
TimeReached(instant)
Manual
```

禁止空 WaitSpec；无限等待人工必须显式使用 `Manual`。SettleExecution(Yielded) 的事务必须同时注册/替换 `WorkWait`，并重新读取所有带 observed revision/sequence 的事实；如果任一事实已经变化，则不得把 Work 永久 park，而应直接进入 runnable reevaluation。`TimeReached` 由 durable Scheduler 恢复，不依赖 Worker 内存 timer。

```text
CompletionClaim
→ Producer 认为 outcome 已充分建立
→ Execution settle = Completed(CompletionClaimed(...))
→ durable ExecutionSettled event
→ deterministic StartVerification Command
→ Work remains Open
```

只有：

```text
Verification PASS
+ Acceptance
+ CompleteWork
```

Work 才 Completed。

`DeclareDependency` 后不一定 Yield；只要还有独立可推进路径，Execution 可以继续。Dependency satisfaction 必须使用 §1.8 冻结的 structural matcher（`producerBinding` + `expectedDeliverable` 对 `DeliverableMatchView`）；Consumer 对“结果虽匹配但仍不足以支撑上层 Work”的判断通过新 Work/Dependency/Steer 表达，不把 deterministic satisfaction 改回语义猜测。

## 8.16A Runtime Safety Envelope

Runtime Safety Envelope 与用户 Cost Budget 分离。机制必须存在、数值阈值可配置/评测：

```text
max transient retries per operation
max repeated identical action fingerprints
max tool recursion / chaining depth
max consecutive turns without durable progress
provider/tool concurrency ceilings
rate / runaway protection
```

触发结果：

```text
Execution → Interrupted(RuntimeSafetyStop(reason))
Work remains Open
Attention emitted
```

禁止 Safety Envelope 自动把 Work 改为 Cancelled。

## 8.17 Long-lived Agent != Long-running Process

Workspace 可以存在数月，但 Worker/Execution 只在有 runnable action 时存在：

```text
Event / Work / Input
↓
Scheduler wakes Workspace
↓
Execution
↓
Agent works to stable boundary
↓
Yield / CompletionClaim / Stop / Failure
↓
release Worker
```

系统不让 Agent 为维持“在线”而不断重复检查。

## 8.18 WakeReason

每次 Workspace Execution 提供 typed `WakeReason`：

```text
WorkSelected
InputArrived
DependencySatisfied
VerificationReturned
HumanIntervention
ChildDelivered
EnvironmentChanged
Recovery
```

Continuation Program 和 Context selection 根据 WakeReason 定制，而不是每次加载最后 N 条消息。

## 8.18A Deterministic Workspace Re-evaluation

Scheduler 每次 reevaluate Workspace：

```text
if Active Main Execution exists:
    do nothing
else:
    classify Current Work and runnable Pending Work
```

规则固定为：

| 条件 | 行为 |
|---|---|
| Current Work Open 且无 active WorkWait | 继续 Current |
| Current Work 有 active WorkWait，其他 runnable=0 | 不 Admit Execution |
| Current Work 有 active WorkWait，其他 runnable=1 | deterministic `SelectCurrentWork(theOne)` |
| Current Work 有 active WorkWait，其他 runnable>1 | Admit `WorkspaceExecution(focus=Coordination)` |
| currentWorkId=None，runnable=0 | idle |
| currentWorkId=None，runnable=1 | deterministic `SelectCurrentWork(theOne)` |
| currentWorkId=None，runnable>1 | Admit Coordination Execution |

Coordination Execution 的语义职责仅是处理多个候选 Work/coordination input，并可以提交 `SelectCurrentWork`。`Yielded` 不携带 suggestedNextWorkId，避免引入第二套隐式 Work-selection 语义。

## 8.19 ModelContext Manifest

每个 Provider Turn 都持久记录一份 Manifest：

```text
ProviderTurnId
ExecutionId
SessionId / Epoch
ModelRef
Instruction fragments + revision/hash/source/scope
Context fragment refs
Skill refs
Tool definition refs/versions
OutputContract ref
Budget decision
CompiledRequestHash
ControlBasis {
  projectPolicyRevision
  workspacePolicyRevision
  responsibilityRevision
  resourceBoundaryRevision
  workId? / workRevision?
  authorizationDigest
  environmentRevision
}
```

Prompt/Context change 是行为代码 change，必须可追踪和可回归。

每个 effectful `AgentDirective` 携带 `decisionBasisManifestId`。Tool/Command admission 根据动作类型声明所需 `FreshnessRequirement`；若相关 Work/Responsibility/Boundary/Policy/Authorization/Environment revision 已变化，则返回 `DecisionStale`，不得执行旧动作，AgentRuntime 必须重新 prepareTurn。Read-only action 可以使用更弱 freshness；写入/破坏性 action 必须校验其相关控制基准。

---

# 9. DID-8 — Persistence Schema

## 9.1 Storage Strategy

Arbor v1 使用 SQLite 作为单一 Canonical Control Plane DB。前提：

```text
Only Arbor Runtime writes Canonical DB.
Workers / Agents / Tools / UI do not open the DB directly.
```

SQLite 使用：

```text
WAL
foreign_keys = ON
short transactions
busy_timeout
optimistic revision / CAS
```

当真正出现多 Runtime 并发写、数据库 HA 或 SQLite write contention 时再迁 PostgreSQL。

SQLite 是 v1 adapter，不是 durability contract。部署必须声明 `DurabilityEnvelope` 与备份/恢复策略：process/worker/runtime/compute-host failure 在 canonical storage 完整时必须可恢复；storage-media/region loss 的能力由配置的 backup/replication 与 RPO/RTO 决定，并通过恢复演练验证。

## 9.2 Control Plane vs Data Plane

```text
Arbor Control Plane
    Project / Workspace / Work / Session / Execution
    Event / Permission / Verification / Command / Metadata

Project Data Plane
    Git / files / datasets / external DB / services
    artifacts / compute / external environment
```

Agent Tool 不得直接访问 Arbor Control DB。

## 9.3 Core Tables

```text
projects
workspaces
workspace_lineage
resource_ownership
works
work_waits
work_acceptances
executions
execution_leases
agent_execution_state
sessions
session_epochs
session_entries
checkpoints
verifications
verification_executions
verification_evidence
dependencies
deliverables
deliverable_artifacts
artifacts
messages
message_consumptions
decisions
permission_grants
memories
commands
command_attempts
domain_events
consumer_offsets
provider_turns
provider_attempts
model_context_manifests
tool_invocations
```

## 9.4 Relational vs JSON Rule

必须关系化：

```text
Identity / FK
Authority relation
transaction invariant
high-frequency filter/join
uniqueness
ordering
recovery / fencing
```

适合 JSON：

```text
ResponsibilityDefinition
VerificationMission
ResponsibilityBoundAgentBinding / ExecutionBoundAgentBinding
Project/Workspace Policy
ExpectedDeliverable
criteria results
structured semantic VO
```

## 9.5 Resource Ownership persistence

`resource_ownership` 持久化的是 resolved ownership claim，而不是未经解析的 path string。至少保存：

```text
workspace_id
resource_space_id
canonical_region
source_resource_address_snapshot/ref
resource_boundary_revision
resolved_at_environment_revision
created_at
```

具体 region 编码可以按 resource kind 使用关系列 + JSON VO，但 overlap evaluation 必须基于 `CanonicalResourceRegion` 的 domain function，而不是 SQL string-prefix 近似。

第一版单 Runtime 使用 `BEGIN IMMEDIATE` 序列化 ownership change transaction，在同一 transaction 内完成 conflict load → overlap evaluation → write。若未来迁 PostgreSQL，可以替换 persistence enforcement 机制，但不能改变 canonical overlap semantics。

## 9.6 Active Main Execution

不存 `is_active` 重复状态，使用 partial unique index 语义：

```text
UNIQUE(workspace_id)
WHERE binding_kind = 'workspace'
  AND settled_at IS NULL
```

保证：

```text
Workspace → at most one active main Execution
```

`executions` 必须 durable 保存 admission-time `session_id`，settle 后保存完整 `ExecutionSettlement` discriminator + semantic result payload/ref。不得只保存 `outcome = Completed` 而丢失 `CompletionClaimed/Yielded/...`。

## 9.7 Lease / Fencing

Lease 独立高频表：

```text
execution_id
worker_id
generation
expires_at
updated_at
```

Worker durable mutation 必须检查 current fencing generation；对 canonical command，该 generation check 与 canonical read/write、Command resolution、Domain Event append 共享同一 transaction/session。事务外 pre-check 不具权威性。

Authoritative fence validation 与 stop/quiescence mutation admission 是**两个独立检查**：

```text
fence validation
  = ownership/generation 是否有效
  = 失败返回 Application CommandRejection.FencingRejected

stop / quiescence admission
  = fence 仍有效，但 stopRequestedAt != null
  = 禁止新的 execution-originated mutation
  = 失败返回 Application CommandRejection.ExecutionStopping
    （ExecutionStopRequested 仍是既有 Domain Event / stop-request fact 名称）

一个 generation 仍然有效的合法 Worker，仅因 stopRequestedAt 被拒绝时，
不得返回 FencingRejected。
```

P1 冻结 persistence hook 与 transaction integration（fence validation +
canonical read/write + receipt + event 同一事务）；P2 负责 lease
acquisition/renewal/loss lifecycle。精确 SQL predicate 在 P1 phase contract 冻结。

## 9.8 Session / Epoch / Entries

Session metadata 与 history 分离。`session_entries` 使用 Session-local sequence，保存有限认知 entry 类型：

```text
Input
ModelOutput
Observation
CheckpointReference
ContextUpdate
```

streaming delta 不直接进入 Session history。

## 9.9 Commands / Events

`commands` 保存 logical request 的 authoritative resolution，而不是只保存成功 mutation：

```text
commands
────────────────────────────
command_id                    PK
project_id
semantic_request_fingerprint
schema_version
fingerprint_algorithm_version
resolution                    Committed | TerminalRejected
result_json?                  // Committed
terminal_error_json?          // TerminalRejected
created_at
settled_at?
```

同一 `command_id` 且 `semantic_request_fingerprint` 不一致 → `IdempotencyConflict`。

Operational attempts 单独记录为非权威 trace：

```text
command_attempts
────────────────────────────
command_id
attempt_no
started_at
settled_at?
outcome                    // Committed | TerminalRejected | RetryableOperationalFailure
failure_kind?
metadata_json?

PRIMARY KEY(command_id, attempt_no)
```

`command_attempts` 是非权威 operational trace，不要求 FK 到 `commands`
（一个 attempt 可能在任何 authoritative resolution 之前发生）。
`attempt_no` 从 0 开始。

`CommandReceipt` 是 `commands.resolution + result/error` 的稳定读取视图，不要求独立 table。

语义：

- `commands` 只持久化 authoritative resolution：`Committed | TerminalRejected`；
- 一个 semantic command 使用**单一事务**完成：
  canonical reads + authority/preconditions + fence validation +
  domain transition + canonical writes + authoritative receipt +
  Domain Events（仅 `Committed`），原子提交；
- 不引入 durable `Pending` 预登记，不引入双事务模型；
- 未 commit 的 operational failure：ROLLBACK → 不产生 authoritative
  resolution → 不写 `commands` row；同一 CommandId 可重试（语义请求不变）；
- 一旦存在 `Committed` / `TerminalRejected` row，same CommandId 重试：
  same fingerprint → 返回既有 Receipt；different fingerprint →
  `IdempotencyConflict`；
- `TerminalRejected` 是 durable command truth，但不产生 Domain Event；
- semantic stale precondition 改 payload 后必须新 CommandId；
- `FencingRejected` / `ExecutionStopping` 对 Execution-originated Command terminal。

`domain_events` 同时承担 durable outbox；多 Consumer 通过 `consumer_offsets` 分别推进，不额外维护单一 outbox delivery flag。


## 9.10 Provider Turn / Model Context

调用模型前 durable：

```text
ProviderTurn intent
+
ModelContextManifest
```

再执行 Provider request。这样 crash 后可以回答本次调用使用了什么模型上下文。

Compaction 也是 Provider Turn 类型的一种，不作为不可见内部 hack。

## 9.11 ProviderTurn / ProviderAttempt

`ProviderTurn` 表示一次逻辑模型决策，绑定唯一 `ModelContextManifest`；transport 层的 safe retry 记录为该 Turn 下的 `provider_attempts`：

```text
provider_attempts
────────────────────────────
provider_turn_id
attempt_no
started_at
settled_at
outcome
provider_error_kind nullable
transport_metadata_json

PRIMARY KEY(provider_turn_id, attempt_no)
```

同一 Turn 的 retry 不产生新的 ModelContextManifest，不增加 Agent `turnNo`。只有新的语义模型决策才创建新的 ProviderTurn。

## 9.12 Tool side-effect metadata

`tool_invocations` 必须保留 ToolDefinition 的 `SideEffectSemantics` snapshot/ref，使 Recovery 在 crash 后能区分 ReadOnly / Idempotent / Reconcilable / NonIdempotent，并据此决定 retry 或 reconciliation。`OutcomeUnknown` 不允许被普通 retry policy 吞掉。

## 9.13 Cyclic Foreign Keys

两个创建环：

```text
Project.rootWorkspaceId ↔ Workspace.projectId
Workspace.primarySessionId ↔ Session.workspaceId
```

优先使用 deferred FK semantics，使 Project + Root Workspace + Primary Session 能在同一事务中建立并在 COMMIT 时统一验证。

---

# 10. DID-9 — Package / Module Architecture

## 10.1 Monorepo Boundary

```text
arbor/
├── apps/
│   ├── daemon/
│   ├── cli/
│   └── web/
├── packages/
│   ├── domain/
│   ├── ports/
│   ├── application/
│   ├── model-context/
│   ├── agent-runtime/
│   ├── execution-runtime/
│   ├── verification-runtime/
│   ├── provider-runtime/
│   ├── tool-runtime/
│   ├── projection-runtime/
│   ├── api-contracts/
│   └── testkit/
├── adapters/
│   ├── persistence-sqlite/
│   ├── blob-local/
│   ├── environment-local/
│   ├── sandbox-local/
│   ├── providers/
│   └── tools/
└── tests/
    └── architecture/
```

Package 只对应真实依赖/替换边界，不采用“一对象一 package”。

## 10.2 Package Responsibility

| Package | 核心职责 |
|---|---|
| `domain` | 什么状态/变化是合法的 |
| `ports` | 系统需要哪些外部能力 |
| `application` | 哪个 Command 如何提交 |
| `model-context` | 模型在当前 Turn 如何理解世界 |
| `agent-runtime` | 执行 Model→Action→Observation loop |
| `execution-runtime` | 谁何时运行、Lease/Fencing/Recovery |
| `verification-runtime` | 组织独立 Agentic Verification |
| `provider-runtime` | 可靠调用模型与协议适配 |
| `tool-runtime` | 实现 Tool invocation authorization/sandbox/settlement；Tool catalog contract 位于 `ports` |
| `projection-runtime` | 将事实转为 Tree/Attention/UI read model |
| `api-contracts` | 外部 API/产品契约 |
| `testkit` | deterministic fake/harness/scenario testing |

## 10.3 Effect Boundary

`domain` 允许 Effect 的纯数据/FP vocabulary，并允许纯 transition 使用 `Effect<A,E,never>` 统一 expected-domain-error composition；Domain 不允许拥有 infrastructure Requirement。

`ports/application/runtime` 使用 Effect service、Layer、Stream、Scope、Schedule、Fiber 等能力。Port 是 Service contract，Adapter 是 Layer/provider implementation。

架构审计同时看三件事：

```text
A 是否暴露正确的成功语义
E 是否只包含该层可处理的 expected typed failure
R 是否只包含精确的 capability/service
```

禁止 global `AppEnv`、`RuntimeContext` 或任何把全部 service 合并成一个 Requirement 的 Service Locator。

## 10.4 Dependency Rules

硬规则：

```text
Domain has no infrastructure dependencies.
Canonical semantic mutation only through Application.
Runtime depends on Ports, not Adapters.
Composition happens only at app boundary.
Projection never participates in authority decisions.
```

禁止 deep import；通过 package `exports` + package dependency declaration + architecture tests 强制 DAG。

### 10.4.1 Allowed internal dependency matrix

以下是 v1.2 冻结的**允许直接依赖**。未列出的 internal edge 默认禁止；`testkit` 与 `apps/*` 作为测试/Composition Root 例外单独管理。

| Package | Allowed direct internal dependencies |
|---|---|
| `domain` | — |
| `ports` | `domain` |
| `application` | `domain`, `ports` |
| `model-context` | `domain`, `ports` |
| `agent-runtime` | `domain`, `ports`, `application`, `model-context` |
| `execution-runtime` | `domain`, `ports`, `application`, `agent-runtime` |
| `verification-runtime` | `domain`, `ports`, `application` |
| `provider-runtime` | `ports` |
| `tool-runtime` | `domain`, `ports` |
| `projection-runtime` | `domain`, `ports` |
| `api-contracts` | `domain` |
| `adapters/*` | `domain`, `ports` |
| `apps/*` | Composition Root；可依赖所需 packages/adapters |
| `testkit` | test-only；可为 scenario/harness 依赖多 package，但 production package 不反向依赖它 |

额外硬规则：

```text
model-context !-> tool-runtime
model-context -> ports/ToolCatalogPort

agent-runtime !-> provider-runtime implementation
agent-runtime -> ports/ProviderPort

agent-runtime !-> tool-runtime implementation
agent-runtime -> ports/ToolRuntimePort

adapters !-> application/runtime
runtime packages !-> adapters
```

如果未来需要新增 edge，必须先证明它不是把 composition concern 或 implementation dependency 向内层泄漏。

Canonical architecture-test location:

```text
tests/architecture/**
```

所有 package-DAG、forbidden-import、exports-boundary 与 requirement-leak 测试都位于该目录。不允许存在第二个 architecture-test root。

## 10.5 API Error Presentation

内部 typed error 在 `api-contracts` 边界映射成稳定的 presentation DTO：

```text
Problem
├── code
├── category
├── message
├── correlationId
├── retryDisposition
└── safeDetails
```

UI/CLI 依赖稳定 `code`，不解析 message 文本。`Problem` 只是外部协议，不允许反向成为内部万能 Error 类型。

## 10.6 AgentRuntime 瘦身

最终 AgentRuntime 只做：

```text
load Execution + AgentExecutionState
↓
ModelContext.prepareTurn()
↓
ProviderPort
↓
ModelContext.decodeTurn()
↓
execute AgentDirective
↓
Observation
↓
continue or settle
```

Prompt composition、Context selection、Tool exposure、Model-family semantic adaptation 不在 AgentRuntime 内实现。

---

# 11. DID-10 — Development Phases

实现不以“Arbor 必须自举开发 Arbor”为硬约束。Self-hosting 只可作为后期 dogfooding / validation 场景。

采用 dependency-driven、risk-first、vertical-slice 方式推进。

## P0 — Functional Domain Kernel

```text
Repository skeleton
Typed IDs
Core ADTs / Value Objects
Project / Workspace / Work / Execution / Session
Verification / Dependency / Deliverable
Domain Errors / Domain Events definitions
Pure authority/policy vocabulary
Invariant tests
Architecture tests
```

没有 SQLite、LLM、Tool、HTTP、CLI。

## P1 — Persistence + Command Core

```text
SQLite schema
TransactionPort
Repositories
Command logical-request / attempt / receipt persistence
DomainEventJournal
CreateProject / Workspace / Work commands
atomic State + Receipt + Event + authoritative fence *validation hook*
(lease acquisition / lease lifecycle 仍属于 P2)
```

## P2 — Execution / Session Kernel

```text
Execution admission
Lease / Fencing
AgentExecutionState
Session / Epoch / Checkpoint
Worker dispatch abstraction
Recovery skeleton
Fake Agent
```

## P3 — Provider + Model Context + Minimal Agent Loop

```text
ProviderPort / ProviderRuntime
ModelCapabilityPort
Model Context v1
Base Agent Protocol
Responsibility-bound Protocol
Work Execution Program
Output Contract
Prompt provenance
real model multi-turn continuity
```

## P4 — Tool Runtime

```text
ToolCatalogPort / Tool definitions
Authority / Permission
ResourceBoundary / ResourceAddress resolution
Sandbox
ToolInvocation persistence
Blob/Artifact service
read / patch / shell minimal tools
```

## P5 — Single-Workspace Vertical Slice

一个长期 Workspace Agent 可以跨多个 Execution、Session continuation、Tool effect、restart 完成 Work 并发出 CompletionClaim。

## P6 — Responsibility Tree / Multi-Workspace

```text
CreateChildWorkspace
Responsibility Formation Prompt
Bootstrap / Handoff
Parent/Child Authority
Communication Protocol
Human Steer
```

## P7 — Dependency / Deliverable Coordination

```text
DeclareDependency
ProduceDeliverable
SatisfyDependency
Wait-for Graph
Deadlock Attention
automatic runnable reevaluation
```

## P8 — Agentic Verification

```text
Execution-bound Verifier
Verification Program Family
Evidence lifecycle
PASS / FAIL / UNKNOWN
Parent Acceptance
Query Agent
```

## P9 — Recovery Hardening

系统化故障注入：

```text
worker crash
daemon crash
provider disconnect
tool outcome unknown
lease expiration
old worker resurrection
dispatch failure
consumer crash
projection rebuild
```

## P10 — Projection / UI

```text
Responsibility Tree
Attention
Workspace Detail
Current Work
Verification
Dependency View
Transcript
Query / Steer / Stop
Usage
```

## P11 — Environment / Git / Advanced Sandbox

```text
worktree/resource isolation
external change detection
impact analysis
environment snapshots
version invalidation
```

## P12 — Production / Extensibility

```text
Plugin SDK
more providers/tools
remote Worker
PostgreSQL migration if justified
observability
security hardening
performance
```

---

# 12. Pre-implementation Closure v1.2

v1.2 的目标不是继续扩张顶层架构，而是关闭那些**现在可以通过推理确定、且会直接影响 P0/P1 接口、一致性与恢复语义**的断点。

## 12.1 C1–C10 Closure Index

| ID | Closure | Status | Canonical owning sections |
|---|---|---|---|
| C1 | ExecutionSettlement: technical outcome + semantic terminal result | **CLOSED** | §3.4, §6A.6 |
| C2 | CommandSubmissionContext + atomic fencing | **CLOSED** | §4.1, §6.3, §7.4 |
| C3 | `prepareTurn()` A/E semantics | **CLOSED** | §6A.10, §8.2 |
| C4 | Command logical request / attempt / receipt | **CLOSED** | §4.1, §6A.5, §9.9 |
| C5 | Shared semantic transaction scope / Repository propagation | **CLOSED** | §7.4 |
| C6 | Execution ↔ Session fixed binding | **CLOSED** | §1.7, §3.4 |
| C7 | Acceptance / Deliverable / Dependency revision binding | **CLOSED** | §1.8, §3.5–3.6 |
| C8 | ResourceAddress / canonical resource ownership algebra | **CLOSED (semantic contract)** | §1.5, §9.5 |
| C9 | Command ↔ Event ↔ Repository ↔ Owner ↔ Invariant + package DAG | **CLOSED (P0/P1 structural level)** | §5, §7, §10, §12.10 |
| C10 | Aggregate exact lifecycle / transition truth tables | **CLOSED** | §12.11 |

`CLOSED` 表示语义与 replacement boundary 已冻结；不等于所有 Phase 的 TypeScript signature、DDL、SQL query、Prompt 正文或性能参数已经提前写死。

## 12.2 C1 — ExecutionSettlement

冻结规则：

```text
ExecutionSettlement is a sum type,
not unrestricted Outcome × Result.
```

合法族：

```text
Completed(CompletedResult)
Interrupted(InterruptedResult)
Failed(ExecutionFailure)
OutcomeUnknown(ReconciliationRequired)
```

`CompletedResult` 至少区分 `Yielded / CompletionClaimed / CoordinationCompleted / QueryCompleted`。Crash recovery 不能从一个裸 `Completed` 猜测下一步。

`CompletionClaimed` 的 durable settlement + `ExecutionSettled` event 足以在 daemon crash 后通过 deterministic `StartVerification` Command replay 恢复后续动作。

## 12.3 C2 — Authenticated submission context + atomic fencing

冻结规则：

```text
CommandEnvelope
= declared domain intent

CommandSubmissionContext
= authenticated execution/system/external origin
```

Execution-originated context 携带 `executionId + fencingGeneration`，且：

```text
fence validation
+ canonical reads
+ canonical writes
+ Command resolution
+ Domain Event append
```

必须共享同一 authoritative semantic transaction。事务外 pre-check 不构成最终授权。

## 12.4 C3 — `prepareTurn()` A/E

```text
A =
Ready
| NeedsCompaction
| GovernanceBlocked

E includes =
ContextUnsatisfiable
+ narrow translated operational failures
```

`NeedsCompaction` / `GovernanceBlocked` 是 control result；`ContextUnsatisfiable` 是 expected typed failure。

## 12.5 C4 — Logical Command / Attempt / Receipt

```text
CommandId
= immutable logical request identity

CommandAttempt
= one operational resolution attempt

CommandReceipt
= authoritative logical request resolution
```

规则：

```text
same CommandId + same semanticRequestFingerprint
→ same logical request

same CommandId + different semanticRequestFingerprint
→ IdempotencyConflict
```

Operational retry 可以复用 CommandId；需要改变 semantic precondition/payload 的 reload-and-re-evaluate 必须新 CommandId。

特别冻结：

```text
explicit expectedRevision mismatch
→ TerminalRejected(RevisionConflict)

FencingRejected
→ terminal for that Execution-originated Command
```

Terminal rejection durable，但不进入 Domain Event Journal。

## 12.6 C5 — Semantic transaction scope

一个 semantic Command 的所有 participating repository 操作共享**同一个 transaction-scoped DB session**。`TransactionPort` 只是语义入口，不能出现“外层 transact + 内部 repo 各拿独立连接”的伪事务。

成功 mutation：

```text
Canonical State
+ Committed Receipt
+ Domain Events
+ authoritative fence decision
→ atomic
```

Terminal semantic rejection：

```text
consistent canonical read
+ TerminalRejected Receipt
→ atomic
```

Retryable operational failure 不产生 authoritative resolution。

## 12.7 C6 — Fixed Execution ↔ Session binding

```text
Workspace main Execution admission
→ snapshot workspace.primarySessionId
→ execution.sessionId immutable
```

`ReplacePrimarySession`：

```text
requires no Active Main Execution
```

replacement 只影响未来 Workspace Execution。异常需要换 Session 时，先停止/settle 当前 Execution，再 replacement，再 admission 新 Execution。

## 12.8 C7 — Revision binding chain

冻结：

```text
Verification.targetWorkRevision

Acceptance {
  workId
  targetWorkRevision
  verificationId
}

Deliverable {
  sourceWorkId
  sourceWorkRevision
}

Dependency satisfaction {
  dependencyId
  targetDependencyRevision
  deliverableId
}
```

Work refine 不删除旧 Verification/Acceptance，但它们不再适用于当前 revision。Dependency contract 改变不能静默重解释旧 satisfaction。

不新增 `OutputContract` Domain Entity。

## 12.9 C8 — Resource ownership algebra

资源语义拆成：

```text
ResponsibilityDefinition
→ ResourceBoundary
→ ResourceAddress
→ Environment resolver
→ CanonicalResourceRegion
→ ResourceOwnershipClaim
```

ownership overlap 定义在 canonical backing resources 上，而不是原始地址字符串上。

第一版至少支持可扩展地址族：

```text
FileTree
GitWorktree
DatabaseNamespace
ExternalResource
```

关键要求是 resolver 能处理不同地址指向相同 backing resource 的 alias。`CanonicalResourceRegion` 具有：

```text
resourceSpaceId
normalizedRegion
```

并定义确定性 `contains / overlaps`。

## 12.10 C9 — Semantic capability ownership audit

以下矩阵是结构审计的最小权威集；具体 payload/signature 仍在对应 Phase 前冻结。

| Capability | Command / mutation path | Durable Event | State / Repository | Owning implementation boundary | Critical invariant |
|---|---|---|---|---|---|
| Project lifecycle | CreateProject / CloseProject | ProjectCreated / ProjectClosed | ProjectRepository | application | one root; closed blocks new autonomous admission |
| Child Workspace | CreateChildWorkspace | WorkspaceCreated | WorkspaceRepository | application | same Project; parent immutable |
| Responsibility | ChangeResponsibility | ResponsibilityChanged | WorkspaceRepository | application | authority + revision |
| Resource boundary / ownership | UpdateResourceBoundary | ResourceBoundaryChanged / ResourceOwnershipChanged | Workspace + ResourceOwnershipRepository | application | canonical write regions do not overlap |
| Primary Session | ReplacePrimarySession | PrimarySessionReplaced | Workspace + SessionRepository | application | no Active Main Execution |
| Work assignment | AssignWork | WorkAssigned | WorkRepository | application | Work belongs to target Workspace |
| Current Work | SelectCurrentWork | CurrentWorkChanged | Workspace + WorkRepository | application | ≤1 current; target Open |
| Work semantic revision | RefineWork / SteerWork | WorkRefined / WorkSteered | WorkRepository | application | canonical requirement change increments revision |
| Work completion | CompleteWork | WorkCompleted | Work + Acceptance + Verification repositories | application | PASS + Acceptance bind current Work revision |
| Work cancellation | CancelWork | WorkCancelled | WorkRepository | application | only Open → Cancelled |
| Dependency | DeclareDependency / SatisfyDependency | DependencyDeclared / DependencySatisfied | DependencyRepository | application | satisfaction binds current dependency revision |
| Deliverable | ProduceDeliverable | DeliverableProduced | DeliverableRepository | application | source Work revision fixed |
| Message | SendMessage | MessageSent | MessageStore | application / communication | durable communication ≠ canonical mutation envelope |
| Verification | Start / RecordEvidence / Conclude | VerificationStarted / VerificationConcluded | VerificationRepository | verification + application | verdict immutable; version-bound |
| Acceptance | AcceptWorkOutcome | WorkOutcomeAccepted | AcceptanceRepository | application | target revision + Verification fixed |
| Permission | Grant / Revoke | PermissionChanged | PermissionGrantRepository | application | cannot exceed policy/ownership ceiling |
| Decision | RecordDecision | DecisionRecorded | DecisionRepository | application | supersede, no in-place history rewrite |
| Execution admission | AdmitExecution | ExecutionAdmitted | ExecutionRepository | application / execution-runtime | ≤1 active main; session fixed |
| Stop request | StopExecution | ExecutionStopRequested | ExecutionRepository | application / execution-runtime | stop ≠ Work cancel |
| Execution settlement | SettleExecution | ExecutionSettled | ExecutionRepository | application / execution-runtime | valid Settlement ADT; settle once |
| Environment fact | RecordEnvironmentChange | EnvironmentChanged | environment/control metadata | application | future behavior invalidation is durable |

另外：

```text
ToolCatalogPort owns tool definition discovery contract.
ToolRuntimePort owns invocation contract.
model-context never imports tool-runtime implementation.
```

Package-level ownership由 §10.4.1 的 allowed-edge matrix 强制。

## 12.11 C10 — Aggregate transition truth tables

这些表只冻结 canonical lifecycle / structural transition。Operational trace、projection 与 derived status 不被伪造为额外生命周期状态。

### Project

| Current | Operation | Preconditions | Next | Notes |
|---|---|---|---|---|
| absent | CreateProject | valid root/bootstrap transaction | Open | creates Project + Root Workspace + Primary Session atomically |
| Open | UpdateProjectPolicy | authority + expected revision | Open | revision++, projectPolicyRevision++ |
| Open | CloseProject | authority | Closed | `ProjectClosed` |
| Closed | lifecycle mutation | — | **illegal** | Closed lifecycle terminal |

`Closed` 后不 admission 新 autonomous Execution；read/recovery/audit 仍允许。

`CreateProject` bootstrap contract（P1 closure）：

```text
- projectId 由 caller 预分配（prj_ + UUIDv7）；CommandEnvelope.projectId 即该值。
- payload 提供 Root Workspace 的 ResponsibilityDefinition /
  ResourceBoundary / ResponsibilityBoundAgentBinding / WorkspacePolicy /
  ProjectPolicy / default configuration / environmentRef。
- rootWorkspaceId 与 primarySessionId 由 caller 预分配。
- 单一事务原子创建 Project + Root Workspace + WorkspacePrimary Session
  （§9.13 deferred FK 在同一 COMMIT 校验）。
- emitted events: ProjectCreated → WorkspaceCreated（同一事务）。
- Primary Session 创建不产生 Domain Event（§5.3 catalog 无 Session event；
  Session 仅通过 workspace.primarySessionId 被引用）。实现阶段不得自行
  新增 Session event。
- authority: bootstrap principal；无 authority → DomainError.AuthorityDenied。
```

### Workspace

Workspace 没有 `Running/Waiting/...` lifecycle。合法 canonical structural mutations：

| Operation | Preconditions | Effect |
|---|---|---|
| CreateChildWorkspace | parent same Project + authority | create child; `parentWorkspaceId` immutable |
| ChangeResponsibility | authority + expected revision | update definition; responsibility revision++ |
| UpdateResourceBoundary | authority + expected revision + ownership overlap check | boundary revision++ + ownership claims atomically update |
| UpdateWorkspacePolicy | authority + expected revision | revision++ + workspacePolicyRevision++ |
| SelectCurrentWork | target Work belongs Workspace + Open; switching cannot conflict with Active Main Execution | change `currentWorkId` only |
| ReplacePrimarySession | target `WorkspacePrimary`; no Active Main Execution | change `primarySessionId`; existing Execution bindings unchanged |
| RetireWorkspace | non-Root + no Active Main Execution/Open Work/Active Child/write ownership/no unresolved incoming Dependency with ProducerBinding = WorkspaceBound(this) or WorkBound(a Work owned by this) (unless resolved/replaced in same governance change) | lifecycle = Retired |

Forbidden ordinary transitions:

```text
ReparentWorkspace
MoveWorkspace
ReactivateRetiredWorkspace
```

### Work

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | AssignWork | valid Workspace + authority | Open |
| Open | RefineWork / semantic SteerWork | authority; producer cannot weaken protected upstream requirements | Open, revision++ |
| Open | CompleteWork | current-revision PASS Verification + current-revision Acceptance | Completed; if current, clear `workspace.currentWorkId` atomically |
| Open | CancelWork | governance authority | Cancelled; if current, clear `workspace.currentWorkId` atomically; request quiescence of focused active Execution |
| Completed | any lifecycle mutation | — | **illegal** |
| Cancelled | any lifecycle mutation | — | **illegal** |

`Current/Pending/Blocked/Verifying/Running` 都是 relation/projection，不进入 Work lifecycle。

### Execution

Canonical lifecycle:

```text
Absent
→ Active(settlement = none)
→ Settled(ExecutionSettlement)
```

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | AdmitExecution | admission invariants; for Workspace main: no other active main | Active |
| Active | StopExecution | authority | Active + stop-request fact |
| Active | SettleExecution | current authority/fence + valid Settlement ADT | Settled |
| Settled | SettleExecution again | — | **illegal / idempotent existing receipt only** |

Lease acquisition/renewal/loss is Runtime ownership state, not another Execution lifecycle state. Worker crash or lease expiry alone does not transition `Active → Settled`.

### Session

Session 不设计业务 lifecycle 状态机：

```text
Session identity = durable
SessionEntry = append-only local sequence
ContextEpoch = monotonic local ordinal
```

- Worker-originated append 需要有效 execution/fence；
- Compaction 创建新 checkpoint/epoch，不改变 canonical business truth；
- Workspace primary replacement 改的是 Workspace pointer，不重写旧 Session；
- already-admitted Execution 继续绑定 admission-time Session。

### Verification

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | StartVerification | Work/revision target valid | Open |
| Open | RecordVerificationEvidence | verifier authority | Open |
| Open | ConcludeVerification(Pass/Fail/Unknown) | mission/evidence record valid | Concluded(verdict) |
| Concluded | mutate verdict | — | **illegal** |

重新验证创建新的 Verification identity。

### Dependency

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | DeclareDependency | valid consumer Work + ProducerBinding + structured ExpectedDeliverable | Unsatisfied |
| Unsatisfied | revise expected contract | authority; not yet terminal | Unsatisfied, DependencyRevision++ |
| Unsatisfied | SatisfyDependency | targetDependencyRevision == current + `matchesExpectedDeliverable(producerBinding, expectedDeliverable, DeliverableMatchView)` returns true | Satisfied |
| Unsatisfied | WithdrawDependency | consumer no longer requires result | Withdrawn |
| Unsatisfied | MarkDependencyUnfulfillable | requirement still needed but current contract cannot be fulfilled | Unfulfillable |
| Satisfied/Withdrawn/Unfulfillable | mutate terminal dependency | — | **illegal** |

Cancel consumer Work deterministically withdraws its remaining Unsatisfied Dependencies。Producer loss 规则完全由 `ProducerBinding` 决定：

```text
WorkBound(W) + W Cancelled
→ Dependency becomes Unfulfillable
  unless already terminal or replacement committed atomically

WorkspaceBound(WS) + WS Retired
→ Dependency becomes Unfulfillable
  unless already terminal or replacement committed atomically

WorkBound(W) where W belongs to a retiring WS
→ same rule

AnyProducer
→ producer Work cancellation / Workspace retirement alone
   does NOT imply Unfulfillable

WorkspaceBound(WS)
→ cancellation of one Work under WS does NOT imply Unfulfillable
```

新 contract 在 terminal dependency 后创建新 Dependency / explicit new requirement，不改写历史。

### PermissionGrant

| Current | Operation | Preconditions | Next |
|---|---|---|---|
| absent | GrantPermission | issuer authority + policy/ownership ceiling | Active |
| Active | RevokePermission | issuer/governance authority | Revoked |
| Revoked | reactivate same grant | — | **illegal** |

时间到期是 effective authorization evaluation，不把历史 Grant 删除；需要重新授予时创建新 grant identity。

### Immutable durable records

以下对象没有可变 lifecycle：

```text
Deliverable      // immutable formal result for source Work revision
Acceptance       // immutable acceptance of target Work revision + Verification
concluded Verification
terminal Dependency record
DomainEvent
```

Decision 使用 explicit supersede link，不原地覆盖历史。

---

# 13. Implementation Readiness & Remaining Phase-scoped Closure

v1.3 已关闭 P0 前必须通过推理确定的 C1–C10 与 X1–X11 cross-cutting contract。剩余问题按 Phase 所有权继续关闭，而不是阻塞所有实现。

| Item | Status | Must close before |
|---|---|---|
| C1–C10 cross-cutting semantics | **CLOSED** | P0 |
| Aggregate/domain ADT + invariant tests | **READY TO IMPLEMENT** | P0 completion |
| Package DAG architecture tests | **READY TO IMPLEMENT** | P0 completion |
| Exact per-Command payload/result/error/event TypeScript contracts | **OPEN, phase-scoped** | P1 command implementation |
| Exact Repository / Port Effect signatures | **OPEN, phase-scoped** | owning package Phase |
| SQLite exact DDL / migration / indexes | **OPEN, P1 BLOCKER** | P1 |
| Resource region physical encoding/query optimization | **OPEN, P1 BLOCKER** | P1 ownership persistence |
| Prompt Program actual text / behavioral eval set | **OPEN, phase-scoped** | P3/P6/P8 |
| Context/compaction numeric defaults | **EMPIRICAL** | tune by eval |
| SQLite performance ceiling | **EMPIRICAL** | real workload decision |

授权状态：

```text
Problem/Goals: frozen
Scenarios: frozen
System Design: frozen
DID top-level architecture: frozen
C1–C10: closed
X1–X11: closed
P0 coding: authorized
P1 coding: after P1-specific exact contracts/DDL close
```

v1.1 的 A1–A11 readiness patches 已经被吸收到正文对应 ownership section，不再保留一份平行补丁清单，避免同一规则存在两个权威位置。

---

# 14. P0 Technical Baseline

## 14.1 冻结技术基线

```text
Node        24.21.0 LTS
TypeScript  7.0.2
Effect      4.0.0-rc.115  (exact pin)
pnpm        12.4.2
Vitest      5.0.1
Biome       2.5.14

Module      ESM only
Build       tsc -b / TypeScript project references
Test        Vitest
Lint        Biome
Format      Biome
Architecture custom Vitest package-DAG tests
DB (P1)     SQLite + Effect SQL sqlite-node adapter
```

Effect v4 仍作为受控 RC dependency：所有 Effect v4 packages 精确 pin 同一 revision，每次升级作为单独变更并跑完整验收，不允许自动漂移。

## 14.2 Monorepo 工具策略

第一阶段不引入：

```text
Turborepo
Nx
Bazel
Prisma / TypeORM
ESLint + Prettier 双栈
Husky / lint-staged
```

原因：pnpm workspace + TS project references + Biome + Vitest 已足以支持 P0/P1；工具复杂度应晚于 Domain/Runtime complexity。

## 14.3 根验收入口

统一命令：

```text
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm architecture
pnpm check
```

其中：

```text
pnpm check = lint + typecheck + architecture + test
```

避免在仓库中制造多套同义 quality gate。

## 14.4 Effect Integration Rules

P0 起即强制：

```text
Effect<A,E,R>
A = success semantics
E = expected typed failure
R = exact service requirements
```

工程规则：

1. Domain transition 可用 `Effect<A,E,never>`，但 Domain 不得获得 infrastructure R；
2. Port 使用 Effect service，Adapter 使用 Layer；
3. Service implementation dependency 由 Layer construction 解决；
4. 禁止 `Effect<A, Error, AppEnv>`、万能 `ArborError`、global Service Locator；
5. typed error 使用稳定 tag/code，调用方窄处理；
6. defect 与 interruption 不塞进 expected E；
7. Adapter-specific error 不越过 semantic boundary；
8. package review 检查 E/R 是否发生抽象泄漏；
9. Effect RC 升级必须作为独立受控变更，不自动漂移。

### 14.4.1 技术基线核对（2026-09-18）

本版重新核对官方来源：

- Effect v4 当前仍为 RC；`effect` main package version 为 `4.0.0-rc.115`，官方推荐 TypeScript 7，并要求 strict type checking；
- TypeScript 7.0 已于 2026-07-08 正式发布；
- Node.js 24.21.0 当前为 LTS；
- pnpm 12.4.2、Vitest 5.0.1、Biome 2.5.14 为当前公开稳定版本。

版本属于“当前实现基线”，不是永久架构 invariant；只有 Effect v4 package compatibility 需要特别严格的同 revision pin。

## 14.5 P0 完成标准

P0 只有在以下条件全部成立时完成：

1. `@arbor/domain` 编译通过；
2. Typed ID 在编译期不能误传；
3. Core Aggregate transition 是纯函数/typed result，并覆盖 §12.11 truth tables；
4. Work terminal lifecycle 无非法逆转；
5. Parent immutable；
6. CurrentWork ≤ 1 的 Domain 语义成立；
7. `ResponsibilityDefinition / ResourceBoundary / ResourceAddress / CanonicalResourceRegion` codecs 与纯 overlap algebra 成立；
8. Verification Verdict ADT 固定为 PASS / FAIL / UNKNOWN；
9. Execution Binding ADT 支持 Work / Coordination 与 `ExecutionBoundAgentBinding`；
10. `ExecutionSettlement` 是合法 sum type，非法 outcome/result 组合在类型层不可构造；
11. `Acceptance / Deliverable / Dependency` revision-binding Value Objects/records 可表达；
12. `CommandId / semanticRequestFingerprint / CommandResolution / CommandAttempt` 基础 ADT 可表达，且 same-id different-fingerprint 被类型/纯逻辑拒绝；
13. 不存在长期 `Agent` Entity / `AgentId`；
14. §10.4.1 package DAG architecture tests 通过；
15. `pnpm check` 全绿。

P0 不要求 SQLite、真实 Provider、真实 Tool 或 HTTP/CLI；C2/C4/C5 的 persistence 原子性在 P1 通过 adapter/integration tests 落实。

---

# 15. Final Architecture Summary

Arbor 的实现架构可以压缩为以下主链：

```text
User / Agent / Runtime
        ↓
     Command
        ↓
 Application
        ↓
Canonical State + Command Receipt + Event Journal
        ↓
Event Consumers / Scheduler
        ↓
Execution Admission
        ↓
Worker + Lease/Fencing
        ↓
AgentRuntime
        ↓
Model Context Control Plane
        ↓
PreparedModelTurn + Manifest
        ↓
ProviderRuntime
        ↓
AgentDirective
    ┌────┼─────────────┬────────────┐
    ↓    ↓             ↓            ↓
  Tool  Message      Command   Cognitive State
    ↓
 Reality / Observation
    ↓
next Turn / ExecutionSettlement
        ↓
CompletionClaimed? → VerificationRuntime
        ↓
PASS / FAIL / UNKNOWN
        ↓
Parent Acceptance
        ↓
CompleteWork
```

最终职责边界：

```text
Effect A/E/R        = success / typed failure / exact capability contract
Domain             = what state/change is legal
Application        = how semantic mutations resolve/commit atomically
ExecutionRuntime   = who runs, when, with what lease/fence
ModelContext       = how the model is allowed to understand this turn
AgentRuntime       = execute the cognitive loop
ProviderRuntime    = reliably call models
ToolCatalog        = tool definition/capability discovery
ToolRuntime        = safely invoke and settle actions on reality
VerificationRuntime= independently judge formal outcomes
Session            = preserve cognition
Projection         = make truth observable
```

核心工程原则：

```text
Effect A/E/R is an architecture contract, not a convenience wrapper.
Expected failure is typed; impossible state is defect; cancellation is interruption.
Workspace is identity; Agent is execution role.
Plan is cognitive; Work is canonical.
Prompt guides; Runtime enforces.
Control is reconstructed; cognition is compressed.
Events notify; Canonical State decides.
Consumers react; Commands mutate.
Settlement preserves semantic terminal result.
Fence validation and canonical mutation are atomic.
Resource ownership compares canonical backing regions.
Long-lived Agent != long-running process.
```

---

# Appendix A — ID Prefix Convention

| Type | Prefix |
|---|---|
| Project | `prj_` |
| Workspace | `ws_` |
| Work | `wrk_` |
| Execution | `exe_` |
| Session | `ses_` |
| Verification | `ver_` |
| Dependency | `dep_` |
| Deliverable | `del_` |
| Message | `msg_` |
| Artifact | `art_` |
| Decision | `dec_` |
| Permission Grant | `pgr_` |
| Acceptance | `acc_` |
| Evidence | `evd_` |
| Memory | `mem_` |
| Command | `cmd_` |
| Event | `evt_` |
| Provider Turn | `ptn_` |
| Tool Invocation | `tin_` |
| Worker | `wkr_` |

---

# Appendix B — Runtime Interface Snapshot

```text
Application (Effect services)
├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
│     (uses the Persistence ports below)

Persistence ports (§7.2)
├── TransactionPort
├── CommandStore / Receipt
└── DomainEventJournal

ExecutionRuntime
├── ExecutionRepository
├── WorkerDispatchPort
├── Lease/Fencing services
└── Clock

ModelContext
├── AgentContextSourcePort
├── KnowledgeQueryPort
├── ModelCapabilityPort
├── Skill Registry
└── ToolCatalogPort

AgentRuntime
├── ModelContext
├── ProviderPort
├── ToolRuntimePort
├── SessionRepository
└── CommandGateway

ToolRuntime
├── ToolCatalogPort (definition source is separate from invocation)
├── ProjectEnvironmentPort
├── SandboxPort
├── SecretStorePort
├── ToolInvocationStore
└── Blob/Artifact Service

ProjectionRuntime
├── DomainEventJournal reader
├── Projection Store
└── ProjectionQueryPort

Composition Root
└── Layer graph resolves all live adapters/services
```

---

# Appendix C — Design Freeze Status

```text
Problem Definition & Goals v1.2           FROZEN
Scenarios S1–S4 v1.2                      FROZEN / COMPLETE
System Design Specification v1.3          FROZEN
Detailed Implementation Design v1.4      TOP-LEVEL FROZEN
Model Context Control Plane               INCLUDED / TOP-LEVEL FROZEN
Effect A/E/R + Service/Layer Contract     CLOSED
Error Algebra + Failure Semantics         CLOSED
C1–C10 + X1–X11 Closure                  CLOSED
P0 Technical Baseline                     FROZEN (versioned baseline)
P0 coding authorization                   AUTHORIZED
P1 coding authorization                   AFTER P1 exact contracts / DDL closure
```

任何后续架构修改必须先落到拥有该语义的文档，并说明：

1. 哪个现有 invariant / scenario 无法实现；
2. 失败证据是什么；
3. 为什么不能通过现有对象/接口的局部细化解决；
4. 对 Domain、Persistence、Model Context、Runtime、Package DAG 和 Recovery 的影响。
