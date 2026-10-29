# AH10 Direct-Child AssignWork Target Binding — Implementation Qualification

Status: The scoped AH10 direct-child AssignWork matrix is 12/12 PASS on the
P34-shared tree after the final evidence corrections. The independent TX review
is Blocking = 0. P10 consumer/rebuild is implemented under frozen contracts and
independently reviewed at Blocking = 0. The promoted default functional
suites, repository-wide `pnpm check`, and full Vitest/Playwright gate pass;
broader AH10 closure remains open.

Design basis: accepted AH10 direct-child target-binding package, proposal SHA-256
`E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9`, against
design HEAD `ec8db386`. Tests in this result were run in the shared checkout at
HEAD `5b9aae9`; the intervening HEAD movement was the separately accepted,
docs-only F23 landing. No `docs/design/**` files or F23 planning files were
changed for this implementation.

## Implementation

Migration 0033 adds typed AssignWork target bindings and durable binding-failure
facts without legacy backfill. The first accepted AssignWork command persists
the original opaque workspace ref, canonical WorkspaceId and resolved revision,
placement, parent/project, source execution/provider turn/logical action/call,
and exact Grant or ActionApproval authority evidence. Binding, Work, effect,
event, receipt, and approval consumption are committed through the same Gateway
transaction. Commit-time checks require the exact direct child and active target;
the runtime does not widen authorization.

Recovery checks the old Committed command receipt and exact binding before
consulting current placement or selector state. Valid evidence converges the
original effect even if the ref has become stale, the target retired, or the
Grant was later revoked. Missing, corrupt, mismatched, or legacy-unbound
evidence fails closed, writes one durable P9 failure fact/event, releases the
execution without settling the action, and exposes P10 Action Required Attention
through the public Attention view.

The implementation also adds the typed P9/P10 projection path, migration and
port tests, commit-time authorization tests, and a process-level pending matrix.
At the time of this implementation write-up, the process matrix remained
isolated by `vitest.ah10-pending.config.ts`. The two selected, green
qualification files were later explicitly promoted under the 2026-10-09 user
authorization recorded below; unrelated pending cases remain isolated.

First-review follow-ups added a trusted Clock sample inside the Gateway
transaction. Second-review A moved that sample to immediately after the Grant /
ActionApproval row read and before commit effects; ActionApproval SQL consume
uses the same expiry cutoff. Second-review B denies a new non-current raw
`targetWorkspaceId` inside the authorizer before approval or Inbox writes, while
a legacy non-current raw ID with an old Committed receipt still takes
receipt-first binding validation. The current-Workspace compatibility path
remains accepted. These changes do not alter accepted authorization or
placement semantics.

## Focused qualification

At HEAD `5b9aae9` plus the accepted P10 migration 0034 implementation, the
isolated process matrix passed **12/12** in 504.11s after final evidence
corrections:

1. A committed AssignWork is recovered receipt-first after its selector is stale.
2. A sibling-target-corrupted binding does not cross-assign and instead fails
   closed with durable Attention.
3. SIGKILL before binding/command commit leaves no committed evidence; the next
   generation retries and commits one coherent result.
4. Exact ActionApproval evidence is consumed atomically and its committed
   action is recovered.
5. A pre-commit Approval fencing rejection does not consume approval or create
   Work/binding; the later generation can consume and commit exactly once.
6. The equivalent P32 schema fixture has no 0033 binding backfill, upgrades to
   current schema version 34, and fails closed on takeover.
7. A legacy Committed receipt with its binding removed fails closed.
8. A target retired after commit still converges the accepted action.
9. A Grant revoked after commit still converges the accepted action.
10. A successful direct-child assignment nested under a non-root Parent retains
    the exact Parent/child placement and binding.
11. A P9 failure fact/event uncommitted at SIGKILL is absent from an independent
    SQLite connection; retry commits one fact/event. After a further restart,
    gen2's public Attention view and `responsibility-tree` show exactly one
    ActionRequired row/count on the Parent and project root.
12. A committed P9 fact/event survives restart, is reused idempotently without a
    duplicate event, and appears exactly once in gen2's public Attention and
    responsibility-tree views.

The second-review D oracle now derives every candidate AssignWork CommandId for
the source ProviderTurn/output position from generation 0 through the highest
observed execution-lease generation, then enumerates all matching receipts.
The full 12-case rerun verifies one Committed receipt, unique candidate receipt
IDs, and exact presence/absence of the earlier rejection across the
old-Committed/same-generation case, binding-before-commit (no gen0 receipt),
Approval FencingRejected plus later commit, and Attention recovery reaching a
later generation.

