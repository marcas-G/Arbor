# AH7-DG-02 independent read-only audit

Status: **design gap confirmed; fixed decision draft and layered matrix prepared;
not accepted and not implementation-authorized**.

Worktree: `C:\Users\ThinkPad\.codex\worktrees\ah7-reconcilable-dg02\Arbor`  
Explicit source baseline: `db929654128b8e864d3733b95088f4edda0e4c43`  
Checkout: detached at the explicit source baseline; managed worktree is separate
from the already reviewed AH7 implementation tree and `C:\Arbor`.

## Evidence and conclusion

- `planning/gaps/AH7-DG-02-reconcilable-tool-proof.md` describes the live
  process counterexample: shell appends a marker, daemon dies after the effect
  and before P4 settlement, restart prevents duplicate append but reports
  OutcomeUnknown without reading/proving the external result.
- Historical `planning/proposals/reconcilable-shell-reality-proof-decision-draft.md`
  has SHA-256
  `41E0998B6B93648C0D0CA5767C97628F091E54E757299D1D585D0B4E71B50A9A`; the
  recorded readiness review says draft only, not accepted or implementation-
  authorized.
- P4 `01` §2 and `02` §5 require Reconcilable reality resolution before replay;
  P4 `08` §5 nevertheless freezes arbitrary `shell@2` as Reconcilable.
- P4 `06` §4 defines `ReconciliationSource.pending` as returning invocation
  refs. P4 `06` §6 expressly leaves external reconciliation logic to the owning
  tool. This does not specify an evidence-producing port, stable effect key,
  profile/version, proof strength/finality, attempt state, or persisted result.
- P9 `02` §5 T3 requires real external reality reconciliation before settling;
  P9 `07` §1–§4 specifies recovery ordering/disposition but not how to obtain,
  bind, persist or project `NotOccurred` / `Occurred` / `StillUnknown` facts.
- Current `packages/tool-runtime/src/catalog.ts` binds shell to hash
  `shell-v2-mount-relative-cwd` and `sideEffectSemantics: Reconcilable`.
  `packages/tool-runtime/src/tools/shell.ts` executes arbitrary policy-allowed
  command text with `spawnSync`; its policy only classifies deny/approval/allow.
  `ToolExecutor` has `execute` but no reconcile operation. Current
  `packages/tool-runtime/src/reconciliation.ts` enumerates unsettled refs by
  semantics and does not inspect an external source.

Thus existing contracts express the objective but do not make arbitrary shell
reconciliation executable. The design gap remains; current `OutcomeUnknown` /
`ReconciliationPending` is a safe stop, not proof that the external effect was
reconciled.

## Reused crash reproduction

The existing `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
is reused as the baseline reproduction; it was **not run in this task**. Its
post-effect/pre-settlement scenario proves the external marker is present once
and is not blindly replayed, while restart remains unresolved. This preserves
the failure evidence without starting a daemon. Its pass is explicitly not
counted as reconciliation qualification. No new test was added.

## Draft package

- Fixed governance draft:
  `planning/proposals/AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md`
  SHA-256 `B8E9084C8273E0DCE5AA8D0CAA8CFF33499F85A5EF7C6AE9C91AA92F710DB7ED`
- Layered qualification matrix:
  `planning/tasks/AH7-DG-02-reconciliation-qualification-matrix.md`

The draft selects generic new `shell@3` as NonIdempotent; permits Reconcilable
only for exact versioned profiles with stable effect identity, authoritative
proof and old-attempt finality; closes the three proof states, retry gate,
authority/resource/approval binding, per-attempt P4 facts, P3 ToolResult source,
P9 Attention, and legacy shell@2 fail-closed disposition. It introduces no new
SideEffectSemantics tag and does not rewrite frozen docs.

## Scope and validation

- No production code, migration, tests, or `docs/design/**` modified.
- No daemon or full-suite test run.
- `git diff --check`: PASS; only the three intended planning files are changed.
- Manual acceptance: **none**. The proposal is a recommendation only; a
  separate human acceptance and landing review are required before design or
  implementation changes.
