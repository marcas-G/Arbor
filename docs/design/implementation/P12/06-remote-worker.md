# P12 — 06 Remote Worker Transport / Identity (G6)

**Authority:** DID v1.14 G6; §3.4, §6.3, §7.2, §9.1, §9.6, §9.7, §12.3, §12.10; SD v1.3 §10.3, §10.5, §14 No.15/16/48; P2 `02`/`03`; P9 `03`/`04`.
**Status:** DRAFT.

## 1. Model (frozen)

```text
Remote Worker supported
canonical control plane = single-writer
no distributed consensus / no multi-writer control plane
```

The Runtime/control plane remains the only writer of canonical state.

## 2. Identity

```ts
WorkerId            // wkr_ + UUIDv7 : replaceable executor identity
WorkerIncarnationId // wic_ + UUIDv7 : the process/instance incarnation of that WorkerId
```

- `WorkerId` is the durable, replaceable executor identity.
- `WorkerIncarnationId` distinguishes a restarted process from the previous holder of the
  same `WorkerId`, so an old incarnation cannot be mistaken for the current one.
- The lease holder is identified by `(WorkerId, WorkerIncarnationId, generation)`.

## 3. Inherited P2 lease evolution — incarnation fencing (v1.14 G6)

DID v1.14 G6 + §9.7 + §12.10 authorize the P12 Worker identity contract. The
frozen `execution_leases` table (`P2 04` §3.2) has no incarnation column and the
frozen fence predicate (`P2 03` §3 / `P2 04` §4) is `generation = ?` only, so
§2's holder triple is not yet representable. P12 therefore declares the
following **inherited P2 evolution** — the only P2 lease/fencing change (see §8):

```sql
-- P12 migration 0011_lease_worker_incarnation (forward-only; user_version = 11)
ALTER TABLE execution_leases ADD COLUMN worker_incarnation_id TEXT NOT NULL DEFAULT '';
```

**P12 migration list (ordered, forward-only — this list is the single
authority; R-09).** P12 declares exactly three schema migrations:

```text
P12 migrations (ordered, forward-only):
  0011_lease_worker_incarnation    (06 — this doc)
  0012_permission_grants           (02)
  0013_project_tool_registry       (01)
PRAGMA user_version == max(applied migration id) == 13
```

The baseline is asserted at startup / readiness (`P1 04` §5: forward-only
ordered migrations; `04` §4 `migrationBaseline`; `05` §4.1 restore-drill
`migrationUserVersion = max(P12_MIGRATIONS) = 13`; `00` TR-7). No other P12
document declares a schema migration; a new P12 migration must extend this list
and advance the asserted `max(id)` in the same change.

- The lease holder / fence identity becomes the triple
  `(worker_id, worker_incarnation_id, generation)`.
- Authoritative fence predicate extends to the triple:

```sql
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ?
  AND l.worker_id = ?
  AND l.worker_incarnation_id = ?
  AND l.generation = ?
  AND l.expires_at > ?
  AND e.settled_at IS NULL;
```

- Lease CAS extends to the same triple:
  - renew / release: `WHERE execution_id = ? AND worker_id = ?
    AND worker_incarnation_id = ? AND generation = ?`
  - acquisition records the acquiring `worker_incarnation_id`; `generation`
    remains `COALESCE(MAX(generation), -1) + 1` (monotonic).
- Repository / port signatures extend:
  - `LeaseRecord = { executionId, workerId, workerIncarnationId, generation,
    expiresAt, updatedAt }`
  - `ExecutionRepository.tryAcquireLease(executionId, workerId,
    workerIncarnationId, expiresAt)`
  - `ExecutionRepository.renewLease(executionId, workerId,
    workerIncarnationId, generation, expiresAt)`
  - `ExecutionRepository.releaseLease(executionId, workerId,
    workerIncarnationId, generation)`
  - `LeaseService.acquire/renew/release` carry the same triple
  - `SessionRepository.appendEntry` fence carries
    `{ executionId, workerId, workerIncarnationId, fencingGeneration }`
  - `FenceStopCheck` validates the triple.
- Every fence predicate above matches the authoritative predicate (§3), which
  includes `worker_id`; incarnation-only matching is insufficient, so
  `appendEntry` must carry `workerId` as well as the incarnation.
