# P2 — Contract Index

**Authority:** DID v1.7 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P2-owned implementation contracts authorized
by DID §13.

```text
Detailed Implementation Design v1.7 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P2/**   (these contracts)
```

DID §13 points at `docs/design/implementation/P2/**`; a conflict resolves in
favor of the DID.

## Documents

| Doc | Owns |
|---|---|
| `01-command-contracts.md` | P2 command set, runtime authority facts, mutation classes, payload/result/rejection/events |
| `02-port-contracts.md` | P2 ports (ExecutionRepository, Session append, WorkerDispatch, ExecutionDriver, RuntimeSafetyGate, ExecutionScheduler, WorkWaitStore, timers), Effect A/E/R |
| `03-lease-fencing-model.md` | lease lifecycle, generation, fence/stop predicates, quiescence-control admission, recovery authority |
| `04-sqlite-schema.md` | P2 DDL (`executions`, `execution_leases`, `agent_execution_state`, `session_entries`, `work_waits`, `scheduler_timers`), indexes, CAS SQL |
| `05-scheduler-wait.md` | ExecutionScheduler, deterministic re-evaluation trigger, durable WorkWait, wake/timer, lost-wake-up protection |
| `06-recovery-skeleton.md` | recovery order, expired-lease invalidation, unsettled detection, RecoveryController settlement, DurabilityEnvelope |
| `00-contract-index.md` | this index |

## P2 command set

`AdmitExecution`, `StopExecution`, `SettleExecution` (DID §4.3).

`RecordEnvironmentChange` is **P11** (DID v1.7 G2); P2 consumes environment
facts only.

## DID v1.7 governance inputs

| Ruling | Closed by |
|---|---|
| G1 command-specific runtime authority + Normal/Quiescence split | `01` §2–§4, `03` §3–§5 |
| G2 `RecordEnvironmentChange` → P11 | `01` §1 |
| G3 P2 scheduler/WorkWait/wake vs P7 runnability | `02` §6–§8, `05` |
| G4 ExecutionDriverPort + Fake Driver + P2 Runtime Safety gate | `02` §5, `05` §7 |
| G5 WorkspaceMain/ExecutionBound admission + atomic session + IDs | `01` §5, `02` §2, `04` §3.1 |

## Phase-scoped closures owned here

| Item | Closed by |
|---|---|
| `RecoveryController` submission origin + `CommandSubmissionContext` evolution | `01` §2, `06` §4 |
| `FenceStopCheck` mutation-class extension | `02` §4, `03` §5 |
| P2/P7 runnable boundary port | `02` §7, `05` §4 |
| durable timer storage | `04` §3.6, `05` §6 |
| `WorkerDispatchPort` semantics + local adapter | `02` §5 |
| `Fake Driver` contract | `02` §5, `05` §7 |
| tool/provider reconciliation boundary (skeleton only) | `06` §5 |
| `AgentExecutionState` persistence | `04` §3.3 |

## Inherited-artifact evolutions (authorized by DID v1.7 G1)

P2 evolves the following P0/P1 artifacts. These are phase-scoped evolutions,
not new design semantics; each requires the P1/P0 source to gain a pointer note
during P2 implementation (no new governance round).

| Artifact | Evolution | Owner |
|---|---|---|
| `CommandSubmissionContext` (P0 `domain`) | add `RecoveryController { principal, causationRef }` | `01` §2.2 |
| `CommandRejection` (P1 `01` §2) | add Application-owned `ExecutionNotFound { executionId }` | `01` §2.1 |
| `CommandGateway.execute` authority parameter (P1 `01` §3) | generalize to `CommandAuthorityFact = VerifiedCommandAuthority \| VerifiedRuntimeCommandAuthority` | `01` §2.3 |
| `FenceStopCheck.check` (P1 `03` §4) | add `stopAdmission` argument; stop gate returns `Pass` for `QuiescenceControl` | `02` §4 |
| `CommandHandler` (P1 `09` application) | add declared `stopAdmission` | `01` §3 |
| `Execution` (P0 `domain`) | add `workspaceId` (R6) and `stopRequestedAt` (R9) | `04` §3.1, `01` §5–§6 |
| P1 `04` §4 fence predicate | add `expires_at > now` (R8; SD v1.3 §10.5 is the higher-authority owner) | `03` §3, `04` §4 |

