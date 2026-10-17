# AH7-DG-02 reconciliation runtime and shell@3 implementation result

## Current qualification status — 2026-10-17

The following scoped qualifications are PASS: authority/approval/Stop drift
(3/3); G0/G1 delayed source-I/O takeover and SIGKILL during source lookup;
P40 settlement boundary matrix (4/4); P3 NotOccurred/Occurred ActionResult
matrix (4/4); StillUnknown restart plus P9/P10 escalation and P3 before/after
ActionResult recovery; trusted profile version/hash/effect-key drift (3/3);
P39 fact-write failure atomicity with safe P3 OutcomeUnknown projection; and
historical profile-less shell@2 recovery on schema44; and §2.6 G0/G1 mismatched
proofs for wrong attempt/visibility (2/2). Evidence is recorded in the
historical sections below and the linked focused result records.

AH7 remains **PARTIAL / OPEN**. These cases use a test-only trusted profile;
production has no registered Reconcilable profile or authoritative source for
external-effect proof. Remaining qualification includes the broader non-Success
Observation replay/completion contract beyond the single ExpectedFailure
process case, the production-approved Executable InvocationApproval handoff,
and generation/concurrency/crash permutations beyond the specifically listed
cases and matrices. No overall AH7 closure is claimed.

Date: 2026-10-17
Baseline: `fccd1c146e3ad12824cc20d6247d45bd52b57ba0`
Authorization: `AUTHORIZE_AH7_DG02_RECONCILIATION_RUNTIME_AND_SHELL_V3_IMPLEMENTATION`
Canonical plan raw SHA-256 (HEAD blob bytes):
`18C65193FD78DCB72692D79AE0DC14FCCC3C7FFC1A35397E25C206543DD18B64`

Authorization reaffirmed by the user on 2026-10-17 after independent review:
`AUTHORIZE_AH7_DG02_RECONCILIATION_RUNTIME_AND_SHELL_V3_IMPLEMENTATION`.

## Implementation

- New catalog writes expose shell v3 with `NonIdempotent` semantics. Exact
  shell v2 lookup remains available for historical replay; it has no trusted
  reconciliation profile by default.
- P4 resolves immutable trusted profiles only for definitions classified
  `Reconcilable`. Profile/effect identity is Runtime-owned and bound into
  RecoveryBinding/P39 attempt rows. The production composition registry is
  empty and has no reconciliation port.
- P4 recovery now calls the injected reconciliation port only after a fenced
  read of the exact binding/attempt, validates the exact attempt proof, records
  immutable P39 facts, and carries the selected fact into the P40 terminal
  observation. `Occurred` result facts are recorded before P4 settlement and
  selected in the same terminal transaction; `NotOccurred` permits only the
  single same-invocation retry after current gates; `StillUnknown` stays
  unsettled and follows the existing P9/P10 escalation path.
- Test-only process composition injection is explicit. The AH10 child uses a
  deterministic external-effect ledger and exact shell descriptor/profile,
  with no change to ordinary production registration. P4 probes mark the P39
  fact commit boundary before and after COMMIT.
- No design document, migration, production profile, deployment, or preserved
  database was changed or operated.

## Verification

- `pnpm typecheck` — PASS.
- Biome checks on all changed source/test files — PASS.
- Targeted P4/P39/profile tests — 7 files, 52 tests PASS.
- Retry-gate denial mapping regression — PASS: invocation-authority denial maps
  to `AuthoritySnapshotChanged`; approval denial maps to
  `ApprovalNoLongerAuthorized`.
- Resource-change-during-reconciliation real daemon case — PASS (targeted
  Vitest: 1 passed, 6 skipped). After the test-only source port changes the
  Workspace resource addresses during `NotOccurred` reconciliation I/O, P4
  revalidates the captured resource revision/addresses and admission inside the
  fenced transaction. It records one exact P39 `NotOccurred` fact, selects it
  in the P40 `ReconciledNoEffect` observation with
  `reasonCode=ResourceSnapshotChanged`, preserves attempt 0 only, and performs
  zero external effects/retry attempt. The public action was observed as
  `TerminalRejected`; this case does not qualify P3 projection or its crash
  boundaries.
