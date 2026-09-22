# P11 — 12 P4 Sandbox Handoff (GQ1a-adjacent; demoted GQ6)

**Authority:** P4 `04` (frozen SandboxPort + guarantees); v1.8 G3.
**Status:** DRAFT.

## 1. Continuity (frozen by P4 contract — restated)

`SandboxPort` signature **unchanged**. Advanced isolation = new adapters:

- `sandbox-worktree` adapter: open() materializes writableRegions into the sandbox root from their worktrees (clone/worktree-add/copy — strategy empirical). **B3 wiring (CI-1/CI-3/CI-4)**:
  - (a) worktree-add creates a real GitWorktree → **must go through `09` CreateWorktree** (command, not raw fs); if the region set changed, a WorktreeLifecycle-cause `RecordEnvironmentChange` follows `03` CAS — the adapter never advances the anchor directly.
  - (b) close() write-back changes worktree content (fingerprint-visible at `02` §2 granularity) → convergence owner is fixed: the adapter's write-back emits a **Governance-cause RecordEnvironmentChange** proposal in the same flow (auto-submitted for sandbox write-back — it is an Arbor-originated mutation, not external drift); ExternalDrift is never used for self-made changes (no unrecorded CURRENT window).
  - (c) adapter-created worktrees have a terminal path: they are RetireWorktree-eligible at close when the declared policy is ephemeral (CI-3); persistent policy keeps them Active for Parent integration (SD §11.4).
  - integration/merge decisions stay Parent cognition per SD §11.4.
- `SandboxHandle` gains **optional metadata** (`{ source: "worktree", worktreeId? }`) — additive only.

## 2. Inherited guarantees (all four, incl. close-releases)

Root-confined execution; writes confined to writableRegions; control-DB unreachable; secrets unreachable; **close releases all sandbox resources**. Each gains a test in the new adapter. The existing `sandbox-local`欠账 (env allow-list from P4 §4) is repaid here.

## (mapping: none directly; supports CI-3 via region materialization)
