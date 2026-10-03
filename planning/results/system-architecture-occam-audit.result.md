# Arbor System Architecture Occam Audit

**Date:** 2026-10-03
**Status:** COMPLETE — governance action required
**Scope:** frozen design chain, current domain/runtime/application boundaries, production tool
surface, SQLite schema, Effect contracts, end-to-end user closure.

## 1. Verdict

Arbor 的核心命题成立：

```text
Workspace = long-lived responsibility
Work      = durable outcome contract
Execution = recoverable runtime episode
```

Model semantic judgment 与 Runtime authoritative enforcement 的分工也成立。Command/Event、
Lease/Fencing、Provider/Tool Runtime、Context provenance、Verification/Acceptance 分离均有
独立存在理由。

但当前完整系统不满足全局自洽和奥卡姆剃刀：内部运行概念被抬升为领域/产品概念，近似
机制重复实现，而最短用户价值链仍有多个不可达断点。`SYSTEM IMPLEMENTATION COMPLETE`
只能解释为既有 phase contract 的机械完成，不能解释为产品闭环完成。

## 2. Mechanical baseline

`pnpm check` on 2026-10-03:

```text
Biome              868 files PASS
Architecture        27 files / 147 tests PASS
Core               293 files / 1650 passed / 1 skipped
Web                  31 files / 216 tests PASS
Web build           PASS; one >500KB chunk warning
```

Live SQLite schema:

```text
user_version = 30
tables       = 51
indexes      = 33
```

The green baseline is real but insufficient: several architecture tests prove source markers
and package edges, not the user-visible goal-to-result closure.

## 3. Findings

### O-1 — Agent vocabulary contradicts its identity model

Design says Agent is a runtime role and no `AgentId` exists, while other sections describe a
long-lived Agent as if it were the durable responsible identity. Durable identity actually comes
from Workspace + Responsibility + Binding + cognition. This ambiguity leaks into Workspace,
Session and Specialist discussions.

### O-2 — Plan is correctly progress-only but placed in Domain

`WorkPlan` is model-maintained cognition, has no authority, and cannot schedule, execute, verify,
accept or complete Work. Persisting it by Work is correct; placing it in the core Domain vocabulary
is not. It belongs to Workspace-local cognition / Agent Runtime state.

### O-3 — Specialist has no distinct domain semantics

The only unique value of Specialist is temporary parallel model execution inside one WorkEpisode.
It owns no Responsibility, Work, acceptance or long-term knowledge. It should be an optional
`spawn_agent` runtime action backed by child Execution, not a first-class domain/product concept.
The current implementation also exposes no executable tools to ExecutionBoundSpecialist.

### O-4 — Workspace Memory is claimed but not implemented

`MemoryId` and a declared `KnowledgeQueryPort` exist, but no production Knowledge layer, Memory
store or retrieval Layer is wired. The port explicitly states that no production Layer provisions
it. Primary Session currently compensates for the missing Workspace Knowledge boundary, increasing
context filtering and compaction complexity.

### O-5 — Root natural-language goal cannot start Work

RootConversation exposes `propose_workspace` only. A normal bounded goal cannot become a formal
Work through the main product conversation. This is RGI-DG-01.

### O-6 — Automatic quality closure stops before Parent Acceptance

`AcceptWorkOutcome` exists as an Application command and Web human form, but the current Agent
control surface has no parent acceptance action. Child Verification PASS therefore does not provide
the intended autonomous Parent integration path.

### O-7 — Dependency can be declared without an agent delivery path

The model can call `declare_dependency`; it cannot call `ProduceDeliverable` or `Deliver` through
the current AgentAction catalog. The persistence and command model exists, but a real agent cannot
complete the formal dependency lifecycle through the new control surface.

### O-8 — Formation approval lacks fulfillment truth

Formation governance records `Pending | Approved | Rejected`; the asynchronous
`CreateChildWorkspace → AssignWork` consumer has no durable product-facing fulfillment projection.
`Approved` can therefore be mistaken for applied. The consumer also uses untyped errors and
`console.error` for important failure paths.

### O-9 — Executable/control approval is duplicated

Executable tools and internal controls need different handlers, but the model sees both as tool
calls. `invocation_approvals` and `control_action_approvals` duplicate an exact-intent approval
lifecycle. A shared authorization/approval envelope can preserve route-specific execution without
duplicating the ledger.

### O-10 — Effect contracts are not consistently exact

An audit found 47 production signatures containing `unknown` in Effect types. Some are intentional
unknown success payloads; several core consumer/projection error channels are genuinely untyped.
Normal operational failures are also converted with `orDie` or logged and skipped. This violates
the stated typed-failure architecture in the paths where recovery most needs classification.

### O-11 — Active runtime retains too much historical compatibility

Legacy directives, legacy messages, legacy provider evidence and ambiguous episode branches remain
inside active runtime packages. Historical evidence must remain readable, but compatibility should
be isolated behind migration/archive adapters rather than participating in new-turn decision code.

### O-12 — Module boundaries exist, but several modules are internal monoliths

Representative production file sizes:

```text
control-actions.ts          1447
provider-runtime/runtime.ts 1352
model-decision.ts           1244
agent-loop-actions.ts       1027
authority-resolver.ts        873
composition.ts               741
production.ts                737
```

Package DAG discipline is strong; capability cohesion inside several packages is not.

## 4. Occam disposition

### Preserve

Project, Workspace, Responsibility, Work, Execution, Artifact, Verification, Acceptance,
Permission, Command/Event Journal, Lease/Fence, Provider Runtime, Tool Runtime, provenance-aware
Model Context.

### Internalize

Session, Local Plan, Inbox, Message transport, ProviderTurn, ProviderAttempt, AgentLoopStep,
ConversationResponseJob/Attempt, projections and consumer offsets.

### Remove as first-class concepts

Specialist. Temporary parallel reasoning becomes an optional Agent Runtime `spawn_agent` action.

### Merge

Model-facing action registration/authorization and the duplicate exact-intent approval ledgers.
Internal handler categories remain distinct.

### Complete before extension

Root Work initiation, single-Workspace goal-to-completion golden path, Parent Acceptance,
Workspace Knowledge truth, typed asynchronous fulfillment/error handling.

### Defer

Subagent parallelism and full Dependency/Deliverable automation until the minimum golden path is
proven with a real provider and restart/replay.

## 5. Required governance consequence

Do not implement the current RGI or SDO drafts independently. First accept or reject a minimal
architecture convergence decision that establishes the reduced vocabulary and execution order.

Proposed decision:
`planning/proposals/minimal-architecture-convergence-decision-draft.md`.
