# F23 P6 Owner/Parent Route Move and Production Rebuild — Design Gap

Status: **IMPLEMENTATION STOPPED AT PLAN STOP CONDITION**

## Authorization and evidence boundary

This audit is under `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION`
and fixed plan
`planning/proposals/F23-permanent-replay-origin-implementation-plan.md`
(raw SHA-256
`766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`). No
`docs/design/**` files were changed. The audit used source inventory and
disposable tests only; no preserved/online database was accessed.

## Exact N/A / blocker

The accepted route contract requires an existing P1 command that changes the
canonical Work owner or Workspace Parent and, in that same Gateway transaction,
moves the stable-key Inbox row. The implementation plan also requires route
change before/after commit crash qualification. The production source inventory
contains no such command or transaction:

- `WorkRepository` updates objective, completion expectation, verification
  mission, lifecycle and timestamps; it has no owner/workspace reassignment
  operation. Search of `packages/application/src/commands` and production
  application source found no update to `works.workspace_id`.
- `WorkspaceRepository` updates responsibility, resource boundary, policy,
  current Work, primary Session and lifecycle; it has no Parent reassignment
  operation. Search found no update to `workspaces.parent_workspace_id`.
- Formation inserts a new child with its initial Parent; it does not move an
  existing Workspace.
- Production Inbox operations admit, list and consume entries. The newly added
  same-key route helper is available inside a `TransactionPort` scope, but no
  current owner/Parent Gateway handler can call it.

Therefore there is no public command path against which to prove old-recipient
denial/new-recipient visibility or the requested command-level crash sides.
The P45 test that updates the Parent row and Inbox row together, then injects a
transaction rollback and commit, proves only the SQLite transactional helper;
it is not a P1 Gateway command or daemon crash qualification and is not claimed
as one.

There is likewise no production P10 projection rebuild entry to extend:
`rebuildProjection` (`adapters/persistence-sqlite/src/consumer.ts`) has no
production call site under `apps/single-workspace/src`; its callers are tests
and qualification harnesses. The production P10 worker is the AttentionPoll
consumer, which is explicitly not an Inbox projection source. The new
`rebuildUnboundLegacyInboxProjections` repository method is currently exercised
by the disposable rebuild test but cannot be wired to an existing production
rebuild API without adding a new operator/application surface or changing P10
behavior.

## Qualification disposition

- **Exact N/A:** no current P1 owner/Parent mutation command exists, so the plan's
  command-level route-move/crash row has no subject to qualify.
- **Design gap:** the accepted P6/P1 contract does not identify a production
  rebuild caller, while this implementation scope forbids inventing a new
  owner/Parent command or repurposing P10 Attention as an Inbox source.
- The route helper and derived/current-authority reads are implemented and
  their adapter-level transaction/read tests pass, but they do not close this
  gap. Do not claim P6 route-move or production-rebuild qualification complete.

Manual governance must decide whether these requirements are explicitly N/A
until an owner/Parent mutation and rebuild surface is separately authorized, or
whether to authorize a design amendment identifying those owning production
entry points and command semantics. Implementation is stopped pending that
decision. No new command, migration, async reconciliation path, or P10 Attention
source is invented here.
