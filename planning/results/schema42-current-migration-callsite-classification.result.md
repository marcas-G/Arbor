# Schema-42 current-migration call-site classification

Date: 2026-10-13
Base: `4e093afb9be038576f1d0e8a8628c32e502b2f57`

## Classification rule

Any test that instantiates `buildSingleWorkspaceLayer`, `ProductionDaemonService`,
`runDaemonOnce`, or current transport/composition is a current-runtime contract.
`buildSingleWorkspaceLayer` itself installs the current schema gate and P39
writer boundary, even when a test only asks it for a lower-level service.
Fresh databases for those contracts must therefore be prepared as real schema
42 fixtures before composition starts; the production runtime's migration
hook then remains responsible for its normal no-op/current check.

Only adapter/store tests and historical migration-boundary/descriptor tests
that do not construct the current composition may use a frozen migration
prefix. The two P12 transport cases use `P38_MIGRATIONS`: they assemble adapter
and transport services directly, without `buildSingleWorkspaceLayer` or the
production daemon. Existing explicit P12/P35/etc. test prefixes remain intact.

## Current composition/runtime — use schema-42 fixture

| File | Call-site intent |
|---|---|
| `apps/single-workspace/test/blocked-workepisode-restart-wake.test.ts` | Calls `runDaemonOnce` against durable restart state. |
| `apps/single-workspace/test/i0-send-message-durable.test.ts` | Current slice composition executes durable SendMessage actions. |
| `apps/single-workspace/test/mac-p1-root-work-initiation.test.ts` | Starts `ProductionDaemonService` for RootConversation approval and resume. |
| `apps/single-workspace/test/mac-p1-workspace-knowledge.test.ts` | Constructs the current composition for the Knowledge read model. |
| `apps/single-workspace/test/mac-p2-formation-fulfillment.test.ts` | Polls production consumers and drives formation fulfillment. |
| `apps/single-workspace/test/mac-p2-parent-accept-result.test.ts` | Drives Parent Agent acceptance through `ProductionDaemonService`. |
| `apps/single-workspace/test/mac-p2-workspace-placement.test.ts` | Constructs the current composition for placement reads. |
| `apps/single-workspace/test/mac-p3-dependency-delivery.test.ts` | Drives production dependency/delivery consumers. |
| `apps/single-workspace/test/p13-web-e2e.test.ts` | Exercises the assembled production Web/daemon path. |
| `apps/single-workspace/test/p14-conversation-history-pagination.test.ts` | Constructs current composition for conversation-history reads. |
| `apps/single-workspace/test/p14-real-provider-conversation.test.ts` | Both real-provider scenarios use `ProductionDaemonService`. |
| `apps/single-workspace/test/p34-attention-projection-daemon.test.ts` | Starts the daemon and verifies Attention storage on schema 42. |
| `apps/single-workspace/test/p5-composition.test.ts` | Builds the full current slice; its former version-38 assertion was stale and is updated to schema 42. |
| `apps/single-workspace/test/p5-completion-claim.test.ts` | Current composition handles the legacy completion-claim rejection contract. |
| `apps/single-workspace/test/p5-directive-unsupported.test.ts` | Current composition handles the legacy directive rejection contract. |
| `apps/single-workspace/test/p5-restart-continuity.test.ts` | Rebuilds the current composition over a durable database. |
| `apps/single-workspace/test/p5-session-continuity.test.ts` | Exercises session continuity through the current composition. |
| `apps/single-workspace/test/p5-slice-acceptance.test.ts` | Current executable/control slice; its P8 schema comment is kept separate from DB baseline. |
| `apps/single-workspace/test/p5-yield-wake.test.ts` | Runs the current I0 Wait/P2 WorkWait slice. |
| `apps/single-workspace/test/wave2-claim-completion.test.ts` | Model-facing action and claim integrations use the current composition. |
| `tests/capability/support/public-chat.ts` | Shared capability harness starts the current production daemon. |
| `tests/capability/gray-box/b01-public-conversation.test.ts` | Explicit B01 HTTP plus production-daemon qualification. |
| `tests/f21-create-project-resource-admission.test.ts` | Resource-admission scenarios construct the current composition. |
| `tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts` | View/read authorization scenarios construct the current composition. |
| `tests/p12-acceptance.test.ts` | The single current-safety acceptance scenario constructs the current composition. |
| `tests/p12-production-composition.test.ts` | B-6 and B-7/B-8 both construct current composition; B-7/B-8 starts the daemon. |
| `tests/p12-runtime-safety.test.ts` | Safety integration constructs current composition. |
| `tests/p12-secret-store.test.ts` | Secret-store/command integration constructs current composition. |

## Historical adapter/transport — freeze at P38

| File | Classification reason |
|---|---|
| `tests/p12-transport.test.ts` | Its two formerly-current call sites build persistence/application/transport adapter layers directly and do not instantiate the current composition or production daemon. |

## Non-call-site match

`tests/architecture/mac-p4-convergence.test.ts` contains source-text assertions
for production's `runMigrations(CURRENT_MIGRATIONS)` wiring. It does not
initialize a database and is not a migration fixture call site.

The original call-site classification changes no production runtime/registry
behavior, P39 policy, or frozen design documents.

## P5 schema-42 settlement follow-up

The production composition now provides both `P39RecoveryEvidenceStoreLive`
and `ToolObservationEvidenceStoreLive` from its existing SQLite `infra` layer.
The low-level ToolRuntime still retains its optional service/fallback behavior;
the schema-42 production composition no longer omits either service.

The P5 slice initially exposed two composition/P39 integration defects:

1. The current composition omitted the P39 RecoveryBinding and P40 canonical
   ToolObservationEvidence store projections.
2. After wiring the P39 store, builtin `ToolDefinition.hash` values such as
   `shell-v2-mount-relative-cwd` failed the closed RecoveryBindingV1 SHA-256
   field validation. Runtime now hashes the unchanged stable definition token
   through `toolDefinitionIdentityDigestV1`; the catalog token, P39 schema, and
   admission/settlement guards are unchanged.

The P5 slice now asserts a successful shell invocation is `Bound`, has a
terminal `Success`, and durably stores canonical P40 observation bytes/hash;
it also checks the P39 attempt-0 definition identity is a 64-character
lowercase SHA-256 without pinning a digest value. The architecture test asserts
the production P39/P40 wiring while preserving the optional low-level
fail-safe path.

Verification on the updated branch:

- Ports RecoveryBinding vectors, ToolRuntime definition-hash projection, and
  P5 slice: **3 files / 7 tests passed**.
- The seven migrated P5 suites: **7 files / 7 tests passed** (322.97s,
  single worker).
- P39/P40 production-composition architecture suite: **2 tests passed**.
- `pnpm typecheck`, Biome, and `git diff --check`: passed after final diagnostic
  cleanup.

No design document, P39 schema, generic migration registry, or safety gate was
changed.
