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

The remaining authorized matrix for authority/approval/Stop changes,
concurrent stale-generation takeover during an in-flight source read, P40
terminal COMMIT on both kill sides, and P3 projection on both kill sides was
not run in this implementation batch. Resource-change-during-I/O has the P4
retry-gate case above, but this does not qualify the other resource or
projection crash boundaries. No AH7 closure, release-readiness, or full
functional-suite claim is made; AH7 remains PARTIAL.

The process evidence above uses only a test-owned deterministic profile and
external state fixture. It does not qualify a production source/profile.

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
