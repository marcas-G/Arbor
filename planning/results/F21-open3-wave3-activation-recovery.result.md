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