Second-review C has since been implemented under accepted P10 contracts:
migration 0034 adds the project-bound Attention business row; the consumer
applies row/checkpoint transactionally; project-scoped rebuild and real daemon
restart parity are qualified. Independent P10 review is Blocking = 0. Details
are in [AH10-P10-attention-materialization-design-gap.result.md]; its former
RED is explicitly superseded as a design-gap claim.

The P32 compatibility case is deliberately described as an **equivalent P32
schema fixture**, not as a database emitted by an old binary. Its schema is
compared to a separately created database after migrations 0001–0032, including
`sqlite_master`, `PRAGMA table_info`, `index_list`, and `foreign_key_list`, and
both report `user_version=32`. The P32 fixture excludes runtime-created
`projection_state` plus migration-only P33/P34 objects before exact schema
comparison. It retains its old Committed receipt and source Work/event, has no
0033/0034 residue before upgrade, receives no 0033 binding backfill, and the
current daemon upgrades it to version 34. Preserved dogfood data was not
accessed. A qualification using a real old checkout/old daemon has not been run
and is not claimed here.

Additional focused checks passed:

- `pnpm typecheck` (after correcting test imports): PASS.
- P33 migration test: 1 file / 1 test PASS.
- P10 Attention/API/architecture and AssignWork command unit batch: 5 files /
  37 tests PASS (recorded in the implementation work log).
- P10 pure Attention read-model tests: 9/9 PASS.
- Clock-advances-during-authority-read Grant/ActionApproval expiry tests: 2/2
  PASS; post-read Approval consume timestamp equals the fresh cutoff; full
  AssignWork target-binding unit file is 5/5 PASS.
- Non-current raw child WorkspaceId action-handler rejection with the
  current-Workspace path preserved: 1/1 PASS.
- Raw child authorizer routing: 3/3 PASS. No-prior-Commit RED was
  `ApprovalRequired` with pending Approval/Inbox side effects; now it is Denied
  before either write. An old Committed raw-ID action reaches receipt-first
  binding validation in the authorizer unit test; this is routing evidence only,
  not end-to-end raw-ID Attention evidence.
- Legacy raw-child ID + prior `TerminalRejected(FencingRejected)` + raw-target
  Grant: authorizer negative 1/1 PASS (Denied, no Approval/Inbox). This is the
  expected eligible-only behavior: without an opaque target ref and exact typed
  direct-child authority evidence, the legacy action is not eligible for a new
  command. No ref is inferred.
- MAC-P2 placement regression now verifies that missing trusted direct-child
  authority cannot create a child Work/binding: 1/1 PASS.
- P10 Attention/API/architecture, AssignWork binding, P33 migration, and
  MAC-P2 placement: 6 files / 40 tests PASS.
- Final isolated direct-child takeover matrix on P34: 12/12 PASS (504.11s).
- Second-review D process subsets: 3/3 PASS for prior Committed, binding-before
  (no earlier receipt), and later-generation Attention restart; the separate
  Approval FencingRejected takeover case is 1/1 PASS.
- Targeted Biome check of the five A/B/D files: PASS.
- `pnpm typecheck`: PASS after the A/B/D production and test changes.
- P10 Attention materialization/rebuild/restart suite: 9/9 PASS on the same
  working tree.
- Final targeted architecture/API/Attention/P34 migration/daemon/application
  batch: 7 files / 45 tests PASS.
- P10 materialization/rebuild/restart qualification: complete in the separate
  P10 result. At the time this focused qualification section was recorded,
  repository-wide gates had not yet been run; their later integrated outcomes
  are recorded under “Final integrated validation” below.

## Not claimed

- The final integrated `pnpm check` passes on the shared uncommitted tree.
- The first integrated full-functional attempt exposed an AH12 test-oracle
  ordering gap and stopped before Playwright; the corrected final integrated
  run passes (details below).
- The full-functional run's F20 clean-checkout smoke passed against repository
  `HEAD`; it does not qualify the modified uncommitted tree.
- No real P32 old-binary fixture was constructed or tested; only the schema-
  compared equivalent P32 fixture is qualified.
- This result qualifies the accepted direct-child AssignWork scope only; it
  does not claim all AH10 actions/states or AH10 as a whole are closed.

