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
- Added a process-local CreateProject probe after the Gateway returns the
  committed receipt and before P11 activation is entered. The fresh-daemon
  test kills at that exact boundary; recovery is driven by startup and does
  not require resending the command.
- P11 activation uses the existing full `EnvironmentResolverPort` observation
  when present and requires affirmative `exists:true` for each pinned
  FileTree/GitWorktree. A missing resolver or `exists:false` fails closed with
  a path-free error; it never falls back to the legacy ProjectEnvironmentPort
  projection that omits the probe fact. General resolver snapshot observation
  semantics are unchanged.
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
Gateway commit/pre-P11 kill + startup auto-recovery 1/1 PASS
  Committed receipt + Pending intent; no client resend; unique auto-activation
Missing persisted FileTree + two restarts + restore 1/1 PASS
  one public Attention each unavailable restart; same-path startup recovery
P12 startup Attention below retention floor/replay  1/1 PASS
  Pending source event removed, P10 offset=0 < retained floor;
  source-only startup reconcile makes public path-free Attention visible;
  exact same CommandId replay activates once and clears it
ownership.test.ts                                    10/10 PASS
Biome on changed owned TS/MJS files                 PASS
```

Additional focused qualification:

```text
P11 resolver unavailable + GitWorktree exists:false 2 unit cases PASS
  Pending intent, zero claims, no Active event
Gateway-committed/pre-P11 process kill + restart     1/1 PASS
Missing persisted FileTree + 2 restarts + restore    1/1 PASS
ownership.test.ts                                    10/10 PASS
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
The newly added missing-path scenario initially exposed a real P11 behavior
gap: the full resolver emitted a successful `exists:false` observation for a
missing FileTree, while the legacy ProjectEnvironmentPort projection dropped
that fact and activation committed a claim/Active event. P11 activation now
consumes the full resolver observation and fails closed on missing resolver or
`exists:false`. The unavailable path remains Pending across two real daemon
restarts with one path-free Attention and no claim/event duplication; after
the exact same directory is restored, startup activates the persisted boundary
without client replay or reselecting the Profile. GitWorktree `exists:false`
and a missing full resolver also have targeted unit coverage. The final narrow
cases passed. This evidence is not a
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
| Before CreateProject Gateway commit | `tests/p1-create-project.test.ts` injects a pre-commit transaction failure and verifies no Project/Workspace/Session/receipt/events/intent. | PASS at P1 transaction rollback layer; this row is distinct from the required post-commit/P11 seam below. |
| After Gateway commit, before ownership activation | `tests/functional/process/f21-open3-activation-recovery.functional.test.ts` kills at the test-only Gateway-committed/pre-P11 marker, verifies one Committed receipt and Pending intent/no claim, then restarts; startup activates without client resend. | PASS, real daemon/public CreateProject + SQLite postconditions. |
| Resolver/claim failure survives restart | Repeated claim-insert failure survives two real restarts; missing persisted FileTree also survives two real restarts. Each keeps Pending, one path-free Attention, zero claims and one Pending event. | PASS for both claim-failure and physical missing-path failure branches; offset-below-floor restoration is a separate passing case. |
| Same persisted boundary recovers once | The missing-path process test restores the exact moved directory and starts a new daemon; no request is resent. It verifies one claim snapshot equal to the original Workspace path, one Active event, unchanged Project/Workspace/Session/receipt and cleared Attention. | PASS, automatic startup recovery of the exact stored boundary. |
| Same intent processed twice/concurrently | `adapters/persistence-sqlite/test/ownership.test.ts` races two independent SQLite-backed P11 service compositions and verifies one claim/CAS/Active event; process tests cover sequential restarts and no duplicate effects. | P11 race unit and repeated restart PASS. Two full P12 daemons racing the same intent remain an optional stronger schedule, not a required closure blocker under the final review. |
| Profile catalog changes while Pending | The repeated-failure test changes the available public Profile version on both restart incarnations while Pending; the successful exact replay retains the original Workspace boundary. The missing-path test also observes the Profile as unavailable while retaining the same persisted boundary/version. | PASS for version change and pinned-boundary behavior; no reselect occurs during activation. |
| Path remains unavailable across retries | The process test renames the real Workspace directory away, performs two separate daemon restarts, and checks each public Attention view has exactly one path-free row with Pending intent and zero claims. Restoring the same directory followed by restart activates once. | PASS, physical missing-path failure/recovery at real-process level. |
| ConversationOnly | `tests/f21-create-project-resource-admission.test.ts` covers explicit empty boundary with no activation intent/claim; codec tests keep the selector closed. | Pass at the CreateProject integration/codec layer; no dedicated repeated-daemon ConversationOnly process case. |
| Attention rebuild after journal pruning | `tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts` removes the Pending event and source row, then verifies Story L reset/snapshot/offset rewind on both sides of process kill. | Pass at real SQLite process level. |
| P1 offset below retained floor | `tests/functional/process/f21-open3-activation-recovery.functional.test.ts` sets P10 offset below floor, prunes the Pending event and row, then confirms startup restores one public row; P10 reconciliation tests assert it does not mutate the shared offset. | Pass for Activation source-only recovery; generic `ConsumerRebuildRefused` remains intentionally unchanged. |
| Old Pending status event after Active | `tests/p10-activation-attention-reconciliation.test.ts` applies a stale Pending wakeup after CAS Active and verifies no Activation row. | Pass at P10 consumer/source unit layer. |
| Pending→Active versus rebuild/reconcile | Story L real-process tests use a lock-wait handshake, kill before commit, commit Active, then rebuild; the after-commit test commits Active before catch-up and proves catch-up clears Attention from current intent truth. | Pass for the tested SQLite serialization/replay orderings; not every possible multi-daemon schedule. |
| Pre-intent v2 receipt | `adapters/persistence-sqlite/test/p35-workspace-resource-activation-migration.test.ts` seeds a committed pre-intent v2 receipt/Workspace/events before P35 and verifies migration preserves them without synthesizing an intent or Attention row. | PASS for the accepted migration/no-backfill disposition. The existing exact-replay compatibility path remains separate from new Pending intents. |

The repeated-restart test itself passed as a targeted real-daemon case (1/1),
with two failed restarts while the failure remained active, a changed Profile
version, and exact replay after fault removal. The two final-review blocking
cases—Gateway-committed/pre-P11 kill and physical missing-path restart/recovery—
now have real-process evidence. Two-full-P12-daemon competition remains an
optional stronger schedule. OPEN-1 and OPEN-2 remain independently open; the
overall F21 OPEN-3 status still awaits independent final review and is not
claimed formally closed here.
