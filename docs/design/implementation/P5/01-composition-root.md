# P5 — 01 Composition Root

**Authority:** DID v1.9 §10.1/§10.4.1, §11 P5, G1/G6.
**Status:** DRAFT (first draft for contract review).

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
└── ExecutionDriverPort (AgentDriverLive) + runExecution orchestration
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
