# Architecture evolution — Effect-native modular monolith

Status: adopted direction 2026-11-25. This is the sequencing plan for the
capability-oriented evolution of the current technically-layered,
interface-passing organization. It changes implementation organization, not
product semantics; every step that would touch a frozen contract stops and
raises a Design Gap first.

## Goal

Evolve from technical layering with interface passing toward a modular
architecture organized around business capabilities, Effect Services,
resource ownership and composable Layers — so each capability's internal
complexity leaks neither to other capabilities, nor to developers, nor to
the test system. Deployment stays a monolith; ownership, composition and
testing become capability-scoped.

Arbor already uses Effect, but using Effect and exploiting its architectural
power are different things. Effect must constrain complexity propagation,
not merely replace promises, exceptions and manual DI.

## Inputs

- **Effect**: typed dependencies, composable services, structured
  concurrency, resource lifecycle, independent testing
  (`docs/engineering/effect-conventions.md`).
- **OpenCode engineering**: capability module organization, service-private
  state, instance-scoped lifecycles, service composition/replacement
  (studied, not copied — its `LayerNode` graph machinery is deliberately
  not adopted until plain Layer composition is proven insufficient).
- **DeepSeek Harness methodology**: minimally sufficient verification,
  independent review, knowledge retention.

## Preconditions on every step

- State ownership, transaction boundaries and durable-recovery semantics
  are re-verified against the existing frozen contracts before any code
  moves. Capability splits must never turn atomic admission-plus-lease
  operations into two unsafe operations.
- Each seam is one complete capability slice, measured before and after:
  direct dependency count, public interface surface, state ownership, test
  dependencies, verification time.
- No parallel governance system is built (E12): plain Effect Layer until
  proven insufficient.

## Tool-capability ownership audit (prerequisite)

A business concept may cross technical layers but must never have two
competing semantic owners. Before refactoring, each of these gets exactly
one confirmed owner:

| Responsibility | Owner to confirm |
|---|---|
| Tool definition and registration | who owns the valid tool set |
| Invocation identity | who generates and maintains Invocation IDs |
| Permission decision | who decides execution is allowed |
| Tool execution | who produces side effects |
| Result persistence | who records results atomically |
| Interruption and recovery | who decides how unknown outcomes resolve |
| Model-visible result | who constructs the final tool observation |

The audit records the current owner of each (across agent-runtime,
tool-runtime, execution-runtime, application, ports, sandbox adapters,
persistence-sqlite) and any place where ownership is contested.

## Sequenced refactor objects

| Order | Object | Core goal |
|---|---|---|
| 1 | Agent Loop Driver | reduce low-level dependencies and business-knowledge leakage |
| 2 | Agent Loop Action Dependencies | separate business input, service dependencies and runtime state |
| 3 | Composition Root | capability-level Layer composition |
| 4 | Runtime Lifecycle | explicit resource ownership and scopes |
| 5 | Ports | public contracts controlled per capability |
| 6 | TestKit | local Layer-level test construction |
| 7 | Execution Recovery | unified recovery semantics and error-handling ownership |
| 8 | SQLite | persistence detail isolated from business decisions |
| 9 | Scheduler | strengthen the admission boundary on the already-clear structure |
| 10 | CI | verify module boundaries and independent testability |
| 11 | Semantic Naming | ratchet planning-code names out of new code (path, symbol and test-name rules against a frozen inventory baseline) |

`scheduler.ts` is the in-repo positive example to build on. The order is
capability-value-driven, not line-count-driven (that is what distinguishes
this from the R5 file-size campaign, which continues independently).

## Measurement discipline

Every seam migration appends to this file: the measured before/after
dependency count and public surface, the contract checks performed, and
the verification commands run. A migration without before-measurements is
invalid.

## Seam migration log

