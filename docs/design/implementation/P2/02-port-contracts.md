# P2 — 02 Port Contracts

**Authority:** DID v1.7 §1.7, §3.4, §6.3, §7.1–§7.4, §8.16, §8.16A, §8.18A,
§9.6–§9.8, §12.3, §12.6; DID v1.7 G3/G4/G5.
**Status:** DRAFT (first draft for gap review).

Ports are Effect services; adapters are Layers. All P2 persistence methods
**require `TransactionScope`** and never open their own connection. No generic
CRUD. Owning package: **`ports`** for contracts; adapters implement.

## 1. Effect channel rules (inherited)

```text
Repository / store method:
  A = typed result (ADT / Option where absence is normal)
  E = <Name>Error (narrow, per-port; no universal RepositoryError)
  R = TransactionScope
TransactionPort.transact adds TransactionOperationalFailure.
Adapter errors never appear in a port E.
```

P2 adds port errors to `ports`:

```text
ExecutionRepositoryError, WorkerDispatchError, ExecutionDriverError,
ExecutionSchedulerError, WorkWaitStoreError, SchedulerTimerStoreError,
RunnableWorkSourceError, LeaseFencingRejected
```

## 2. ExecutionRepository

```ts
interface ExecutionRepositoryService {
  tryAdmitMainExecution(execution: Execution):
    Effect<Option<Execution>, ExecutionRepositoryError, TransactionScope>;
    // None = another active main exists (partial unique) -> ActiveExecutionConflict
  admitExecution(execution: Execution):
    Effect<void, ExecutionRepositoryError, TransactionScope>;
    // ExecutionBound; no one-active-main constraint
  findById(executionId):
    Effect<Option<Execution>, ExecutionRepositoryError, TransactionScope>;
  findActiveMainByWorkspace(workspaceId):
    Effect<Option<Execution>, ExecutionRepositoryError, TransactionScope>;
  requestStop(executionId, stopRequestedAt):
    Effect<void, ExecutionRepositoryError, TransactionScope>;
    // idempotent: only sets when stop_requested_at IS NULL
  settle(executionId, settlement, settledAt):
    Effect<void, ExecutionRepositoryError, TransactionScope>;
    // settle-once CAS: UPDATE ... WHERE settled_at IS NULL
  currentLease(executionId):
    Effect<Option<LeaseRecord>, ExecutionRepositoryError, TransactionScope>;
  tryAcquireLease(executionId, workerId, generation, expiresAt):
    Effect<boolean, ExecutionRepositoryError, TransactionScope>;
    // true only when no live lease exists (or previous expired); CAS
  renewLease(executionId, workerId, generation, expiresAt):
    Effect<boolean, ExecutionRepositoryError, TransactionScope>;
    // CAS WHERE worker_id = ? AND generation = ?
  releaseLease(executionId, workerId, generation):
    Effect<void, ExecutionRepositoryError, TransactionScope>;
  findExpiredActiveExecutions(now):
    Effect<ReadonlyArray<Execution>, ExecutionRepositoryError, TransactionScope>;
  findUnsettledExecutions():
    Effect<ReadonlyArray<Execution>, ExecutionRepositoryError, TransactionScope>;
}
```

`LeaseRecord = { executionId, workerId, generation, expiresAt, updatedAt }`.

Admission and lease acquisition are separate (DID §3.4 / §7.3):
`Admit durable Execution → Dispatch Worker → Worker acquires lease`.

## 3. SessionRepository.appendEntry (P2)

P1 `SessionRepository` is extended with an operational append. Worker-
originated append is a fenced durable write (DID §6.3): when `fence` is
present, the authoritative generation check shares the append's transaction.

```ts
interface SessionRepositoryService {
  // ... P1 methods (findById, create) ...
  appendEntry(
    sessionId: SessionId,
    entry: { readonly entryKind: SessionEntryKind; readonly payload: unknown },
    fence?: { readonly executionId: ExecutionId;
              readonly fencingGeneration: LeaseGeneration },
  ): Effect<{ readonly sequence: number },
             SessionRepositoryError | LeaseFencingRejected,
             TransactionScope>;
}

type SessionEntryKind =
  | "Input" | "ModelOutput" | "Observation"
  | "CheckpointReference" | "ContextUpdate";
```

