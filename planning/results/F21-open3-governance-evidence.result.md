# F21 OPEN-3 Post-Commit Activation — Governance Evidence

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Status: **Design gap evidence / proposal only. No design landing or production
implementation is authorized by this record.**

Proposal: `planning/proposals/F21-postcommit-resource-activation-recovery-draft.md`.

## Existing state and failure window

- `packages/application/src/commands/create-project.ts` commits the Project,
  root Workspace canonical boundary, Primary Session, `ProjectCreated(v1)`,
  `WorkspaceCreated(v1)`, and the Committed receipt through the existing
  Gateway transaction.
- `apps/single-workspace/src/transport/composition.ts` calls
  `activatePersistedWorkspaceIfMissing` only after Gateway returns a Committed
  receipt. It re-reads the Workspace boundary, then activates ownership in a
  separate transaction. An exact receipt replay can call this post-commit
  convergence path again; it does not re-resolve the Profile.
- The current P10 `02` Attention source map has no pending resource-activation
  source. The P12 startup path has no scan of committed Workspace boundaries
  or pending ownership activation; observed startup recovery scans runnable
  work/executions.
- Current Project metadata has no Profile selector/source. Workspace stores
  the canonical boundary; `commands` stores the receipt indexed by CommandId,
  not an independently queryable Project→CreateProject payload mapping.
- The default P1 `05` event reader ceiling is EventVersion 1; higher versions
  are poison/quarantined. Adding ProjectCreated v2 is therefore not a
  no-migration shortcut.

F21 Wave B evidence already qualifies the successful v2 Profile path,
ConversationOnly boundary, path-free public rejection, and successful
same-receipt restart replay. Wave C qualifies the default browser Profile
journey and negative path/ref cases. Neither wave injects failure or process
death between the committed receipt and ownership activation. This OPEN-3
record does not reclassify those green results.

## Isolated RED evidence

Added `tests/functional/pending/f21-postcommit-activation-recovery.functional.test.ts`.
It submits CreateProject v2 Profile through the real daemon/public `/commands`
route while a SQLite test-only trigger makes the separate post-commit
ownership-claim transaction fail. The test independently confirms the durable
Command is still Committed, Project/Workspace/Session and v1 events exist, and
no ownership claim exists. It keeps the injected failure through daemon
restart and expects a public path-free P10 Attention row; current P10 returns
no such row. This is a deterministic adapter-failure reproduction of the
committed/unactivated state, not a claim that the test killed the process at
the exact instruction boundary. A dedicated process-local after-commit/before-
activation kill seam is still required for final qualification.

The targeted test was run in this isolated source worktree only:

- Command: `pnpm exec vitest run --config
  vitest.pending-functional.config.ts
  tests/functional/pending/f21-postcommit-activation-recovery.functional.test.ts`.
- **1 test failed as intended (RED, 6.78 s):** all preceding assertions
  passed—the HTTP request did not report success, the response omitted the
  host path, SQLite showed one Committed receipt/Project/Workspace and zero
  active ownership claims, and the daemon restarted. No claim existed after
  restart. After the test removed the injected failure, an explicit replay of
  the same current v2 request returned the same Committed receipt and created
  one claim without duplicating its two events. The post-restart public
  Attention snapshot nevertheless had zero rows (`expected 0 to be greater
  than 0`).
- This proves the current trigger-injected post-commit failure has no visible
  durable Attention after restart and that the exercised convergence route is
  caller replay. It does not prove an exact process kill at the instruction
  boundary or any proposed automatic recovery behavior.
- The failing assertion is scoped to missing public Attention; it does not
  imply failure of F21's normal Profile creation journey.
- No test helper, production source, migration, `docs/design/**`, or shared
  fixture was modified. The SQLite trigger is test-local and removed in
  `finally`.

## Open boundaries

- OPEN-3 remains open pending manual acceptance and owner landing of durable
  intent/status, restart recovery, P10 source/clear semantics, and the
  non-rebinding repair boundary.
- OPEN-1 Profile-source audit and OPEN-2 historical v1 same-ID replay remain
  separate and open. F23 auth/wire/Actor/Resolver/Gateway tuple order and
  preserve-only old v1 rows are unchanged.
- This RED does not prove the exact kill seam or after-success recovery matrix;
  those are required by the proposal's qualification table.
- Existing Workspace Detail can display canonical Workspace addresses; this
  proposal adds no path to catalog, activation intent, failure, or Attention
  DTO. If the product requirement forbids any canonical path in UI, that is a
  separate existing P10/P13 display contract to govern.

## Independent-review follow-up — materialized Attention contract

The initial independent review identified one blocking ambiguity: P10 Attention
is incrementally materialized by the P1 generic event consumer, while the first
draft did not define an event/invalidation path for Pending → Active or a
retention-safe rebuild source. The proposal now selects the event-backed
incremental path and makes the intent table the level-triggered rebuild source:

- A single new `WorkspaceResourceActivationChanged` domain event starts at
  EventVersion 1, with the closed tagged payload
  `{ _tag: "WorkspaceResourceActivationChanged", workspaceId,
  resourceBoundaryRevision, status: Pending | Active }`.
  Pending is appended atomically with the existing CreateProject state,
  receipt, unchanged ProjectCreated/WorkspaceCreated v1 events, and intent.
  Active is appended atomically with the ownership claim set and the CAS to
  Active. No ProjectCreated v2, reader-ceiling bump, path, Profile ref/version,
  or filesystem failure detail is introduced.
- P10 incrementally upserts/deletes the exact `(projectId, workspaceId,
  resourceBoundaryRevision)` row; generic `(projectId, sequence)` replay and
  this stable source key make consumer crash/redelivery and multiple daemons
  idempotent. Full rebuild reconciles Pending rows from current intent state,
  so journal retention cannot erase a still-pending Attention.
- The additive migration does not infer intents for pre-migration v2
  committed-but-unactivated rows from path/no-claim state. Existing canonical
  state, events, and receipts remain unchanged; only exact current-v2 replay
  may retry the durable boundary. A still-failing pre-intent v2 row remains
  outside the new automatic intent/Attention guarantee and requires a separate
  reviewed adoption disposition. Historical v1 remains preserve-only.
- Until separately designed periodic retry, restoring a path while the daemon
  remains running requires exact current-v2 replay or restart. A permanently
  unavailable path remains Pending/visible and is never automatically rebound;
  this proposal provides no alternative-boundary repair API.

The P1 v1 event rule explicitly permits a newly defined event type to begin at
EventVersion 1; the new type must be added to the DomainEvent catalog and P10
consumer rather than treated as an unknown successfully handled event. This
does not change any existing event schema/version rule. The revision addresses
the review's Attention trigger/rebuild blocker at proposal level only; OPEN-3
still awaits manual acceptance, owner landing, and qualification. No production,
test, or `docs/design/**` files were changed and no tests were run.

Revised proposal LF-normalized blob SHA-256:
`E6EEE5CE68B78328FE96D3D14387A34F9B05F31C6BE8E53D4FB2701EE7728ECE`.
