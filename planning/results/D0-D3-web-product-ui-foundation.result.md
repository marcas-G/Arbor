# D0–D3 Result Record — Web Product UI Foundation

**Date:** 2026-09-24
**Scope:** baseline hygiene plus authorized D0 → D1 → D2 → D3 only.
**Authorization boundary:** D4–D10 remain explicitly unauthorized.

## Verdict

**D0–D3 COMPLETE; D3 Visual Gate PASS.** No frozen-semantic conflict and no new
Design Gap was found. The Root Workbench is intentionally a shell: it does not
start D4 Tree data/graph work, D5 workspace views, D6–D8 affordances, or any
new command/transcript behavior.

## Commit ledger

| Scope | Commit | Result |
|---|---|---|
| Baseline hygiene | `6eac3f6` | Restored the sole `BootstrapPage.tsx` import-order diagnostic, without behavior or visual changes. |
| D-1 test compatibility | `d30a2f7` | Completed latent expectations for already-adopted additive read-model fields. |
| D0 | `1846594` | Locks the nine-view × typical/minimal/unknown fixture matrix, six Problem categories, project route round-trips, forbidden-control scans, and C2–C4 carriers. |
| D1 | `f8a43dd` | Establishes the TR-WPU-A modern-light token/primitives foundation. |
| D2 | `4391dc2` | Adds regressions for the retained transport/query/WS/session/retry seams. |
| D3 | `9068172` | Makes `/p/:projectId` the responsive Root Workbench shell with local-only pane order and splitter preferences. |
| D0–D3 lint closure | `b20d489` | Formats affected D1/D2 files and makes the token mirror robust to formatter line wrapping. |

## Delivered surface

- **D0:** all nine frozen views are represented by typed typical, minimal, and
  unknown fixtures. The contract scans reject `SendMessage`, `AdmitExecution`,
  streaming readers, transcript optimism, cache writes, and indexed Tree-root
  inference. `parentWorkspaceId`, canonical Work `revision`, and paired
  Verification identity/revision are exercised in Web fixtures.
- **D1:** the shared token/primitives layer is modern minimal light: warm-neutral
  and white surfaces, Arbor Green emphasis, sans UI typography, mono technical
  metadata, new radius/spacing/density, and accessible Dialog/Sheet behavior.
- **D2:** existing typed History routing, memory-only auth, TanStack Query
  server-state ownership, invalidation-only WS handling, and command
  retry/idempotency were retained. No alternative state/transport layer was
  introduced.
- **D3:** `/p/:projectId` now opens the Workbench. Desktop and laptop show
  Tree ⇄ Conversation; pane order can swap, a divider resizes the Tree share,
  double-click resets it, and preference storage is strictly
  `{ order, treeBasis }`. Tablet stacks panels; mobile exposes a one-panel
  switcher. Project switching remains independent from conversation history.

## Production-like Visual Gate

`pnpm --filter @arbor/web build` produced the latest `apps/web/dist`; the
single-workspace daemon served the same generated assets over one origin. The
browser used the real memory-only LoginCard path. Because that credential state
cannot be seeded or persisted, a temporary, untracked copy of `index.html`
contained only a browser-test driver that typed the daemon token into the real
form and clicked the actual controls. It did not change the committed app,
transport, auth semantics, or generated asset bundles.

| Viewport | Browser check | Evidence |
|---|---|---|
| 1920 × 1080 | Two panes, resized Tree share, typography and desktop navigation are coherent. | [1920 resized](D0-D3-web-product-ui-foundation.visual/1920-resize.png) |
| 1440 × 960 | Pane order is swapped: Conversation is left and Tree is right. | [1440 swapped](D0-D3-web-product-ui-foundation.visual/1440-swap.png) |
| 1280 × 900 | Laptop double-pane layout retains usable density and divider. | [1280 resized](D0-D3-web-product-ui-foundation.visual/1280-resize.png) |
| 1024 × 768 | Narrow desktop remains a usable two-pane Workbench. | [1024 swapped](D0-D3-web-product-ui-foundation.visual/1024-swap.png) |
| 768 × 1024 | Tablet stacks Tree then Conversation; desktop divider is absent. | [768 tablet](D0-D3-web-product-ui-foundation.visual/768-reset.png) |
| 390 × 844 | Mobile uses one-panel mode; the real switcher is shown on Tree. | [390 mobile Tree](D0-D3-web-product-ui-foundation.visual/390-mobile-tree.png) |

Focused Workbench tests additionally exercise pointer resize, pointer cancel,
double-click reset, keyboard clamp/reset, preference validation/persistence,
mobile switching, and CSS breakpoints. No CSS/React/layout repair was needed
after the production-like browser pass. The deliberate empty guidance in each
pane is the D3 scope boundary, not a visual defect.

## Final gate evidence

| Gate | Result |
|---|---|
| `pnpm check` | **PASS, exit 0.** Lint emitted existing warning-only diagnostics; typecheck, architecture, root tests, Web typecheck/build, and Web tests all completed. |
| Root architecture (inside `pnpm check`) | **PASS** — 18 files / 109 tests. |
| Root tests (inside `pnpm check`) | **PASS** — 215 files / 1230 tests. |
| Web tests (inside `pnpm check`) | **PASS** — 29 files / 200 tests. |
| Focused D3 after implementation/review | **PASS** — 29 files / 200 tests; Web typecheck and build PASS. |
| Worktree hygiene | P12 restore-drill's generated timestamp/hash were restored after verification; no generated drift is retained. |

## Review and next authorization

Independent D3 review found and resolved the pointer-cleanup, mobile-control
semantics, and responsive-coverage issues before `9068172`; the re-review was
**Blocking=0**. No new Design Gap arose during final verification.

**Recommendation:** the D3 visual gate is sufficient to request a separate
authorization for D4–D10. This run stops here and does not begin them.