P1 §2 permits FencingRejected takeover only when normal pending/freshness and
current-authorization eligibility pass. A legacy raw WorkspaceId action without
the accepted opaque target/typed direct-child evidence does not pass that gate;
denial before Approval/Inbox or a new Command is the intended fail-closed
behavior, not a design gap. This disposition follows the final independent TX
review. The Committed raw-ID unit remains limited to receipt-first routing; the
process `legacy-unbound` case retains its opaque-ref action and qualifies the
durable Attention path. No `docs/design/**` changes were made.

## Final integrated validation

Baseline HEAD: `5b9aae9ce40d8f7eb803ff77ec4b348fd889bb1d`; no `docs/design/**`
files changed. After the narrow architecture-oracle update for migrations
0033/0034, the final `pnpm check` passed: Biome checked 978 files (one existing
non-blocking `noNonNullAssertion` warning at
`packages/agent-runtime/src/model-decision.ts:4070`), typecheck and test
typecheck passed, architecture 31/31 files and 158/158 tests passed, core
Vitest 324/324 files with 1760 passed and 3 skipped, Web typecheck/build passed,
and Web Vitest 31/31 files / 223/223 tests passed. The generated P12 restore
drill timestamp/hash were compared with HEAD and restored exactly; all three
P12 result/artifact hashes match HEAD afterward.

The first integrated functional run before correcting the AH12 test oracle
completed Vitest at 30/31 files and 122/123 tests. Its sole failure was
`tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts:534`,
“AH12BeforeSettleGatewaySubmission settles once after hard restart”: the
recovered `verificationExecutions` snapshot was empty. The `waitForPublic`
predicate had waited for the Verification and unsettled verifier Execution,
but not for their binding row to become visible in that same snapshot. The
test-only correction adds that exact matching `verification_executions` join
row to the wait predicate, preserves the 45-second bound, and retains the
final line-534 assertion. The AH12 focused matrix then passed 3/3 and its
independent review was Blocking = 0; no production code changed.

After that correction and promotion of the two qualification files into the
default suite, the final `pnpm check` and one full `pnpm test:functional`
passed. Functional Vitest passed 33/33 files and 144/144 tests, including the
21 promoted AH10/P10 tests; Playwright passed 3/3 browser tests. The full run's
F20 clean-checkout smoke passed against repository `HEAD` only; it does not
qualify the modified uncommitted tree. An earlier pre-fix functional
invocation was interrupted during startup and is not qualification evidence.

The scoped direct-child AssignWork matrix remains 12/12 PASS and the P10
materialization/rebuild/restart suite remains 9/9 PASS, with their independent
reviews at Blocking = 0. AH10 as a whole remains **PARTIAL**; these results do
not close other AH10 actions/states or governance gaps.

## 2026-10-09 separate authorization and default-suite promotion

The human user's explicit UI reply “授权实施（推荐）” authorized the accepted
direct-child target-binding implementation scope after a question naming
migration 0033, atomic opaque-ref-to-Workspace binding, durable Attention for
an unproven Committed receipt, and A/B two-daemon commit-boundary tests. The
decision record is appended to
`planning/results/AH10-direct-child-assign-work-target-binding-governance.md`.
Its normalized marker is documentation, not literal user input. The accepted
proposal SHA-256 and frozen `docs/design/**` files were not changed.

The two already-green process qualification files have now been promoted into
`tests/functional/process/` and are discovered by the existing default
functional include. Focused verification on the promoted paths:

```text
pnpm exec vitest run --config vitest.ah10-qualification.config.ts
2 files / 21 tests PASS (529.79s)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
PASS

pnpm exec biome check tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts tests/functional/process/ah10-p10-attention-materialization.functional.test.ts vitest.ah10-qualification.config.ts
PASS (3 files)

git diff --check
PASS (only line-ending normalization warnings for the two edited Markdown records)

pnpm architecture
PASS (31 files / 158 tests)
```

The final integrated gates are complete: `pnpm check` passes, and
`pnpm test:functional` passes at 33/33 Vitest files / 144/144 tests plus
Playwright 3/3. The 21 promoted cases are included in those default totals.
F20's clean-checkout child ran from repository `HEAD` only, so it is
baseline-only and does not qualify the uncommitted AH10/P34 changes. The P32
case remains an equivalent schema fixture only; no old-binary P32 database is
claimed. The raw child-WorkspaceId plus old FencingRejected path remains
fail-closed when the accepted opaque target ref and typed direct-child
authority evidence are missing. AH10 as a whole remains **PARTIAL**.
