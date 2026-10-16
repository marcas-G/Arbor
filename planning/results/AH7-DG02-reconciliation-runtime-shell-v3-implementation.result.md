# AH7-DG-02 reconciliation runtime and shell@3 implementation result

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
open. The additional P40 terminal-selection and P3 projection crash matrix is
now represented in
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`:
four P40 cases (NotOccurred/Occurred × before/after settlement COMMIT) and six
P3 cases (NotOccurred/Occurred/StillUnknown × before/after ActionResult COMMIT).
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
