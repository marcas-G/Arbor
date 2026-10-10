# F21 OPEN-3 — final implementation qualification review

Date: 2026-10-10

Reviewed source: `b6b383162fb91ed95b75d3b0046d3ba2917888d8`

Status: **The accepted OPEN-3 contract matrix has no remaining semantic
Blocking. Integrated P10 qualification at b6 is pending a test-fixture update
and rerun. This is not OPEN-1/OPEN-2 closure or release validation.**

Review scope: the accepted F21 OPEN-3 proposal and landed P1/P10/P11/P12 owner
contracts; implementation and targeted evidence through the reviewed source
commit. This review was read-only. No production, design, Web, or view files
were changed by the reviewer. The two pre-existing Web/views working-tree
changes were left untouched.

## Decision

The previously blocking Gateway-commit/P11-entry crash window and physical
resource-unavailable/recovery path now have real-process evidence. The
remaining proposal rows are either qualified or covered by the proposal's
explicit alternative evidence paths. The source-level accepted matrix has no
remaining semantic OPEN-3 blocker.

Integrated qualification is not yet complete at b6. The P10 Story L custom
full-rebuild child was reported failing in a targeted integration run after
the P11 fail-closed change: its test-only composition supplies only the old
`ProjectEnvironmentPort` and uses a synthetic, nonexistent path, so activation
now correctly refuses to create a claim. The integrator is updating that
fixture to use a real temporary directory and the full
`EnvironmentResolverPort`; no business code change is reported. The earlier
Story L process evidence at `522c1a9` does not count as a b6 green rerun. Keep
the P10 integrated row pending until the corrected fixture reruns successfully.

This recommendation is scoped to OPEN-3's accepted implementation contract.
`pnpm check` and the full `pnpm test:functional` suite were not run at this
source commit. The reported typecheck/build, changed-file Biome, focused unit,
and focused process results do not constitute a full repository gate or release
readiness claim.

## Previously blocking boundaries

### Gateway committed, before P11 activation

`tests/functional/process/f21-open3-activation-recovery.functional.test.ts`
injects the process-local `GatewayCommittedBeforeP11Activation` probe after
the Gateway returns the Committed receipt and before `afterCommitted` enters
P11. The test kills the first real daemon at that point. Before the kill, it
checks one Committed receipt, Project, Workspace, Session, and Pending intent;
one Pending event; and zero active claims. After restart, without resending the
CreateProject request, it checks Active intent, one claim bound to the original
persisted Workspace address, one Active event, one receipt, and no remaining
public Activation Attention. The public Attention response contains no host
path and no provider call occurs.

This closes the exact process boundary required by the accepted matrix; the
earlier P11-before-transaction-commit case is additional evidence, not the
substitute for this boundary.

### Physical FileTree unavailability and same-path recovery

The same process test commits CreateProject at the Gateway/P11 seam, kills the
daemon, then renames the persisted Workspace directory away. Across two
separate real daemon restarts, it confirms the Profile is unavailable, while
the canonical Project/Workspace/receipt and Pending intent remain unchanged;
there are zero claims and no Active event. Each restart produces exactly one
public `WorkspaceResourceActivationPending` row with the same dedup key, and
the public Attention response omits the path. The test then restores the
directory to its original path and restarts again without a client request. It
confirms startup creates exactly one claim whose source-address snapshot is
the original persisted path, appends one Active event, and clears Attention.

This covers actual resolver `exists:false` behavior, repeated unavailable
restarts, and recovery by restoring the same boundary. It does not rely on a
claim-insert trigger to simulate path failure.

## Resolver contract review

Production composition provides `EnvironmentResolverLocalLive` to the
ownership service. The local resolver treats `ENOENT` as a successful
observation with `exists:false` for both FileTree and GitWorktree; other probe
errors are typed failures. P11 activation consumes the full, read-only
`EnvironmentResolverPort` observation so the existence fact is not lost in the
legacy `ProjectEnvironmentPort` projection. A missing full resolver, resolver
failure, or `exists:false` for a pinned FileTree/GitWorktree fails closed before
claim insertion, leaving the intent Pending and producing no claim or Active
event. The general resolver observation and ProjectEnvironmentPort projection
semantics are unchanged.

The 10-case `adapters/persistence-sqlite/test/ownership.test.ts` evidence
includes a missing-EnvironmentResolverPort case and a GitWorktree
`exists:false` case. The real process test covers a physically missing
FileTree. Environment observation remains read-only; the activation path
derives addresses from the exact persisted Workspace boundary and does not
depend on `ProjectResourceProfilePort`. The restored claim is checked against
the original path, so there is no Profile re-selection or boundary retargeting.

P11 `10` names `ProjectEnvironmentPort` in its implementation prose, while
activation reads that port's existing full `EnvironmentResolverPort` source to
retain the already-defined probe fact. This is a nonblocking route-level
wording difference: it uses the same resolver regions and observed revision,
adds no resolver write or authority, and is necessary to honor P12's frozen
unavailable-path behavior. No new domain or recovery semantics were introduced.

