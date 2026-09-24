# D4–D6 Result Record — Web Product UI Core Workbench

**Date:** 2026-09-24
**Scope:** Authorized D4 → D5 → D6 implementation and phase-boundary closure only.
**Final baseline:** `master@67112659c3167785b3a4f16b3bc59da4ae6cd4b7`
**Authorization boundary:** D7–D10 remain NOT AUTHORIZED.

## Verdict

**D4–D6 COMPLETE; phase-boundary CLOSED.** The adopted implementation passes
the final repository gate and the Visual Gate 2 viewport review. No new Design
Gap or frozen-semantic conflict was found. D7–D10 were not started.

## Adoption

| Scope | Commit | Adoption |
|---|---|---|
| D4 read-only responsibility tree | `7889cef2` | Reachable from final `master` |
| D5 server-revision-bound workspace/work actions | `01dd6ea0` | Reachable from final `master` |
| D6 root conversation Workbench | `6f2afa37` | Reachable from final `master` |
| Visual Gate responsive repair | `16a41f6f` | Reachable from final `master` |
| Phase merge | `67112659` | Final `master` HEAD |

The feature worktree was clean, its HEAD (`16a41f6f`) was fully contained by
`master`, and it had no unique commits or stash entries. The worktree was
removed after those checks; `codex/d4-d10-web-product-ui` was retained.

## Visual Gate 2

The final captured screenshots are archived under
`D4-D6-web-product-ui-core-workbench.visual/`.

| Viewport | Evidence |
|---|---|
| 1920 × 900 | [1920](D4-D6-web-product-ui-core-workbench.visual/1920.png) |
| 1440 × 900 | [1440](D4-D6-web-product-ui-core-workbench.visual/1440.png) |
| 1280 × 900 | [1280](D4-D6-web-product-ui-core-workbench.visual/1280.png) |
| 1024 × 900 | [1024](D4-D6-web-product-ui-core-workbench.visual/1024.png) |
| 768 × 900 | [768](D4-D6-web-product-ui-core-workbench.visual/768.png) |
| 390 × 844 — Tree selected | [390 Tree](D4-D6-web-product-ui-core-workbench.visual/390-tree.png) |
| 390 × 844 — Conversation selected | [390 Conversation](D4-D6-web-product-ui-core-workbench.visual/390-conversation.png) |

The final desktop captures show the two-pane Workbench and divider; tablet
shows the stacked panes; the two mobile captures show the Tree / Conversation
switch. `apps/web/test/workbench-shell.test.tsx` passed and covers pane swap,
pointer resize, double-click reset, and mobile pane switching. The responsive
mobile-navigation repair is limited to presentation CSS and shell tests.

## Final verification

Command on final `master`: `source ./env.sh && arbor pnpm check` — **PASS,
exit 0**. This includes lint, typecheck, architecture, root tests, Web
typecheck/build, and Web tests.

| Gate | Result |
|---|---|
| Root architecture | **PASS** — 18 files / 109 tests |
| Root tests | **PASS** — 215 files / 1230 tests |
| Web tests | **PASS** — 31 files / 211 tests |
| Web typecheck and production build | **PASS** |
| Lint | **PASS** — 314 warnings, no errors |

The interaction suite includes the D4–D6 Workbench shell coverage. The final
commit range does not change `docs/design/**`, the frozen Web Product UI
Implementation Specification, or Contract Closure. No new Design Gap was
identified.

## Phase status

```text
D-1     COMPLETE
D0–D3   COMPLETE
D4–D6   COMPLETE / PHASE-BOUNDARY CLOSED
D7–D10  NOT AUTHORIZED
```
