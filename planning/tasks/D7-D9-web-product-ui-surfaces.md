# Web Product UI D7–D9 — Governance, Usage, Settings, and Hardening

**Status:** COMPLETE / PHASE-BOUNDARY CLOSED at
`master@2420da771cdf8a1db8f2d5043f55b0391c817a80` (non-squash merge).

**Baseline:** `master@88744c5ac2d856044bb231e8c6abbd684dd0fded`

**Authorization:** D7 → D8 → D9 only. D10 Final Convergence remains
**NOT AUTHORIZED**.

## Sources and dependencies

- `planning/proposals/web-product-ui/01-implementation-spec.md` §§5.8–5.11,
  6, 8–9.
- Frozen API contracts and DID v1.17 semantics adopted by D-1.
- D7 depends on completed D4/D5 exact-target carriers.
- D8 depends on D3's shell/session foundations and D4's frozen views.
- D9 depends on D6 Workbench plus the D7 and D8 surfaces.

## D7 — Governance Queue and Attention

1. Build the actionable Queue as desktop master/detail and mobile
   list-to-detail sheet/fullscreen. Include only entries with exact structured
   action targets. `RecordDecision` binds only to exact
   `gov:<proposalId>:<revision>` targets and exposes Approve/Reject only.
2. Offer `AcceptWorkOutcome` only when the frozen current-work and verification
   fields pair exactly and the frozen prerequisites allow it.
3. Preserve successful Queue items when another workspace inbox query fails.
4. Keep Attention read-only. Group by severity/source, inspect only frozen DTO
   fields, and allow navigation to target workspace without mutation.

## D8 — Usage and Settings

1. Render server Usage rows for only `workspace`, `subtree`, or `project`
   `groupBy`; do not aggregate totals in the browser. Preserve Unknown cost.
2. Render only frozen Settings capabilities: project/session,
   CreateProject, GrantPermission, and local layout/preferences.
3. Derive `issuer` from the authenticated principal and render it read-only.
   Do not render a Revoke action without a frozen grant inventory. Keep
   unavailable capabilities informational.

## D9 — Mobile, accessibility, and shared states

1. Treat 390px and 768px as first-class layouts. Mobile Workbench opens on
   Conversation and can switch to Tree. Queue and Attention details use sheets;
   Work/Verification, Usage, and Settings remain usable on mobile.
2. Cover keyboard navigation, visible focus, dialog/sheet focus management,
   Escape, accessible labels, text status in addition to color,
   reduced motion, and horizontal overflow.
3. Present Loading, Empty, Ready, Stale, Refreshing, Unauthorized,
   AuthorityDenied, RevisionConflict, Validation, Network/Unavailable, and
   Unknown Problem states.
4. Preserve memory-only auth, server-truth views, invalidate/refetch-only WS
   messages, and no optimistic canonical state.

## Must not decide

- Add or infer DTO fields, commands, authority rules, or backend semantics.
- Implement deferred analytics or settings schemas, grant inventory/Revoke,
  or frozen-semantic conflicts.
- Start D10, merge this feature branch, or alter frozen Product UI/DID/P13/P14
  contracts.

## Acceptance and verification

- D7 focused Web tests and architecture boundary pass.
- D8 focused Web tests and architecture boundary pass.
- D9 Web typecheck, `pnpm check`, full Web suite, architecture, and production
  build pass.
- Visual Gate 3 checks the required pages and states at 1920, 1440, 1280,
  1024, 768, and 390 CSS pixels, with screenshots and viewport metrics archived
  at `planning/results/D7-D9-web-product-ui.visual/`.
- Result and final verification are recorded in
  `planning/results/D7-D9-web-product-ui-surfaces.result.md`.