The Active-event append-failure test also confirms
`EnvironmentRevisionStore.current` is `None` both before and after the failed
transaction, with Pending intent, null `activatedAt`, zero claims, and no
Active event. This verifies anchor, claim, intent, and event rollback as one
P11 transaction.

## Accepted OPEN-3 qualification matrix

The status below follows the accepted proposal's alternatives and owner
contracts. “Pass” refers to the listed focused evidence, not to a full repo
gate.

| Boundary | Evidence and result | Disposition |
|---|---|---|
| Before CreateProject Gateway commit | `tests/p1-create-project.test.ts` injects a pre-commit transaction failure and confirms no Project, Workspace, Session, receipt, events, or intent. | **Pass** — the matrix permits kill or transaction failure. |
| After Gateway commit, before P11 activation | Exact process-local seam; kill; durable receipt/Pending intent/no claim; startup auto-activation without resend; public Attention cleared. | **Pass** — real daemon and public CreateProject/Attention paths. |
| Resolver or claim failure across restart | Physical missing FileTree across two restarts; Pending and one path-free Attention persist, no claims or Active event. Claim-insert failure across two restarts is also covered. | **Pass** — both resolver and claim-write failure classes. |
| Recovery after same path is restored | Restore the original directory and restart; one claim from the persisted Workspace address, one Active event, Attention cleared, no request resend or P1 duplication. | **Pass**. |
| Same intent processed twice/concurrently | Two independent SQLite-backed P11 compositions race and produce one claim/CAS/Active event; production daemon restart and exact receipt replay exercise idempotent sequential processing. | **Pass** under the proposal's “two daemon workers or startup plus exact receipt replay” alternatives. A simultaneous race between two complete P12 daemons remains an optional stronger schedule. |
| Profile catalog changes while Pending | Repeated-failure restart case changes the available Profile version while Pending and later confirms the claim uses the stored Workspace address. The physical missing-path case confirms the Profile can be unavailable while intent remains pinned. | **Pass** — activation does not reselect or retarget a Profile. |
| Path remains unavailable across retries | Two real restarts while the persisted directory is moved away; each retains exactly one Pending Attention row and zero claims; restoring the same path then activates once. | **Pass**. |
| ConversationOnly | `tests/f21-create-project-resource-admission.test.ts` verifies empty boundary, no activation intent, and no ownership claim; codec cases keep the selector closed. | **Pass** at CreateProject integration/codec layer. |
| Attention rebuild after journal pruning | `tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts` qualified reset/snapshot/offset rewind around process kills, including Active before catch-up, at `522c1a9`. At b6 the targeted integrated P10 child is reported failing because its test-only environment composition lacks the newly required full resolver and uses a synthetic nonexistent path. | **Pending integration requalification** — the failure is at the stale test seam expected by fail-closed behavior; integrator is updating only the fixture. Do not mark the b6 integrated Story L case green until rerun. |
| Shared consumer offset below retention floor | P12 startup source-only reconciliation restores the public row after the Pending event and row are removed; P10 tests confirm this path does not alter the shared offset. | **Pass** — generic `ConsumerRebuildRefused` remains unchanged. |
| Old Pending event after Active | `tests/p10-activation-attention-reconciliation.test.ts` redelivers a stale Pending wakeup after Active and confirms no Activation row is recreated. | **Pass** at P10 consumer/source layer. |
| Pending→Active versus reconciliation/rebuild | P10 source reconciliation tests cover current-source convergence; Story L process cases cover lock ordering, both full-rebuild commit boundaries, Active before catch-up, and restart clearing. | **Pass** for the specified orderings. |
| Pre-intent v2 receipt | `adapters/persistence-sqlite/test/p35-workspace-resource-activation-migration.test.ts` seeds a committed v2 receipt, non-empty Workspace boundary, and existing events before P35; migration preserves them and creates no intent or Activation row. P12 startup scans intents rather than inferring work from all Workspaces. | **Pass** for the accepted migration/no-backfill disposition. Historical v1 replay remains separately preserve-only. |

## Remaining scope

OPEN-1 Profile-source audit and OPEN-2 historical CreateProject v1 same-ID
replay remain independently open. They are not OPEN-3 implementation blockers
and are not closed by this review.

No full `pnpm check` or full `pnpm test:functional` run is recorded at
`b6b383162fb91ed95b75d3b0046d3ba2917888d8`. The focused F21 results are
recorded in `planning/results/F21-open3-wave3-activation-recovery.result.md`,
`planning/results/F21-open3-wave3-p10-story-l-full-rebuild.result.md`, and
`planning/results/F21-open3-wave3-p11-environment-anchor-rollback.result.md`.
The b6 P10 integrated fixture result remains pending the corrected targeted
rerun; therefore this review clears semantic blockers but does not certify
final integrated qualification at b6.
