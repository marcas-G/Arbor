# Web Product UI D4–D6 — Core Workbench Execution Plan

**Status:** APPROVED FOR EXECUTION — the product authorization supplied with
`D4 → D5 → D6` is the design approval for this plan.  D7–D10 are explicitly
out of scope.

**Baseline:** `master@00778fb1d1f8f87eb9ce3312742d2dbc12b025b0`

**Execution status:** COMPLETE / PHASE-BOUNDARY CLOSED at
`master@88744c5ac2d856044bb231e8c6abbd684dd0fded`. See
`planning/results/D4-D6-web-product-ui-core-workbench.result.md`.

## Constraints carried into every task

- The nine frozen views remain the sole server-state source through the
  existing TanStack Query and transport seams. WS only invalidates queries.
- The responsibility hierarchy is represented exclusively by the server's
  `TreeViewNode.parentWorkspaceId`; a client may calculate display indentation
  from those edges but never reconstruct an edge from preorder/name/index.
- Tree is read-only. No new command, event, DDL, authority, or protocol work.
- Root conversation is bound to the unique tree root. Submission retains the
  existing preallocated `msg_<uuid-v7>` and command retry behaviour, has no
  optimistic turn or stream, and never follows tree selection.
- Work commands use only exact carriers supplied by views. No revision `0`,
  client guess, synthetic target, or local lifecycle state.

## Task 1 — D4: reusable read-only responsibility tree

1. Add a tree presentation/index helper which validates/uses explicit parent
   edges only and preserves received preorder/sibling order.
2. Extract a reusable tree panel and inspection surface from Tree Focus:
   select/inspect locally; offer an explicit Open Workspace link; make
   inspection responsive without creating mutations.
3. Replace `/tree`'s click-to-navigate behaviour and stale flat-DTO comments;
   integrate the same server tree in `/p/:projectId` Workbench as its real
   context pane. Tree query failures and invalid hierarchy are presentation
   Problems, never normal emptiness.
4. Add focused hierarchy, interaction, loading/problem, and no-command tests.

**Commit:** `D4: implement read-only responsibility tree workbench context`

## Task 2 — D5: workspace/work source-bound governance

1. Make workspace/header and work detail use server `CurrentWorkSummary`
   revision only, including correct status/revision cards and SteerWork gate.
2. Gate acceptance on the paired frozen verification identity and exact triple:
   selected work ID, verification ID, and target work revision. Preserve server
   verdict/prerequisite authority rather than calculating it in the browser.
3. Keep root conversation editable and child conversation record-only; do not
   introduce made-up progress, ETA, timeline, or telemetry.
4. Update fixtures and test exact-source propagation and all blocked states.

**Commit:** `D5: bind workspace and work actions to server revisions`

## Task 3 — D6: root conversation Workbench

1. Replace the D3 conversation placeholder with real root transcript and the
   existing command-safe composer, initiated only after a successful unique
   root resolution from the tree.
2. Share a natural transcript presentation between the Workbench and workspace
   conversation tab. Child records remain explicitly read-only.
3. Preserve D3's desktop order/resize/double-click reset/local preference and
   its tablet/mobile single-pane selection while binding it to live data.
4. Test root binding, exact retry/idempotency, no optimistic bubble,
   root-only composer, selection non-retargeting, empty/loading/problem and
   responsive shell controls.

**Commit:** `D6: connect root conversation to the product workbench`

## Task 4 — phase gate and handoff

1. Run D4–D6 targeted Web tests/types and architecture checks after each
   commit; run full `pnpm check`, Web tests and architecture at the boundary.
2. Build `apps/web/dist`, serve the build with the existing compatible daemon,
   and conduct Visual Gate 2 at 1920, 1440, 1280, 1024, 768, and 390 pixels.
   Repair ordinary CSS/React/test defects within D4–D6 only.
3. Record screenshots/evidence and stop. New frozen semantic conflict or
   missing read-model is a Design Gap and stops the phase; D7–D10 are never
   started.