- All other P2 semantics are unchanged: monotonic generation, soft release,
  expired lease cannot commit, and the authoritative check shares the mutation's
  own transaction.

## 4. Transport (authenticated, versioned)

```text
remote worker ⇄ control plane : authenticated + versioned transport (P12 contract)
  - mutual authentication; worker identity proven, never asserted by payload
  - versioned protocol (protocol version negotiated; incompatible → typed rejection)
  - no canonical DB connection is granted to the worker
```

### 4.1 Transport surface

```ts
type WorkerTransportProtocolVersion = {
  readonly major: number;
  readonly minor: number;
};

type TransportVersionRejected = {
  readonly _tag: "TransportVersionRejected";
  readonly localMajor: number;
  readonly peerMajor: number;
};

// Wire-level terminal rejection, in `domain`/`ports` terms only. The control
// plane maps its application-level `CommandRejection` onto this bounded set at
// the boundary. The `FencingRejected` tag below is a DISTINCT ports-level
// structural type (not the application `CommandRejection` member); no
// `packages/application` type enters `ports`.
type WorkerCommandRejection =
  | DomainError
  | { readonly _tag: "FencingRejected" }
  | { readonly _tag: "ExecutionStopping" }
  | { readonly _tag: "ExecutionNotFound"; readonly executionId: ExecutionId };

interface RemoteWorkerTransportPortService {
  readonly negotiate: (
    peer: WorkerTransportProtocolVersion,
  ) => Effect.Effect<WorkerTransportProtocolVersion, TransportVersionRejected>;
  readonly submit: (
    mutation: ExecutionOriginMutation,
  ) => Effect.Effect<
    CommandReceipt<unknown, WorkerCommandRejection>,
    TransportVersionRejected
  >;
}
```

- The wire contract is declared in `domain`/`ports` terms only (`WorkerId`,
  `WorkerIncarnationId`, `ExecutionId`, `LeaseGeneration`, `CommandEnvelope`,
  `CommandReceipt`, `DomainError`). The application authority/rejection types
  (`VerifiedRuntimeCommandAuthority`, `CommandRejection`, `FencingRejected`) stay
  **control-plane-side** in the mediation layer (§6.1) — a `ports → application`
  edge is forbidden (DID §10.4.1).

- `negotiate` accepts only a compatible **major**; an incompatible major is the
  named typed rejection `TransportVersionRejected`, never a silent downgrade.
- The worker-side transport package is `adapters/worker-transport`; it is
  registered in `tests/architecture/package-dag.ts` `ALLOWED_EDGES` with only
  the `adapters/* → domain, ports` edge and never imports
  `adapters/persistence-sqlite`; its `Layer` requirement `R` excludes
  `SqlClient`.

## 5. "Worker-originated durable write" — definition (frozen)

```text
Worker-originated durable write
  = a mutation REQUESTED by an authenticated worker
    and COMMITTED by the control plane
    through authoritative Application / Runtime ports
It does NOT mean a worker process owns or directly uses a canonical DB connection.
Remote Workers MUST NOT directly write canonical SQLite / PostgreSQL state.
```

## 6. Fenced submission mediation

- The worker submits the `ExecutionOriginMutation` wire DTO (§6.2) carrying the
  authenticated identity + the fence triple + the `CommandEnvelope`; it carries
  **no** authority fact.
- The control plane constructs the trusted authority fact and the
  `ExecutionOrigin` submission context from those authenticated facts, then
  delegates to `CommandGateway`; the gateway performs, **in one transaction**:
  authoritative fence check → canonical read/write → command resolution → domain
  event append (DID §6.3).
- A stale generation/incarnation is rejected authoritatively; dispatch failure never settles
  (P9 `04` §4); sweep self-heals without a durable dispatch record.

### 6.1 Mediation entry point (E-12)

```ts
interface RemoteWorkerMediationPortService {
  readonly submit: (
    peer: { readonly workerId: WorkerId; readonly workerIncarnationId: WorkerIncarnationId },
    mutation: ExecutionOriginMutation,
  ) => Effect.Effect<
    CommandReceipt<unknown, CommandRejection>,
    TransportVersionRejected | CommandGatewayError
  >;
}
```

