# F21 OPEN-3 Wave3 — activation recovery

Date: 2026-10-10

Base: `257d540342d3da3cdfa2b8abdbd5d6688b38f56e`

Status: **Wave3 A (P11/P1 atomic activation) and B (P12
post-commit/startup orchestration) implemented and narrowly qualified. F21
OPEN-3 remains open pending broader owner qualification and separately
authorized path-repair behavior.**

## A — P11/P1 claim + Active transition

- Added `OwnershipWriteService.activatePendingWorkspaceResource` for the exact
  `(projectId, workspaceId, resourceBoundaryRevision)` intent. It verifies the
  supplied addresses match the currently persisted Workspace boundary before
  resolution and rechecks the pinned Workspace/intention inside the write
  transaction. It does not read ProjectResourceProfilePort or select a new
  boundary.
- Environment resolution and claim construction happen before the claim
  transaction. Inside one `BEGIN IMMEDIATE` / `TransactionScope`, the service
  checks current environment revision and overlap conflicts, inserts the
  complete claim set, records the environment anchor, CASes Pending→Active, and
  appends `WorkspaceResourceActivationChanged(Active)` v1 with the fixed
  system actor. Any failure, including event append failure after CAS, rolls
  all of these writes back together.
- AlreadyActive returns without resolving again or inserting claims/events.
  Competing independent SQLite client/transaction compositions recheck intent
  state after serialization; only one wins the claim/CAS/event write.

### A verification

```text
pnpm typecheck                                      PASS
Biome check (6 changed TypeScript files)            PASS
Vitest: ownership.test.ts + P1 recovery + P11 wiring 3 files / 25 tests PASS
  ownership.test.ts includes 4 activation-specific cases
git diff --check                                    PASS
```

The activation-specific assertions cover exact canonical-boundary matching,
one claim + one Active event, repeated AlreadyActive without another resolver
call, two independent database clients racing to activate one Pending tuple,
and injected journal failure after claim/CAS causing rollback to Pending with
zero claims/events. The two-client race uses two independent composition layers
and SQLite connections against one temporary file; it is not an OS-process
kill/restart qualification. No valid pre-implementation behavioral RED was
captured; early failures were test-fixture/API wiring issues, not evidence of a
production behavior regression.

## B — P12 post-commit/startup orchestration

- After a committed CreateProject receipt, the external transport reloads the
  exact persisted Workspace boundary and Pending intent, runs the P11 atomic
  activation, and reconciles the P10 source-only Attention projection whether
  activation succeeds or fails. A post-commit activation failure does not
  undo the receipt, Project, Workspace, Session, or Pending intent.
- Startup first source-reconciles each project with activation intents, then
  retries Pending intents only from their persisted Workspace boundary, and
  reconciles again after every attempt. Active intent truth removes stale
  activation Attention. This does not read/advance/reset a shared P10 event
  offset or resolve a replacement Profile.
- Added a process-local P11 test probe at immediately-before-commit and
  immediately-after-commit boundaries. Ordinary production startup leaves it
  absent; it is not configurable from environment or an HTTP request.
- A prior pre-intent v2 receipt is not backfilled into the new intent table;
  the exact replay compatibility branch remains separate. ConversationOnly
  workspaces have no activation intent/claim work.

### B verification

```text
pnpm typecheck                                      PASS
pnpm build                                          PASS
pnpm --filter @arbor/web build                     PASS (existing chunk-size warning)
P11 before/after commit kill + ordinary restart     2/2 PASS
  exact Pending/Active intent, claim, event and receipt facts checked
P12 startup Attention below retention floor/replay  1/1 PASS
  Pending source event removed, P10 offset=0 < retained floor;
  source-only startup reconcile makes public path-free Attention visible;
  exact same CommandId replay activates once and clears it
Biome on changed owned TS/MJS files                 PASS
```

The process test kill at `P11BeforeActivationCommit` proves the activation
transaction rolls back its uncommitted claim/CAS/Active event while preserving
the earlier committed CreateProject receipt and Pending status event. Kill at
`P11AfterActivationCommit` proves a committed claim/Active event survives and
startup removes a stale Pending Attention row from current Active intent truth.
Both recoveries retain one command receipt, one ownership claim, one Active
event, and no provider request. The retention-floor scenario injects a
claim-insert failure, deletes the Pending status event and activation Attention
row, places the P10 offset below the remaining journal floor, then restarts
while the failure remains. Public Attention is reconstructed from current
Pending intent truth independently of the lagging event watermark; the later
ordinary P10 event poll is separate. Exact receipt replay after removing the
trigger activates and clears the Attention.

The initial process-test attempts exposed test-harness issues only (custom
entry imported non-exported helpers, then awaited an HTTP response intentionally
held by the probe, then had an incorrect Attention target-field expectation).
Those were corrected; the final narrow cases passed. This evidence is not a
full release gate, does not qualify arbitrary resolver outages or repair, and
does not close F21 OPEN-3. Permanent unavailability remains Pending with
path-free Attention; no automatic Profile fallback or periodic path retry is
introduced. No full `pnpm check` or `pnpm test:functional` was run.

