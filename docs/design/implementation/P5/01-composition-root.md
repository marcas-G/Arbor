# P5 — 01 Composition Root

**Authority:** DID v1.9 §10.1/§10.4.1, §11 P5, G1/G6.
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox addendum accepted under `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1`.

## 1. Deliverable (G1)

```text
apps/single-workspace/        # minimal runnable composition root
  src/main.ts                 # process entry: build layers, run one workspace loop
  src/composition.ts          # the Layer graph wiring P1–P4
```

- It is a **runnable** composition root (not test-harness-only) but **not** a
  production daemon/CLI (DID v1.9 G1): no auth/UI/ops surface.
- `apps/*` is the Composition Root permitted by DID §10.4.1; it may depend on any
  package/adapter, and production packages never depend on it.

## Accepted Native OS Sandbox composition amendment

P5 composition injects an Execution-scoped policy-bound `SandboxProcessPort`
and the selected provider alongside the existing `SandboxPort`; executors do
not construct providers or choose a weaker fallback. Startup probes required
provider capabilities before an executable spawn. Production defaults to
`WorkspaceWrite` OS enforcement. `TrustedLocal` remains an explicit test/dev
or human-selected compatibility mode and is never chosen after provider
failure.

P5 loads `SandboxPolicyGrantIssuerConfigV1` only from the OS-protected trusted
host/organization deployment source, not Workspace/model input or inherited
process environment. Validate the exact schema and canonical digest at
startup; retain one immutable snapshot per daemon. The source enforces a
durable monotone revision/high-water mark with no rollback/reuse. Missing,
invalid or empty operator configuration disables the policy-authority path.
Configuration change requires a quiesced daemon and restart; P5 records
sanitized source/revision/digest/load audit without secrets. This accepted
addendum is limited to the accepted sandbox/provider and issuer configuration.

## 2. Layer graph

```text
SqliteClient (durable file DB) + ClockLive + IdGeneratorLive
├── TransactionPortLive
├── repositories (Project/Workspace/Work/Session/Execution)
├── CommandStore / DomainEventJournal
├── LeaseService / WorkWaitStore / SchedulerTimerStore / AgentExecutionStateStore
├── ProviderTurnStore / ToolInvocationStore / ArtifactMetadataRepository
├── ProjectEnvironmentPort (environment-local)
├── ProviderPort (provider-fake) + ProviderRuntime
├── ModelContext + ToolDefinitionStore + ToolCatalogPort
├── SandboxPort (sandbox-local) + BlobStorePort (blob-local) + ArtifactService
├── ResourceAdmission + ResourceOwnershipRepository
├── FenceStopCheck + RuntimeSafetyGate + ExecutionScheduler + RunnableWorkSource (02)
├── P2/P3 command handler registry + CommandGateway
└── ExecutionDriverPort (AgentLoopDriverLive) + runExecution orchestration
```

- The durable DB is a **file** path (not `:memory:`) so restart continuity can be
  proven (G5).
- Layers are built once per runtime instance; the same composition function is
  used to reconstruct the runtime on restart.

## 3. Runtime lifecycle

```ts
interface SliceRuntime {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;   // dispose layers / close DB
}
```

- `start` runs migrations, then the single-workspace loop.
- `stop` disposes the layer graph and closes the DB; the durable state remains.
- Restart = `stop` + construct a new `SliceRuntime` against the same DB file
  (P2 owns the recovery mechanism; P5 proves continuity — G5).

### 3.1 Scheduler decision handling (P5-DG-01 resolution)

The slice loop consumes the frozen `ExecutionScheduler` decision table
(DID §8.18A) and never re-decides it. Ownership is split:

- **Selection decision** — which Work should become current / be admitted — is
  owned by the scheduler evaluator (P2; later P7 runnability). The slice only
  reads the returned `SchedulerDecision`.
- **Canonical mutation execution** — applying `SelectCurrentWork` /
  `AdmitExecution` — is owned by the Application command handlers and is
  performed **only** through `CommandGateway`.

```text
decision = scheduler.reevaluate(workspaceId, wakeReason)
if decision is SelectCurrentWork(workId):        # exact evaluator output
    gateway.execute(SelectCurrentWork { workspaceId, workId, expectedRevision })
    decision = scheduler.reevaluate(workspaceId, wakeReason)
if decision is Admit(focus):
    gateway.execute(AdmitExecution { executionId (caller-preallocated), focus })
```

- P5 never chooses the Work itself and never mutates a repository directly.
- `SelectCurrentWork`'s canonical mutation is an **Application** command handler
  (same shape as the P1 commands); P5 provides its first implementation and
  integration. No `setCurrentWorkId` command is introduced. The accepted
  Native OS Sandbox amendment separately adds only `DecideSandboxPolicy` and
  does not alter SelectCurrentWork semantics.
- The mutation runs only after the evaluator returns an exact
  `SelectCurrentWork(workId)`; the loop forwards that `workId` verbatim.
- P6/P7 own the broader governance around current-Work selection and reuse the
  same Application handler.

FT-DG-03 input validation reference: `SelectCurrentWork` retains the exact
payload shape shown at the Application call above. Its composed handler gets
the registered P1 semantic validator for typed internal submissions; it is
not made externally actionable by codec registration and remains System /
scheduler-origin under P13 `02`.

## 4. Provider (G6)

- The composition root wires the deterministic `provider-fake`; CI and P5
  completion must not depend on a live provider.
- A real provider adapter may be selected for optional dogfooding but must not
  gate CI/P5.

## 5. Must Not Decide

- No new subsystem semantics (P5 is integration only).
- No verification/acceptance/CompleteWork wiring (P8).
- No dependency coordination (P7).
- No multi-workspace formation (P6).
- No advanced environment/sandbox isolation (P11).