- Real daemon restart qualification, one test-only trusted profile per case:

  - `NotOccurred` — PASS. Kill after P4 effect admission, kill again while
    paused before P39 fact COMMIT (independent read sees zero facts), then
    restart. The same invocation admits exactly attempt 1, executes the
    external effect once, settles P4 Success, and produces one P3 ToolResult.
  - `Occurred` — PASS. Kill after the external effect, recover a canonical
    result from the exact existing Artifact, commit the P39 fact, kill after
    that COMMIT, and restart. P4 selects the same attempt/fact and writes the
    P40 Success observation; the executor/effect is not repeated.
  - `StillUnknown` — PASS. Kill after effect admission, persist the exact
    unknown fact, kill after its COMMIT, and restart. P4 remains unsettled; P3
    records `OutcomeUnknown`/`ReconciliationPending`; no executor/effect or
    inferred result is produced.

- `git diff --check` — PASS.

## Qualification boundary

The remaining authorized matrix for authority/approval/Stop changes and
concurrent stale-generation takeover during an in-flight source read remains
open. The additional P40 terminal-selection and P3 terminal projection crash
matrix is represented in
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`:
four P40 cases (NotOccurred/Occurred × before/after settlement COMMIT) and
four P3 cases (NotOccurred/Occurred × before/after ActionResult COMMIT).
StillUnknown is qualified through its independent terminal recovery scenario,
not through an ActionResult COMMIT boundary that the runtime does not reach.
The child-process test probe pauses at those exact existing transaction
boundaries. The P40 cases use the test-only resource-change gate so
NotOccurred selects a terminal `ReconciledNoEffect`; P3 cases retain the normal
NotOccurred same-invocation retry behavior. Each case asserts the independent
SQLite view on the interrupted side and then relies on the existing final
identity/effect/result/observation assertions after restart.

This addendum has **not yet received real-process qualification**. The focused
Vitest attempt was stopped at the coordinating agent's request while several
daemon suites were competing for readiness; it produced no test result. Static
verification on the changed files: `pnpm typecheck` PASS, Biome PASS, and
`git diff --check` PASS. No AH7 closure, release-readiness, or full functional
suite claim is made; AH7 remains PARTIAL.

The process evidence above uses only a test-owned deterministic profile and
external state fixture. It does not qualify a production source/profile.

## 2026-10-17 P40/P3 terminal matrix qualification update

The isolated process matrix passes all four P40 settlement-commit cells and
all four P3 ActionResult-commit cells: NotOccurred/Occurred × before/after
commit. The two proposed StillUnknown × ActionResult cases were removed
because the runtime persists the P39 StillUnknown fact and returns
`OutcomeUnknown` before reaching the ToolRuntime ActionResult boundary. The
existing independent `recovers StillUnknown from a test-only trusted profile
after a daemon restart` case passes 1/1 (75.188s): the initial crash occurs
after effect admission and before the first P39 fact; after restart, the
exact unknown fact commits and the process is killed again after that commit,
then a second restart converges. P4 remains unsettled; P3 reports
`OutcomeUnknown`/`ReconciliationPending`; no Executor replay, external effect,
or inferred result is produced.

Typecheck, changed-file Biome, and `git diff --check` pass. This closes only
the scoped P40/P3 terminal crash matrix; AH7 remains PARTIAL / OPEN. Production
profile-version drift and the separately authorized authority/approval/Stop
and concurrency takeover cells remain open.

## 2026-10-17 exact P39 replay identity checkpoint

Implemented a scoped replay path for an exact persisted, unsettled
`Reconcilable + MayHaveStarted` invocation. The path authenticates canonical
RecoveryBinding bytes/hash, verifies the recorded regions digest, immutable
P3/action/tool/arguments/approval identity, current trusted profile tuple, and
the exact latest P39 attempt before reconciliation. It queries reality using
the persisted binding's visibility digest, without comparing the old
invocation's resource identity to resolver output from the current Workspace.
For `NotOccurred`, the fenced retry transaction revalidates the current
resource boundary and environment against the stored binding before resource
admission and attempt-1 creation. A changed snapshot selects P40
`ReconciledNoEffect(ResourceSnapshotChanged)` with no retry or Executor call.
Ordinary and non-Reconcilable replay retain strict current-region identity
matching.

P4 pipeline qualification: `packages/tool-runtime/test/p4-pipeline.test.ts`
**44/44 PASS**, including changed current boundary → authenticated
`ResourceSnapshotChanged`, and fail-closed mismatched recorded regions / P39
binding. `pnpm typecheck`, changed-file Biome, and `git diff --check` pass.
This is a code/unit-test checkpoint only: the real-process P40
before/after-terminal-commit matrix has not been rerun against this fix, and P3
projection crash cases remain pending. No AH7 closure or production profile
qualification is claimed.

## 2026-10-17 drift-matrix implementation checkpoint (not process-qualified)

The NotOccurred retry-denial matrix was extended with test-owned mutations of
the actual retry-gate sources during reconciliation I/O:

- Authority revokes the project's active `permission_grants`; the production
  resolver derives its authority input and source revision from those active
  grants.
- Approval expires the exact consumed Executable `action_approvals` row bound
  to the invocation.
- Stop sets `executions.stop_requested_at` on the exact active execution.
- The pre-existing resource-boundary drift case remains in the same scenario
  family.

Every scenario is authored to require the exact `ReconciledNoEffect` reason,
one P39 attempt-0 `NotOccurred`/`RecoveryInput` fact selected by the P40
observation, only attempt 0, zero test-ledger external effects, and no Applied
P3 action. The authority scenario was the only new real-process scenario run
after serial execution was authorized. It reached the runtime
`AH7BeforeReconciliationFactCommit` probe but timed out before settlement;
the diagnostic snapshot had no P39 fact and the invocation remained
`MayHaveStarted`. This is not a PASS and does not qualify any drift case.

The failure led to a minimal implementation correction in
`ToolAuthorityResolverLive`: it now reads the permission/workspace/verification
snapshot in the current `TransactionScope` when called inside an existing
transaction, while top-level calls still use `TransactionPort.transact`. The
transaction adapter rejects nested transactions, and the retry gate performs
authority revalidation inside the transaction that records/selects the P39
fact. The correction keeps that source read in the retry-gate transaction.

Verification after this correction:

- `pnpm typecheck` — PASS.
- Biome checks for the changed implementation and tests — PASS.
- `pnpm exec vitest run apps/single-workspace/test/tool-authority-resolver-denial.test.ts --maxWorkers=1 --no-file-parallelism --retry=0` — PASS, 3/3. Covers top-level resolver transaction use and existing-scope reuse with a transaction port that rejects nested transactions.
- The Web production build completed successfully before the focused real-process attempt.
- The post-correction AH7 authority real-process case has not yet been rerun.
  Approval and Stop real-process cases were not run. No result here claims the
  exact RNO/P39/P40/effect-count qualification for the drift matrix.

This checkpoint leaves AH7 PARTIAL and awaits independent review before
further real-process qualification.

### Authority drift after resolver correction — still not qualified

After independent review, only the authority case was rerun, serially, using
the built checkpoint and the command:

`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "authority drift during reconciliation I/O" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose`

The case reached both `AH7BeforeReconciliationFactCommit` and
`AH7AfterReconciliationFactCommit`. The final diagnostic snapshot contains
exactly one attempt-0 `NotOccurred`/`RecoveryInput` P39 fact, while the P4
invocation remains `MayHaveStarted` with no settlement, selected fact, or P40
observation. The 90-second test wait expired (Vitest test duration 111.55s;
whole run 128.15s). This confirms the transaction-scope correction permits
the P39 fact transaction to commit, but the authority-denial path still does
not reach terminal P4 settlement. The exact RNO reason, P40 selection,
attempt-0-only admission, and zero-effect assertions therefore remain
unproven. Approval and Stop cases were not run. AH7 remains PARTIAL.

### Retry-gate terminal handoff correction — unit-qualified, process rerun pending

The failure above was traced to fallthrough after the fenced retry gate had
already rejected a retry and populated `recoveredToolOutcome` plus
`pendingReconciliation`. P4 then re-entered the ordinary effect-authority,
approval and admission path. On authority denial that path attempted generic
`recordNoEffectDenial`; on resource drift it could admit another effect. Both
paths obscured the exact P39 denial and prevented the intended P40 terminal
selection.

The runtime now bypasses the ordinary new-effect gate whenever the recovered
outcome is `ReconciledNoEffect`. It proceeds directly through the existing
recovered execution bundle and authenticated P39/P40 terminal-selection path.
Other recovered outcomes and newly claimed actions retain the ordinary gate.

P4 pipeline tests now exercise actual P39 recovery with attempt 0 and a trusted
test profile, for both `AuthoritySnapshotChanged` and `ResourceSnapshotChanged`.
Both assert the exact P40 settlement reason and selected attempt-0 fact,
`effectAdmissions = 0`, retry attempt ledger `[0]`, no generic denial, and no
executor call. The focused pair passed 2/2; the full
`packages/tool-runtime/test/p4-pipeline.test.ts` passed 41/41. `pnpm typecheck`,
Biome and `git diff --check` passed. The real-process authority case has not
been rerun after this correction, and approval/Stop drift process cases remain
unrun; no process qualification or AH7 closure is claimed.

### Authority drift after retry-gate handoff correction — PASS

After checkpoint `2ab548c18ef60ea088a1b556d893a4c6004c6c66`, `pnpm build`
and `pnpm --filter @arbor/web build` passed. The single authorized real-process
case then passed serially:

`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "authority drift during reconciliation I/O" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose`

Result: 1 passed, 9 skipped; the authority drift case took 45.152s and the
Vitest run took 61.85s. Its assertions prove the exact P39 attempt-0
`NotOccurred`/`RecoveryInput` fact is selected by P40 as
`ReconciledNoEffect/AuthoritySnapshotChanged`, with attempt 0 only, no external
effect, and no retry admission. Approval and Stop process cases were not run.
This qualifies the authority drift case only; AH7 remains PARTIAL.

### Approval drift after retry-gate handoff correction — PASS

After independent release for this one case, the exact Executable approval
drift scenario passed with the same serial command policy:

`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "approval drift during reconciliation I/O" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose`

Result: 1 passed, 9 skipped; the case took 45.082s and the Vitest run took
61.93s. The test proves exact `ApprovalNoLongerAuthorized`, P39 attempt-0
`NotOccurred`/`RecoveryInput` selection by P40, no retry admission, and zero
external effects. The Stop drift process case remains unrun. These two passing
drift cases do not close AH7; AH7 remains PARTIAL.

### Stop drift after retry-gate handoff correction — PASS

The final authorized case passed serially:

`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "stop drift during reconciliation I/O" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose`

Result: 1 passed, 9 skipped; the case took 45.000s and the Vitest run took
61.66s. It proves exact `StopRequested`, P39 attempt-0
`NotOccurred`/`RecoveryInput` selection by P40, no retry admission, and zero
external effects. Authority, approval and Stop drift scenarios each now have
one isolated real-process PASS after the retry-gate handoff correction. This
does not establish the remaining AH7 process matrix or close AH7; AH7 remains
PARTIAL.

### G0/G1 takeover during delayed reconciliation source I/O — PASS

The isolated test-only `NotOccurred` source-I/O takeover case passed on
`3f8eb34d538b69f53206ec93f43d4e0c6518fa7a` after rebase onto production
baseline `7d722de2ed577f9b96cfad71149b4a0fe83affd2`. G0 remained alive with its
source result gated while G1 acquired the next fencing generation through
LeaseService. G1 completed attempt 1 on the same invocation, one P39 fact and
one external effect. After G0's source result returned, the fact and attempt
records were unchanged. The workspace marker confirms one shell effect and the
same ProviderTurn/action identity was reused. The fixture advances lease
expiry by test-only CAS; this is not natural TTL timing evidence. Full command,
counts, first-run observation defect and correction are recorded in
`planning/results/AH7-DG02-G0-G1-source-io-takeover.result.md`.

This qualifies only the covered G0/G1 `NotOccurred` source-I/O case. AH7 stays
PARTIAL; no production Reconcilable profile or complete AH7 closure is claimed.

### Terminal P40 receipt-first correction — unit checkpoint, process qualification pending

Moved settled-invocation replay ahead of current Workspace resolution, region
comparison, admission and reconciliation. The receipt path first requires exact
execution/workspace/tool/version/semantics/arguments/approval identity, then
uses the existing P40 evidence reader and P39 selected-fact verification for
RNO. Denied and Interrupted receipt behavior remains intact. Corrupt or
mismatched terminal receipts fail closed before Executor/admission/reconcile.

Focused receipt cases: **3/3 PASS**. Complete P4 pipeline:
`packages/tool-runtime/test/p4-pipeline.test.ts` **47/47 PASS**.
`pnpm typecheck`, changed-file Biome and `git diff --check` pass. This is a
unit/code checkpoint only; no real-process receipt or P40/P3 crash matrix was
run for this correction. AH7 remains PARTIAL.

### B2 receipt-candidate narrowing — unit checkpoint, process qualification pending

The region-drift receipt-first fast path is now limited to an exact terminal
P39 candidate: settled Reconcilable `MayHaveStarted`, both intent approval ID
and context Executable approval ID (when present) matching the recorded row,
trusted profile/P39 evidence services present, and an authenticated selected
fact. Other settled receipts follow the existing current-region strict path.
The P40 evidence read, current-fence assertion, and P39 selected-fact read now
share one transaction. RNO fact identity is matched to the P40 observation ref;
Occurred Success matches the selected fact ID, result artifact, source call
identity and trusted profile/attempt tuple.

Focused B2 cases: **11/11 PASS**. Complete P4 pipeline:
`packages/tool-runtime/test/p4-pipeline.test.ts` **55/55 PASS**.
`pnpm typecheck`, changed-file Biome, and `git diff --check` pass. No real
process was run for this correction; B2 remains a code/unit checkpoint only.

### B2 provenance and selected-fact correction — unit checkpoint

The receipt probe no longer infers P39 provenance from the P4 settlement tag.
For a terminal Reconcilable `MayHaveStarted` row with the required stores, it
reads P40 evidence and P39 selection in one fenced transaction. `selected=None`
returns an internal `NotP39Receipt` signal and resumes the existing strict
current-region replay path. A selected fact is accepted only after exact P3
source, binding, attempt, profile, outcome and artifact/result-ref checks; a
present but mismatched selection fails closed. Occurred proofs accept P40
Success or ExpectedFailure only when the persisted invocation resultRef and
P40/selected-fact result references agree. The final ExpectedFailure
refinement applies the P4 contract: recorded resultRef is null, while the
authenticated selected P39 Occurred fact retains its non-null artifact ref;
Success still requires all three references to agree. Ordinary settled
receipts retain the original strict region comparison.

Focused B2 suite: **13/13 PASS**, including terminal RNO, Occurred Success,
Occurred ExpectedFailure, selected-none ordinary Success fallback, strict
ordinary drift, P3 identity/approval mismatches, missing/corrupt selection,
P40 hash failure, and lease-fence rejection. Full P4 pipeline:
`packages/tool-runtime/test/p4-pipeline.test.ts` **57/57 PASS**.
Typecheck, Biome and `git diff --check` pass. No real-process test was run;
this remains unit/code evidence and AH7 remains PARTIAL.

## Final qualification status — 2026-10-17

Since the earlier checkpoints above, scoped PASS evidence now includes the
authority/approval/Stop drift cases, G0/G1 delayed source-I/O takeover, all four
P40 settlement-commit cases, all four P3 ActionResult-commit cases, the
independent StillUnknown recovery, and all three trusted profile drift cases
(version, hash, effect-key policy). The standalone profile-drift result records
its runtime classification and count-helper verification.

AH7 remains **PARTIAL / OPEN**. The remaining work is broader non-Success
Observation replay and completion-response qualification beyond the one
ExpectedFailure path; a production-approved Executable InvocationApproval
handoff; and crash/concurrency permutations beyond the qualified matrices,
including takeover states beyond the single G0/G1 NotOccurred source-I/O case.
The test-only profile drift PASS does not establish a production
Reconcilable profile: production registration remains empty until an
authoritative external proof source and its effect identity/finality contract
are approved and implemented. No AH7 phase-closure claim is made.

Integration verification for this snapshot: `pnpm typecheck`, changed-file
Biome, and `git diff --check` pass; the P4 pipeline and reconciliation-profile
registry tests pass **62/62**. No daemon or full-suite test was run.

## 2026-10-17 P39 fact-store failure atomicity

The dedicated failure-injection qualification is recorded in
`planning/results/AH7-DG02-P39-fact-store-failure-atomicity.result.md`.
NotOccurred, Occurred, and StillUnknown module paths all stop before downstream
commit when fact storage fails, then safely resume using the same invocation
identity and proof. The SQLite adapter trigger case confirms the fact row rolls
back and the same immutable fact can be recorded after the injected failure is
removed. The module/adapter checks, typecheck, and changed-file Biome pass.
No real-process run was performed pending serial release; AH7 remains PARTIAL.
The phrase “no P3 projection claimed” means no success/applied projection:
the separate executable-handler integration verifies the required safe
`OutcomeUnknown` / `ReconciliationRequired` projection and
`ReconciliationPending` action state. It writes no successful ToolResult or
P40 terminal observation; see the dedicated result record above.

## Final qualification status — 2026-10-17 integration snapshot

Scoped evidence now includes all of the following PASS results: authority,
approval and Stop drift (3/3); G0/G1 delayed source-I/O takeover plus SIGKILL
during source lookup; P40 settlement boundaries (4/4); P3
NotOccurred/Occurred ActionResult boundaries (4/4); StillUnknown restart and
P9/P10 escalation with P3 ActionResult before/after crash recovery; trusted
profile version/hash/effect-key drift (3/3); P39 fact-write failure atomicity
for NotOccurred/Occurred/StillUnknown plus the SQLite adapter rollback and
safe P3 `OutcomeUnknown` / `ReconciliationPending` projection; and profileless
historical shell@2 recovery, including schema44 SQLite integration.

AH7 remains **PARTIAL / OPEN**. These new cases do not register a production
Reconcilable profile or provide a production authoritative external-effect
proof source. The production-approved Executable InvocationApproval
issuance/binding route also remains absent. Broader non-Success Observation and
completion-response behavior, plus generation/concurrency/crash permutations
outside the listed source-kill, P40/P3, StillUnknown and fact-store cases,
remain unqualified. No AH7 phase closure or overall completion is claimed.

For this integration snapshot, `pnpm typecheck` and Biome on 11 changed
source/test files pass. The P4 pipeline, profile registry, P39 adapter, P3
projection/driver, P9 visibility, schema44 shell@2, and P40 schema44 selected
tests pass **8 files / 124 tests**. `git diff --check` passes. No real daemon
or full-suite run is included in this integration pass.

## 2026-10-17 G0/G1 mismatched-proof qualification

The §2.6 two-daemon negative-proof cases now pass serially against real daemon
processes: wrong `attemptNo` **1/1** and wrong `visibilityScopeSha256` **1/1**.
For each, G0 paused in source I/O, G1 acquired the next fencing generation,
and its otherwise valid `NotOccurred` proof was classified as
`StillUnknown/EvidenceBindingMismatch`. P39 retained one safe unknown fact;
attempt 0 remained `MayHaveStarted`; P4 remained unsettled with no selection or
result; the unique P3 result was `OutcomeUnknown` and its action remained
`ReconciliationPending`; P9 emitted one escalation and P10 exposed one
`ActionRequired`. There was no Executor call, effect marker, external-effect
row, or result Artifact. After G1's test-only ActionResult gate was released,
Execution settled `OutcomeUnknown`. Releasing stale G0 then reached the new
Runtime `AH7ReconciliationResultFenceRejected` probe; full P4/P39/P3,
Execution, P9 and P10 state remained identical.

The Runtime probe is observational: it is emitted only when a late
`NotOccurred` result reaches the P39 retry/fact transaction and the current
fence rejects it. Probe defects are ignored, while the original typed fencing
failure continues unchanged. The focused P4 pipeline probe/error-passthrough
test passes **1/1**. `pnpm typecheck`, Biome on changed files and
`git diff --check` pass. No full functional suite was run; AH7 remains
**PARTIAL / OPEN**.

Run history: direct Vitest initially omitted the functional config, then the
functional fixture returned 503 until the Web dist was built. The first
assertion attempt also exposed that the test child pauses G1 after P3
ActionResult commit; the case now explicitly releases that test gate before
waiting for Execution settlement. Those attempts did not qualify either
proof-mismatch case. Only the two subsequent serial PASS runs above count.

## Final status — §2.6 mismatched-proof dual-daemon qualification

The two real-daemon proof-mismatch cases are PASS **2/2**: wrong
`attemptNo` and wrong `visibilityScopeSha256`. Both G1 results fail closed as
`StillUnknown/EvidenceBindingMismatch`; P39 retains one unknown fact, P4 stays
unsettled without selection/result, P3 remains `OutcomeUnknown` /
`ReconciliationPending`, P9 records one escalation and P10 exposes one
`ActionRequired` row. Executor/effect/result artifact counts remain zero.
After P3 action commit is released, Execution settles `OutcomeUnknown`; stale
G0 is then fenced and does not alter state.

AH7 remains **PARTIAL / OPEN**. The dual-daemon case adds two proof-binding
inputs to the scoped profile and recovery matrix; it does not register a
production Reconcilable profile, provide a production authoritative proof
source, close the production Executable InvocationApproval route, or qualify
the remaining AH7 crash/concurrency permutations. No overall AH7 completion
is claimed.

Integration verification for this snapshot: `pnpm typecheck`, changed-file
Biome and `git diff --check` pass; P4 pipeline plus ports profile registry
tests pass **67/67**. No daemon or full-suite run was performed.
