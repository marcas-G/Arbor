# P2 — 05 Scheduler / Wait / Wake

**Authority:** DID v1.7 §8.16, §8.16A, §8.17, §8.18, §8.18A; DID v1.7 G3/G4.
**Status:** DRAFT (first draft for gap review).

## 1. Scope (freezes DID v1.7 G3)

```text
P2 owns:
  ExecutionScheduler
  durable WorkWait registration / clear
  timer / wake mechanics
  lost-wake-up protection

Source phases own:
  wake-signal production (DependencyChanged / InboxAdvanced /
  VerificationChanged / EnvironmentChanged / DecisionChanged / …)

P7 owns:
  full Work runnability / dependency reevaluation
  Wait-for graph / deadlock attention
```

P2 implements the deterministic decision table over a `RunnableWorkSource`
port (`02` §7) and ships a deterministic stub; P7 ships the real source. P2
adds no runnable semantics.

## 2. WaitSpec / WakeCondition

```ts
interface WaitSpec {
  readonly mode: "Any";
  readonly conditions: ReadonlyArray<WakeCondition>;   // non-empty
}

type WakeCondition =
  | { readonly _tag: "DependencyChanged"; dependencyId: DependencyId;
      readonly observedRevision: Revision }
  | { readonly _tag: "DecisionChanged"; decisionId: DecisionId;
      readonly observedRevision: Revision }
  | { readonly _tag: "VerificationChanged"; verificationId: VerificationId;
      readonly observedRevision: Revision }
  | { readonly _tag: "InboxAdvanced"; workspaceId: WorkspaceId;
      readonly observedSequence: number }
  | { readonly _tag: "EnvironmentChanged"; environmentRef: string;
      readonly observedRevision: string }
  | { readonly _tag: "TimeReached"; instant: string }
  | { readonly _tag: "Manual" };
```

- Empty `WaitSpec` is forbidden; unbounded human wait must be explicit
  `Manual` (DID §8.16).
- `Yielded` never carries a `suggestedNextWorkId` (DID §8.18A).

## 3. WakeReason

```ts
type WakeReason =
  | { readonly _tag: "WorkSelected" }
  | { readonly _tag: "InputArrived" }
  | { readonly _tag: "DependencySatisfied" }
  | { readonly _tag: "VerificationReturned" }
  | { readonly _tag: "HumanIntervention" }
  | { readonly _tag: "ChildDelivered" }
  | { readonly _tag: "EnvironmentChanged" }
  | { readonly _tag: "Recovery" };
```

Every Workspace Execution carries a typed `WakeReason`; the continuation
program/context selection is customized by it (DID §8.18).

## 4. Deterministic re-evaluation

```text
reevaluate(workspaceId, wakeReason):
  if an Active Main Execution exists for the workspace: Noop(ActiveMainExecution)
  else:
    { current, runnable } = RunnableWorkSource.classify(workspaceId)
    apply the table below
```

| Condition | Decision |
|---|---|
| `current` Open and no active `WorkWait` | `Admit { focus: Work(current) }` |
| `current` has active `WorkWait`, runnable = 0 | `Idle` |
| `current` has active `WorkWait`, runnable = 1 | `SelectCurrentWork(theOne)` |
| `current` has active `WorkWait`, runnable > 1 | `Admit { focus: Coordination }` |
| `current` = None, runnable = 0 | `Idle` |
| `current` = None, runnable = 1 | `SelectCurrentWork(theOne)` |
| `current` = None, runnable > 1 | `Admit { focus: Coordination }` |

- The decision is computed by the Scheduler (deterministic Runtime, not an
  LLM planner, SD §7.6).
- `Admit` uses the Workspace `primarySessionId` snapshot and a
  caller-preallocated `executionId`; the Scheduler does not write canonical
  state directly — it issues `AdmitExecution` / `SelectCurrentWork` commands.