| PR | Object | Measurement | Verification |
|---|---|---|---|
| #4 | 1 (E03) | Control-basis assembly: driver inline wiring of tx+4 stores → capability Service + Live layer; driver source no longer references the stores for this purpose | agent-runtime 254; p2/p3/p3-integration/p9/p11 89 |
| #5 | 2 | AgentLoopActionDependencies 21-field flat → three layers (TurnInput/DurableStores/Orchestration) + intersection alias; zero behavior change | agent-runtime 254; p2/p3 65 |
| #6 | 3 | Invocation-ID scheme: composition-root private helper → ports contract (deriveToolInvocationId/deriveLegacyToolInvocationId), byte-identity verified; PR #4 composition gap repaired (43 runtime failures → 0) | ports 24; single-workspace 585 |
| #7 | tool ownership | bounded() 4 unlinked copies → executor-side authority imported by the app copies | tool-runtime 191; single-workspace 585 |
| pending | 9 (obj9) | Scheduler admission boundary: the durable environment-blocking fact source (`WorkReadmissionGateStore`) moved from hidden optional `Effect.serviceOption` acquisition + runtime fail-closed stubs to a required R-channel dependency at the three admission consumers — `P2CommandHandlerRegistryLive` (`packages/execution-runtime/src/commands/registry.ts`), `makeSingleWorkspaceCommandHandlerRegistryLive` (`apps/single-workspace/src/registry.ts`), and `DependencyAwareRunnableWorkSourceLive` (`apps/single-workspace/src/runnable-source-p7.ts`). Before: 3 `serviceOption` lookups, 2 fail-closed `PersistenceUnavailable` stubs, type-level optionality on `P2CommandDependencies.readmissionGate`. After: 0 hidden lookups on this seam; a composition without the gate fails at layer construction (`Die: Service not found`) instead of at admission time; the two missing-port tests moved from runtime-error assertions to layer-build assertions. Tick-path audit (wake-consumer / fireDueTimers / workflow-signal-consumer / evaluateAndSelect): every path reaches classify through the same required gate and commit-time recheck re-queries it in the admission transaction; projections consume classify read-only. Zero behavior change on composed paths | execution-runtime 8; architecture 270; p2/p7/p9/p12/p6/p8 + single-workspace suites 700+; source-line gate blocking 0 |
| pending | 1 (E02/E03/E05/E11) | Model Decision became an execution-bound capability Service: driver-local Context acquisition 26 required + 2 optional → 10 required + 2 optional; `agent-loop-driver.ts` 630 → 422 lines while the extracted Driver + Service boundary is 722 lines; Driver options 12 → 5; accepted model output persistence moved behind the capability boundary; `composition.ts` 1597 → 1594 lines while its new option helper makes the two-file composition source 1637 lines | typecheck; 47 agent-runtime/P3/P11 files with 320 tests; focused architecture 15; source-line transition gate |
| pending | 4 (E07) | Runtime Lifecycle, two seams, zero behavior change on the typed paths. (a) `execute-admitted-tool.ts`: the sandbox handle moved from a hand-written open→execute→close (close ran only on typed outcomes; an interrupted or defecting executor leaked the adapter handle) to an invocation-private Scope via `Effect.scopedWith` + `Scope.addFinalizerExit`; close failure keeps its `ToolRuntimeCleanupFailure`/`priorFailure` contract. (b) `adapters/sandbox-local`: `SandboxPortLive` now registers a Layer-scope finalizer that removes still-open legacy `arbor-sbx-*` roots, so Layer close has a real close path. Remaining E07 inventory (not migrated here, verified already scoped or out of the minimal slice): SQLite client closes through `SqliteClient.layer` finalizers; P39 writer permit and web transport use `acquireRelease`/`addFinalizer`; verification env preparation is `acquireRelease`-scoped with `prepareUnmanaged` bounded by the tool-runtime cleanup above; blob store holds no long-lived fds. | tool-runtime 195 (was 191; +4 lifecycle tests incl. fiber-interrupt release); sandbox-local 14 (was 13); adapters/sandbox-local + tool-runtime typecheck; single-workspace typecheck+build; p4-integration + p12-filesystem-runtime 8; architecture 270; lint; source-line transition gate unchanged (blocking 9 = baseline 9, no new non-legacy findings) |
| pending | 8 (SQL isolation, first slice) | SQLite persistence details isolated from two business-decision call sites; zero behavior change (before-count: 12 non-adapter source files carrying direct SQL / SQLite semantics, see branch report for the full inventory). (a) Scheduler completion-hold classification (`runnable-source-p7.ts`): direct `PRAGMA table_info(executions)` column probing, `executions` settlement SQL and `sqlite_master` table probing → two ports faces: `ExecutionRepository.listCompletionClaims` (adapter owns the binding-generation columns and the Completed/claim filter; returns `CompletionClaimRecord` with `bindingWorkRevision: null` marking pre-0024 legacy rows) and the new optional `CompletionHoldRead` probe (adapter-owned table-existence guard replacing the inline `sqlite_master` query; unavailable ⇒ both hold classifications skip, byte-equal to the old `serviceOption(SqlClient)`-none path). `runnable-source-p7.ts` now imports no SqlClient. (b) AnyProducer evidence assembly (`control-actions.ts`): direct `SELECT workspace_id FROM workspaces` → `WorkspaceRepository.listWorkspaceIdsByProject`; `control-actions.ts` no longer imports SqlClient. New adapter tests cover both faces (episode-bound claim rows, non-Work settlement exclusion, availability below/above the P8 baseline). Backlog (measured, not landed): `production.ts` (4 direct-SQL sites), `response-body.ts`, `registry.ts`/`projection-query.ts`/`main.ts` read faces, `health.ts` probe PRAGMA, composition startup-gate PRAGMA (mac-p4 test pins its source strings), and the seven one-shot ops scripts (`schema-upgrade*.ts`, `user-data-backup.ts`, `restore-drill.ts`, `storage-assessment-harness.ts`, `p6-inbox-rebuild.ts`, `retry-verification-origin-backfill.ts`) which use `node:sqlite` directly by design. | typecheck; architecture 270; p5-runnable-source 11, p7-classification/deadlock/acceptance 33, p10 rebuilds 9, p10 attention/tree-status 23, any-producer-evidence 45, ah10-command 32, new adapter suite 3; lint; naming gate blocking 0; source-line gate blocking 0 |

Cumulative against the driver baseline audit: E06 hidden-required
services 18 → 0; ModelDecisionDependencies 30 → 22 fields; the two
`Effect<void, unknown>` signatures typed; control-basis and invocation-ID
authorities relocated to their owning packages. The Model Decision seam now
owns capability resolution, binds and consumes the dynamic
`ControlBasisResolver`, owns Provider-turn decision/recovery, and owns the
durable accepted-output handoff. Provider admission and action admission
still share the Driver's per-drive safety state, and Provider network calls
remain outside long database transactions.

The seam does not claim that Model Decision internals are fully decomposed:
`ModelDecisionDependencies` remains a 22-field internal contract and the
Service Live layer currently acquires 20 required capabilities. The giant
dependency contract is direct E05 debt; the Layer surface is a separate
cohesion/ownership review, including four capabilities still acquired by
both Driver and Service. The completed change is that decision-internal
knowledge no longer leaks into the Agent Loop orchestrator or its public
options.