## P12 TR propagation (documentation reconciliation; no P2 semantics change)

- **TR-8** — `AdmitExecutionAuthority` / `StopExecutionAuthority` `submissionOrigin` widened to include `"External"` (resolver is P12) (`01` §2; R1 above; `P12 02` §4; DID v1.14 G2 / v1.13 G4).
- **TR-9** — `execution_leases.worker_incarnation_id` + `(worker_id, worker_incarnation_id, generation)` fence/CAS; `LeaseRecord` / `ExecutionRepository` / `LeaseService` / `SessionRepository.appendEntry` fence / `FenceStopCheck` carry the triple (`02` §2–§4/§6, `03` §2–§4, `04` §3.2/§4; `P12 06` §3).
- **TR-10** — optional `RuntimeSafetyObservation` third argument on `RuntimeSafetyGate.admitActivity` (additive; two-arg call unchanged) (`02` §5; `P12 08` §7/§7A).

## Review findings (round 1)

| # | Finding | Classification | Resolution |
|---|---|---|---|
| R1 | P2 runtime facts initially admitted `External` origins for Admit/Stop | upstream-consistent correction | restricted to `System` / `ExecutionOrigin` / `RecoveryController`; External human path deferred to the Authority Resolver phase (`01` §2). **P12 TR-8 propagation:** the deferred resolver is P12 (`P12 02` §4; DID v1.14 G2 / v1.13 G4); `AdmitExecutionAuthority` / `StopExecutionAuthority` `submissionOrigin` re-widen to include `"External"` (`01` §2), matching DID §4.1 |
| R2 | `SelectCurrentWork` execution ownership ambiguous (Work-governance, not P2) | P2 phase-scoped closure | P2 computes the §8.18A decision only; execution owned by P6/P7 (`05` §4) |
| R3 | `RuntimeSafetyGate.admitActivity` durability of counters | implementation choice | counters may be in-memory + durable `agent_execution_state` snapshots; Port shape may add `TransactionScope` at implementation |
| R4 | `ExecutionDriverPort.drive` performs short durable writes | P2 phase-scoped closure | driver uses `TransactionPort` for short scoped writes; `drive` itself holds no transaction (`02` §5) |
| R5 | `ExecutionRepositoryError` / `LeaseFencingRejected` exact tags | implementation choice | follow P1 `RepositoryFailure<T>` naming; `LeaseFencingRejected` is a P2 port error |
| R6 | P2 DDL stores `workspace_id NOT NULL` for all binding kinds, but P0 `Execution` carried the workspace only inside `WorkspaceExecution` | phase-scoped domain evolution | add `Execution.workspaceId`; `admitExecution` input gains `workspaceId` (`04` §3.1, `01` §5) |
| R7 | lease `releaseLease` as DELETE + `MAX(generation)+1` resets the generation, letting a stale worker's fence re-validate | phase-scoped contract correction | release is **soft** (expire in place, never DELETE); `02` §6, `04` §4 |
| R8 | frozen P1 hook fence predicate omitted lease expiry, contradicting SD v1.3 §10.5 | inherited P1 fence-contract correction | predicate adds `expires_at > now`; P1 `04` §4 updated, P1 not reopened; P2 `03` §3, `04` §4 |
| R9 | `StopExecution` must return the existing `stopRequestedAt` on idempotent stop | phase-scoped domain evolution | `Execution.stopRequestedAt`; `01` §6, `04` §3.1 |

No open Blocking item after R1/R2. R3–R5 are non-blocking closures.

## Status

FROZEN — P2 phase-scoped contracts; review Blocking = 0 (P2 FORMALLY CLOSED).
`planning/gaps/` once review starts. No P2 planning is generated until
Blocking = 0.
