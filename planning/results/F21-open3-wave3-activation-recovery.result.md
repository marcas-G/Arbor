# F21 OPEN-3 Wave3 — activation recovery

Date: 2026-10-10

Base: `257d540342d3da3cdfa2b8abdbd5d6688b38f56e`

Status: **Wave3 A (P11/P1 atomic activation) implemented and targeted green;
Wave3 B (P12 post-commit/startup orchestration) not yet implemented. F21
OPEN-3 remains open.**

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

## B — P12 orchestration (pending)

Not yet implemented: post-commit activation/reconciliation, startup scan and
same-boundary retry, public Attention failure/clear visibility, retention-floor
recovery, or fresh-daemon kill/restart qualification. No P12 runtime call was
added in this A-stage commit. There is no automatic Profile fallback; permanent
path unavailability remains Pending/visible until a separately authorized
repair route exists. No full `pnpm check` or functional suite was run.