## Accepted OPEN-3 qualification matrix cross-check

The accepted proposal's full matrix was cross-checked after the repeated
restart addition. This table distinguishes an evidence layer from an actual
row closure; it does not infer OPEN-3 closure from nearby green tests.

| Proposal boundary | Current evidence | Disposition |
|---|---|---|
| Before CreateProject Gateway commit | `tests/p1-create-project.test.ts` verifies rollback leaves no Project/Workspace/Session/receipt/events/intent. | Partial: transactional unit evidence; exact fresh-daemon process kill before Gateway commit remains open. |
| After Gateway commit, before ownership activation | The public process test's SQLite trigger proves durable Committed state on activation failure. P11 probes cover inside its own claim transaction, not the exact Gateway-return/activation-entry instruction boundary. | Open: no exact public-process kill seam at this boundary. |
| Resolver/claim failure survives restart | New repeated-restart public process case keeps the claim-insert failure active through two separate daemon restarts; each restart retains Pending/one Attention/no claims/events. The retention-floor case separately deletes the Pending event/row and confirms public source reconciliation below floor. | Partial: claim-transaction failure is covered; a post-commit resolver failure from a physically unavailable persisted directory is not independently injected. |
| Same persisted boundary recovers once | Repeated-restart case removes the fault and replays the exact CommandId; it verifies one claim, one Active event, unchanged P1 entities/receipt, and a claim source-address snapshot equal to the original Workspace path even while the current public Profile version differs. `tests/f21-create-project-resource-admission.test.ts` also covers changed-snapshot receipt replay at the P1/application layer. | Pass for claim-failure recovery/exact receipt replay; not a substitute for the untested real resolver-outage restoration branch. |
| Same intent processed twice/concurrently | `adapters/persistence-sqlite/test/ownership.test.ts` races two independent SQLite-backed P11 service compositions and verifies one claim/CAS/Active event; repeated restart verifies idempotent sequential retries. | Partial: database-client concurrency and sequential restart are covered; two full P12 daemons racing the same intent are not. |
| Profile catalog changes while Pending | The repeated-restart case changes the public host Profile version to `review-v2` on both restart incarnations while the intent remains Pending; successful exact replay still writes the original stored Workspace boundary. | Pass for changed-version/no-rebind behavior during repeated Pending recovery; same-selector/different-directory process variant is not separately tested. |
| Path remains unavailable across retries | Repeated claim-insert failure produces the required stable Pending/one-row/no-claim behavior over two actual restarts. | Partial: the retried failure is an injected claim write fault, not a physically missing/unreadable resource path; permanent resolver failure remains open. |
| ConversationOnly | `tests/f21-create-project-resource-admission.test.ts` covers explicit empty boundary with no activation intent/claim; codec tests keep the selector closed. | Pass at the CreateProject integration/codec layer; no dedicated repeated-daemon ConversationOnly process case. |
| Attention rebuild after journal pruning | `tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts` removes the Pending event and source row, then verifies Story L reset/snapshot/offset rewind on both sides of process kill. | Pass at real SQLite process level. |
| P1 offset below retained floor | `tests/functional/process/f21-open3-activation-recovery.functional.test.ts` sets P10 offset below floor, prunes the Pending event and row, then confirms startup restores one public row; P10 reconciliation tests assert it does not mutate the shared offset. | Pass for Activation source-only recovery; generic `ConsumerRebuildRefused` remains intentionally unchanged. |
| Old Pending status event after Active | `tests/p10-activation-attention-reconciliation.test.ts` applies a stale Pending wakeup after CAS Active and verifies no Activation row. | Pass at P10 consumer/source unit layer. |
| Pending→Active versus rebuild/reconcile | Story L real-process tests use a lock-wait handshake, kill before commit, commit Active, then rebuild; the after-commit test commits Active before catch-up and proves catch-up clears Attention from current intent truth. | Pass for the tested SQLite serialization/replay orderings; not every possible multi-daemon schedule. |
| Pre-intent v2 receipt | Current F21 admission tests cover old v1 preserve-only collision, but do not seed a committed pre-intent v2 Workspace/receipt and assert no startup backfill. | Open: dedicated pre-intent v2 fixture/receipt qualification remains missing. |

The repeated-restart test itself passed as a targeted real-daemon case (1/1),
with two failed restarts while the failure remained active and exact replay
after fault removal. The evidence above intentionally leaves exact
pre-activation kill, physical resolver outage/restoration, two-daemon P11
competition, and pre-intent v2 no-backfill qualification OPEN. OPEN-1 and
OPEN-2 also remain independently open; F21 OPEN-3 is not closed.