- `submit` is the **control-plane** entry point, declared in `packages/application`
  (NOT `ports`, which would create a forbidden `ports → application` edge,
  DID §10.4.1). It is the only layer that references the application
  authority/rejection types (`VerifiedRuntimeCommandAuthority`, `CommandRejection`).
- **Identity binding (M2):** the transport binds the authenticated peer identity
  out-of-band; `submit` receives that authenticated `(WorkerId, WorkerIncarnationId)`
  as a separate argument and MUST reject a wire DTO whose `workerId` /
  `workerIncarnationId` differs from the authenticated peer (a worker cannot assert
  another worker's identity / hijack its execution).
- It derives the authenticated `CommandSubmissionContext.ExecutionOrigin` and the
  trusted `VerifiedRuntimeCommandAuthority` from the wire DTO's authenticated
  facts — never from the payload (DID §4.1; P2 `01` §2: facts are
  Runtime-produced, never constructed from payload) — then delegates to
  `CommandGateway.execute(envelope, context, authority)`.
- The single `TransactionPort.transact` is the **gateway's** (CI-1): the
  mediation port MUST NOT open its own transaction, and MUST NOT perform command
  resolution or domain event append itself (DID §6.3). It is a thin adapter over
  the gateway, not a second command pipeline.
- A stale `(WorkerId, WorkerIncarnationId, generation)` returns a
  `TerminalRejected(FencingRejected)` receipt and leaves **no journal row** (no
  Domain Event, no canonical write). Fencing rejection is a receipt outcome, not
  an operational error.

### 6.2 ExecutionOrigin mutation shape (E-14)

The wire DTO carries **only** the authenticated identity (`workerId`,
`workerIncarnationId`), the fence triple `(workerId, workerIncarnationId,
fencingGeneration)`, the target `executionId`, and the `CommandEnvelope`. It
carries **no** authority fact: the frozen `CommandSubmissionContext.ExecutionOrigin`
(`DID §4.1`) and the trusted `VerifiedRuntimeCommandAuthority` are constructed
**control-plane-side** (§6.1), reconciled with the P2 lease triple (§3):

```ts
type ExecutionOriginMutation = {
  readonly workerId: WorkerId;
  readonly workerIncarnationId: WorkerIncarnationId;
  readonly executionId: ExecutionId;
  readonly fencingGeneration: LeaseGeneration;
  readonly envelope: CommandEnvelope<unknown>;
};
```

- `workerId` + `workerIncarnationId` are authenticated transport facts, never
  model-supplied, and never enter `semanticRequestFingerprint` (DID §4.1).
- The triple `(workerId, workerIncarnationId, fencingGeneration)` must match the
  live lease row (§3); `executionId` alone is insufficient.

## 7. Invariants

```text
CI-1  remote worker path never opens/writes the canonical DB directly
single-writer control plane preserved
old worker incarnation cannot commit (generation + incarnation fencing)
lease acquire/renew/release for a non-DB worker is mediated by the control plane
wire carries no authority fact; the control plane constructs it and delegates to CommandGateway
```

## 8. Must Not Decide

- No distributed consensus / leader election / multi-writer control plane.
- The only P2 lease/fencing change is the declared `worker_incarnation_id`
  column + extended `(worker_id, worker_incarnation_id, generation)` fence
  predicate (§3); all other P2 lease/fencing semantics and P9 recovery ownership
  are unchanged.
- No durable dispatch table (preserve P9 sweep fallback).

## 9. Verification

```text
remote worker has no DB credential / connection path
mediated mutation = fence-check + mutate + resolve + event in one tx
stale (WorkerId, IncarnationId, generation) → authoritative rejection
transport version mismatch → typed rejection
instrumented TransactionPort: one submit invokes exactly one transact
stale (WorkerId, IncarnationId, generation) → typed FencingRejected, no journal row
worker transport package imports no persistence-sqlite; Layer R excludes SqlClient
worker-side program cannot obtain SqlClient
incompatible protocol major → TransportVersionRejected
wire submission carries no authority fact; control plane constructs it (not from payload)
`ports` wire contract references no `packages/application` type (no ports → application edge)
PRAGMA user_version == 13 (max applied P12 migration id)
```