- `sequence` is the Session-local sequence allocated by the store
  (`MAX(sequence)+1`), serialized by `BEGIN IMMEDIATE`.
- Streaming deltas never enter Session history (DID §9.8).
- `LeaseFencingRejected = { _tag: "LeaseFencingRejected"; executionId;
  generation }` — the runtime-local counterpart of `FencingRejected`.

## 4. FenceStopCheck (P2 extension of the P1 hook)

P1 `FenceStopCheck.check(context)` becomes:

```ts
interface FenceStopCheckService {
  readonly check: (
    context: CommandSubmissionContext,
    stopAdmission: StopAdmission,        // P2 01 §3
  ) => Effect<FenceStopOutcome>;         // Pass | FencingRejected | ExecutionStopping
}
```

- Evaluated only for `ExecutionOrigin`.
- Fence validity: `executions JOIN execution_leases` with matching
  `execution_id + generation` and `settled_at IS NULL` (P1 `04` §4 predicate,
  tables now exist).
- Stop admission follows the `StopAdmission` ADT (`01` §3):
  `NormalExecutionMutation` + `stop_requested_at != null` →
  `ExecutionStopping`; `QuiescenceControlMutation` and `StopControl` → `Pass`
  (fence still enforced); `Unclassified` on `ExecutionOrigin` is a defect.
- The P1 inert default (`Pass`) remains valid for `External`/`System`.

## 5. Worker dispatch, driver, safety gate

### WorkerDispatchPort

```ts
interface WorkerDispatchPortService {
  readonly dispatch: (request: {
    readonly executionId: ExecutionId;
    readonly workspaceId: WorkspaceId;
    readonly workerKind: "Agent" | "Verifier";
  }) => Effect<DispatchTicket, WorkerDispatchError>;
}
type DispatchTicket = { readonly dispatchId: string; readonly acceptedAt: string };
```

Dispatch is a durable wake intent; it does **not** acquire a lease. P2 ships a
local in-process adapter plus a `Fake` used by tests. A dispatch failure never
settles an Execution (DID §6A.6).

### ExecutionDriverPort (freezes DID v1.7 G4)

```ts
interface ExecutionDriverPortService {
  readonly drive: (input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
    readonly wakeReason: WakeReason;
    readonly context: CommandSubmissionContext;   // ExecutionOrigin
    readonly safetyGate: RuntimeSafetyGateService;
  }) => Effect<ExecutionSettlement, ExecutionDriverError>;
}
```

- P2 freezes the port + a `FakeDriver` that produces a deterministic
  settlement (`Yielded` / `CompletionClaimed` / `Interrupted` / `Failed`).
- P3 provides the real Agent loop through this port.
- The driver returns a settlement **proposal**; the P2 runtime persists it via
  `SettleExecution` (ExecutionOrigin, fenced). The driver never writes
  canonical state directly.

### RuntimeSafetyGate (P2-owned, DID v1.7 G4)

```ts
type ExecutionActivity =
  | { readonly _tag: "ProviderTurn"; readonly fingerprint: string }
  | { readonly _tag: "ToolInvocation"; readonly fingerprint: string }
  | { readonly _tag: "SpecialistAction"; readonly fingerprint: string };

type SafetyDecision = "Continue" | "Stop";

interface RuntimeSafetyGateService {
  readonly admitActivity: (
    executionId: ExecutionId,
    activity: ExecutionActivity,
  ) => Effect<SafetyDecision>;
}
```

- P2 owns execution-wide enforcement (max transient retries, repeated action
  fingerprints, recursion depth, consecutive no-progress turns, concurrency
  ceilings) at the driver boundary (DID §8.16A).
- P3's driver **must** call `admitActivity` at every new ProviderTurn /
  ToolInvocation / Specialist action boundary and obtain `Continue`/`Stop`.
- `Stop` → the driver returns `Interrupted(RuntimeSafetyStop(reason))`; Work
  remains Open; Attention emitted. Safety never auto-cancels Work.
- Numeric thresholds are implementation/configuration, not contract.

## 6. Lease service

Lease acquisition/renewal/loss is a Runtime port operation, **not** a Command
(DID §4.4, §9.7). It is realized on top of `ExecutionRepository` lease CAS:

