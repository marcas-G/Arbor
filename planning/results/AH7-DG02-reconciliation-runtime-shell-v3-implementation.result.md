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
