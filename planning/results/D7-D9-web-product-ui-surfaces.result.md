# D7–D9 Web Product UI Surfaces — Result

Status: **COMPLETE / PHASE-BOUNDARY CLOSED**  
Master adoption: merge commit `2420da771cdf8a1db8f2d5043f55b0391c817a80`
(`88744c5ac2d856044bb231e8c6abbd684dd0fded` + feature
`a51f8d04cc5c5986a2358c9308422f2dba9afe7d`, non-squash).
Baseline: `master@88744c5ac2d856044bb231e8c6abbd684dd0fded`  
Scope: D7 Governance Queue + Attention; D8 Usage + Settings; D9 Mobile,
Accessibility, and Global States.

## Phase status and authorization

- D7 Queue / Attention — **COMPLETE**.
- D8 Usage / Settings — **COMPLETE**.
- D9 Mobile / Accessibility / Global States — **COMPLETE**.
- G2–G5 remain **DEFERRED**.
- D10 Final Convergence remains **NOT AUTHORIZED**.

## Implementation

- D7 commit: `4fbdc73` — governance Queue and read-only Attention surfaces.
- D8 commit: `71524c6` — constrained Usage and Settings surfaces.
- D9 implementation commit: `42bc385` — mobile and accessibility hardening.
- No frozen Product UI specification, DID v1.17 semantics, P13/P14 contract,
  DTO, command, or backend semantic was changed or added.

D7 behavior is constrained to exact structured governance targets and the
frozen `RecordDecision` binding, with Approve/Reject only. Exact verification
revision pairing gates `AcceptWorkOutcome`; partial workspace inbox failures
remain visible without clearing successful queue items. Attention is read-only
and exposes frozen DTO fields only.

D8 uses server-provided Usage rows and only the frozen `workspace`, `subtree`,
and `project` groupings. `cost: Unknown` remains Unknown. Settings exposes only
project/session, CreateProject, GrantPermission, layout preferences, and
capability-unavailable sections; issuer is the authenticated principal and no
Revoke UI is shown without a frozen grant inventory.

D9 adds first-class 390/768 layouts, mobile Conversation/Tree switching,
Queue/Attention detail sheets, mobile Verification cards, keyboard focus,
focus-managed sheets, Escape behavior, accessible labels, non-color status
signals, reduced-motion handling, overflow containment, and unified loading,
empty, stale, refreshing, unauthorized, authority-denied, validation,
network/unavailable, revision-conflict, and unknown-problem treatments.

## Verification

Fresh verification on merged `master`:

- `source env.sh && arbor pnpm check` — exit 0.
- Root suite: **215 test files, 1,230 tests passed**.
- Architecture: **18 files, 109 tests passed**.
- `source env.sh && arbor pnpm architecture` — exit 0; **18 files, 109 tests passed**.
- Web typecheck — exit 0 as part of `pnpm check`.
- `source env.sh && arbor pnpm --filter @arbor/web test` — exit 0;
  **32 files, 225 tests passed**.
- `source env.sh && arbor pnpm --filter @arbor/web build` — exit 0.
- Lint emitted 312 pre-existing warnings and no errors.

Focused D7/D8/D9 Web suites also passed during implementation, including Queue,
Attention, Usage, Settings, responsive shell, Problem rendering, and
refreshing-state coverage.

## Visual Gate 3

Evidence directory:
`planning/results/D7-D9-web-product-ui.visual/`

It contains **54 real Firefox screenshots** and `visual-metrics.json`, covering
1920, 1440, 1280, 1024, 768, and 390 CSS-pixel viewports. The checked pages
include Workbench, Queue, Attention, Work/Verification, Usage, Settings,
mobile Conversation, mobile Tree, mobile Queue and Attention detail sheets,
decision and acceptance receipts, keyboard-visible focus, settings below the
fold, and global empty/loading/refreshing/problem/conflict/unauthorized states.
Every captured viewport reports `documentWidth == bodyWidth == viewport width`;
the 390px run used Firefox Responsive Design Mode with a 390×844 CSS viewport.
The reduced-motion session reports
`prefers-reduced-motion: reduce == true`.

The browser run used a local transport serving frozen DTO fixtures solely to
inspect presentation and interaction. Its command receipts are evidence of
UI wiring only, not backend semantic evidence.

## Deviations and authorization

- One responsive presentation defect found by Visual Gate 3 (Settings root flex
  item lacking `min-width: 0`) was fixed with a regression assertion and a
  minimal CSS change.
- No new Design Gap, DTO, command, backend semantic, or frozen-contract change
  was required.
- D10 Final Convergence remains **NOT AUTHORIZED**. No D10 branch, worktree, or
  implementation was started.