- `SelectCurrentWork` is a Work/Governance command (`workspace.currentWorkId`
  + `CurrentWorkChanged`); its authority is governance, not a runtime fact. P2
  computes the deterministic decision but does **not** execute it — execution
  belongs to the Work-governance phase (P6/P7). P2 adds no governance command.

## 5. Durable WorkWait registration / lost-wake-up protection

`SettleExecution(Completed(Yielded))` registers/replaces the `WorkWait` in the
**same transaction** as the settlement (DID §8.16):

```text
transact {
  write ExecutionSettled receipt + event
  register/replace work_waits row (WaitSpec)
  re-read every observed revision/sequence referenced by the conditions
}
COMMIT
```

- If any observed fact already differs from the recorded `observedRevision` /
  `observedSequence` at registration time, the Work must **not** be parked:
  the settlement still commits, but the Scheduler is signalled to re-evaluate
  the Workspace immediately (the `WorkWait` is cleared / a wake is enqueued).
- Lost-wake-up protection: registration and the observed-fact re-read share one
  transaction; a wake signal produced by a source phase writes its
  revision/sequence in its own transaction, so the signal either is seen by the
  re-read or lands after registration and will be delivered by the wake path.
- `clearWorkWait(workId)` runs in the transaction that consumes the wake (the
  re-evaluation / next admission), never as a fire-and-forget side effect.

## 6. Timer / wake mechanics

- `WakeCondition.TimeReached` persists a `scheduler_timers` row (`04` §3.6);
  no Worker in-memory timer is authoritative.
- `dueTimers(now)` returns due rows; firing enqueues a wake with the owning
  Workspace and clears the timer row in the same transaction.
- A wake with no runnable work produces `Idle` and no model call (SD §5.2:
  `No runnable work → no model call`).
- Wake delivery is at-least-once; re-delivery re-runs `reevaluate`, which is
  idempotent given the current canonical state.

## 7. ExecutionDriver / Runtime Safety boundary (freezes DID v1.7 G4)

After a durable admission + lease acquisition, the P2 ExecutionRuntime invokes
the driver:

```text
admit durable Execution
↓
dispatch Worker (WorkerDispatchPort)
↓
acquire lease (LeaseService)
↓
ExecutionDriverPort.drive(execution, agentExecutionState, wakeReason, context, safetyGate)
↓
driver returns an ExecutionSettlement proposal
↓
persist via SettleExecution (ExecutionOrigin, fenced)
```

- At every new ProviderTurn / ToolInvocation / Specialist action boundary the
  driver **must** call `RuntimeSafetyGate.admitActivity` and obtain
  `Continue`/`Stop` (DID v1.7 G4).
- `Stop` → the driver returns
  `Interrupted(RuntimeSafetyStop(reason))`; Work remains Open; Attention is
  emitted. Safety never auto-cancels Work (DID §8.16A).
- P2 owns the gate and its execution-wide counters; P3 owns the real loop and
  only reports activity. The exact gate Port shape is `02` §5.
- P2 ships `FakeDriver` (deterministic settlement) so the kernel is testable
  without a Provider (DID §11 P2).

## 8. Single-flight / concurrency

- `reevaluate` is single-flight per `workspaceId`; concurrent schedulers rely
  on `BEGIN IMMEDIATE` + the partial unique index on active main Execution
  (`04` §3.1). A losing admission yields `ActiveExecutionConflict`, after which
  the Scheduler re-reads and becomes `Noop`.
- Wake delivery and dispatch are at-least-once; duplicate wakes converge to the
  same decision.
- No distributed scheduler in P2; a single control-plane process owns the
  Scheduler.

## 9. Out of scope

- Real runnable/dependency graph and deadlock attention (P7).
- Inbox persistence / promotion (P5/P7); P2 only consumes `InboxAdvanced`
  signals produced by the source phase.
- Projection rebuild scheduling (P10).
- Distributed / multi-process scheduling (P12).