```ts
interface LeaseService {
  acquire(executionId, workerId): Effect<LeaseRecord, LeaseFencingRejected | ExecutionRepositoryError, TransactionScope>;
  renew(executionId, workerId, generation): Effect<LeaseRecord, LeaseFencingRejected | ExecutionRepositoryError, TransactionScope>;
  release(executionId, workerId, generation): Effect<void, ExecutionRepositoryError, TransactionScope>;
  invalidateExpired(now): Effect<number, ExecutionRepositoryError, TransactionScope>;
}
```

- `generation` increments monotonically per successful acquisition
  (`MAX(generation)+1`, `0` when absent). Release is a **soft** release
  (expire in place, never DELETE) so the generation never resets and a stale
  worker's fence can never re-validate.
- `LeaseLost` (worker-local knowledge) ≠ `FencingRejected` (authoritative
  persistence rejection) (DID §6A.5).
- Worker crash / lease expiry alone never settles an Execution.

## 7. ExecutionScheduler and the P2/P7 boundary

```ts
interface ExecutionSchedulerService {
  readonly reevaluate: (
    workspaceId: WorkspaceId,
    wakeReason: WakeReason,
  ) => Effect<SchedulerDecision, ExecutionSchedulerError>;
  readonly registerWorkWait: (wait: WorkWait) =>
    Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly clearWorkWait: (workId: WorkId) =>
    Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly scheduleTimer: (timer: SchedulerTimer) =>
    Effect<void, SchedulerTimerStoreError, TransactionScope>;
  readonly dueTimers: (now: string) =>
    Effect<ReadonlyArray<SchedulerTimer>, SchedulerTimerStoreError, TransactionScope>;
}

type SchedulerDecision =
  | { readonly _tag: "Noop"; readonly reason: "ActiveMainExecution" }
  | { readonly _tag: "Admit"; readonly focus: ExecutionFocus }
  | { readonly _tag: "SelectCurrentWork"; readonly workId: WorkId }
  | { readonly _tag: "Idle" };
```

Runnability classification is **P7-owned**; P2 consumes it through:

```ts
interface RunnableWorkSourceService {
  readonly classify: (workspaceId: WorkspaceId) => Effect<{
    readonly current: Option.Option<WorkId>;
    readonly runnable: ReadonlyArray<WorkId>;
  }, RunnableWorkSourceError>;
}
```

P2 implements the DID §8.18A decision table over this port and ships a
deterministic stub; P7 ships the real dependency-aware source. P2 does not add
runnable semantics.

## 8. WorkWaitStore and SchedulerTimerStore

```ts
interface WorkWaitStoreService {
  upsert(wait: WorkWait): Effect<void, WorkWaitStoreError, TransactionScope>;
  findByWork(workId): Effect<Option.Option<WorkWait>, WorkWaitStoreError, TransactionScope>;
  clear(workId): Effect<void, WorkWaitStoreError, TransactionScope>;
  listActive(): Effect<ReadonlyArray<WorkWait>, WorkWaitStoreError, TransactionScope>;
}

interface SchedulerTimerStoreService {
  schedule(timer: SchedulerTimer): Effect<void, SchedulerTimerStoreError, TransactionScope>;
  due(now): Effect<ReadonlyArray<SchedulerTimer>, SchedulerTimerStoreError, TransactionScope>;
  cancel(timerId: string): Effect<void, SchedulerTimerStoreError, TransactionScope>;
}
```

`WorkWait` / `WaitSpec` / `WakeCondition` / `WakeReason` exact types are frozen
in `05` §2–§3.

## 9. Transaction participation summary

```text
ExecutionRepository / SessionRepository.appendEntry / WorkWaitStore
SchedulerTimerStore                       -> require TransactionScope
LeaseService                              -> realized on ExecutionRepository CAS (TransactionScope)
FenceStopCheck                            -> requires TransactionScope at the call site
ExecutionDriverPort                       -> NO TransactionScope (long-running; settles via Command)
RuntimeSafetyGate                         -> NO TransactionScope (in-memory counters + durable state read)
WorkerDispatchPort                        -> NO TransactionScope (external wake)
ExecutionScheduler.reevaluate             -> opens its own short transaction per decision
ProjectEnvironmentPort / Clock / IdGenerator -> NO TransactionScope (P1)
```

## 10. Out of scope

- Provider/Tool/Model Context ports (P3/P4).
- Real dependency/runnable graph (P7).
- `RecordEnvironmentChange` (P11).
- Specialist spawn/delegation ports (P6/P8).
