# Schema-42 current-migration call-site classification

Date: 2026-10-13  
Base: `4e093afb9be038576f1d0e8a8628c32e502b2f57`

## Classification rule

`CURRENT_MIGRATIONS` now represents the ordinary schema-42 migration target,
with P39 performed only by its dedicated offline maintenance path. A test that
starts or drives `ProductionDaemonService` or `runDaemonOnce` therefore needs a
real schema-42 database created by `createSchema42TestDatabase()` before the
runtime starts. Lower-level and explicitly historical phase tests do not
construct that production daemon; their former `CURRENT_MIGRATIONS` calls
implicitly meant the pre-activation P38 baseline. They will name
`P38_MIGRATIONS` explicitly. Existing tests that already select P12/P35/etc.
remain as written.

## Current production runtime — use schema-42 fixture

| File | Call-site intent |
|---|---|
| `apps/single-workspace/test/blocked-workepisode-restart-wake.test.ts` | Calls `runDaemonOnce` against durable restart state. |
| `apps/single-workspace/test/mac-p1-root-work-initiation.test.ts` | Starts `ProductionDaemonService` for RootConversation approval and resume. |
| `apps/single-workspace/test/mac-p2-parent-accept-result.test.ts` | Drives Parent Agent acceptance through `ProductionDaemonService`. |
| `apps/single-workspace/test/mac-p2-formation-fulfillment.test.ts` | Polls production consumers and drives formation fulfillment. |
| `apps/single-workspace/test/mac-p3-dependency-delivery.test.ts` | Drives production dependency/delivery consumers. |
| `apps/single-workspace/test/p13-web-e2e.test.ts` | Exercises the assembled production Web/daemon path. |
| `apps/single-workspace/test/p14-real-provider-conversation.test.ts` | Both real-provider scenarios use `ProductionDaemonService`. |
| `tests/p12-production-composition.test.ts` | B-7/B-8 starts the production daemon and exercises `runDaemonOnce`; B-6 remains a P38 slice test. |
| `tests/capability/support/public-chat.ts` | Shared real-process/public-chat harness starts the production daemon. |
| `tests/capability/gray-box/b01-public-conversation.test.ts` | Explicit B01 HTTP plus production-daemon qualification. |

## Historical/lower-level slice — freeze at P38

These sites do not start `ProductionDaemonService` or `runDaemonOnce`; P38 is
the last ordinary pre-activation prefix and preserves the database shape these
slice tests previously received when schema 38 was current.

| File | Classification reason |
|---|---|
| `apps/single-workspace/test/p5-composition.test.ts` | Composition-layer migration check, not production-daemon startup. Its expected version 38 is retained and explicitly described as historical P38. |
| `apps/single-workspace/test/p5-yield-wake.test.ts` | I0 Wait route / P2 WorkWait slice. |
| `apps/single-workspace/test/p5-slice-acceptance.test.ts` | I0 executable/control slice; update the stale comment to name the P38 prefix. |
| `apps/single-workspace/test/p5-session-continuity.test.ts` | Application-layer session continuity scenario. |
| `apps/single-workspace/test/p5-restart-continuity.test.ts` | Layer recreation/recovery scenario, not the production daemon entry point. |
| `apps/single-workspace/test/p5-directive-unsupported.test.ts` | Historical obsolete-envelope rejection contract. |
| `apps/single-workspace/test/p5-completion-claim.test.ts` | Historical obsolete completion-claim representation contract. |
| `apps/single-workspace/test/wave2-claim-completion.test.ts` | Model-facing action and claim integration through the slice layer, without production-daemon startup. |
| `apps/single-workspace/test/i0-send-message-durable.test.ts` | Direct durable command/observation integration through the slice layer. |
| `apps/single-workspace/test/mac-p1-workspace-knowledge.test.ts` | Deterministic Knowledge projection/read-model qualification. |
| `apps/single-workspace/test/mac-p2-workspace-placement.test.ts` | Workspace placement read/reference qualification through the slice layer. |
| `apps/single-workspace/test/p14-conversation-history-pagination.test.ts` | Conversation-history query/cursor qualification through the slice layer. |
| `tests/p12-runtime-safety.test.ts` | Direct command/runtime-safety integration; does not start the production daemon. |
| `tests/p12-secret-store.test.ts` | Secret-store/command integration through the slice layer. |
| `tests/p12-transport.test.ts` | Transport boundary and command-composition tests; no production-daemon startup at these two sites. |
| `tests/p12-acceptance.test.ts` | Direct command/runtime-safety acceptance scenario at the sole current-prefix call site. |
| `tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts` | Direct view/read authorization boundary tests; do not start the production daemon. |
| `tests/f21-create-project-resource-admission.test.ts` | Direct command/resource-admission integration through the slice layer. |
| `tests/p12-production-composition.test.ts` B-6 only | P7 `RunnableWorkSource` classification through the slice layer; it does not start the daemon. |

## Non-call-site match

`tests/architecture/mac-p4-convergence.test.ts` contains a source-text
assertion for the production `runMigrations(CURRENT_MIGRATIONS)` wiring. It does
not initialize a database and is not a migration fixture call site.

The current-runtime sites will use the existing schema-42 real-file helper;
this classification does not change production runtime/registry behavior,
P39 policy, or frozen design documents.
