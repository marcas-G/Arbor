# D0–D3 Web Product UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a clean Web baseline, then deliver the authorized D0–D3
contract guardrails, modern visual foundation, preserved runtime seams, and
responsive Root Workbench shell—without beginning D4–D10 product-surface work.

**Architecture:** D0 makes every frozen view and problem shape executable in
fixtures and static contract scans. D1 changes only token-driven presentation
and shared primitives. D2 proves the existing History router, memory-only
session, TanStack Query and WS invalidation seams remain the sole state and
transport paths. D3 composes those seams into a route-owned, local-layout-only
Workbench shell; it does not create new server state, commands, or Tree/
Conversation domain behavior.

**Tech Stack:** React 19, TypeScript 7, Vite 8, Vitest 5, TanStack Query 5,
CSS Modules/custom properties, existing single-workspace same-origin daemon.

**Spec:** `planning/proposals/web-product-ui/01-implementation-spec.md` and
`planning/proposals/web-product-ui/02-contract-closure.md`

## Global Constraints

- Work from DID v1.17/TR-WPU-A–D: use modern minimal light, warm-neutral
  surfaces, Arbor Green, sans UI/body, mono technical metadata, and the new
  spacing/radius/density—never restore the old paper/leaf/serif/3px visual
  baseline.
- Preserve API, command/event semantics, authority, DDL, HTTP/WS protocol,
  TanStack Query cache ownership, WS invalidation-only behavior, retry/
  idempotency, memory-only auth, and typed History routing.
- `parentWorkspaceId`, `CurrentWorkSummary.revision`, and paired
  `verificationId`/`targetWorkRevision` are server values; no browser parent
  reconstruction or revision fallback/guessing is permitted.
- Never surface `SendMessage`, `AdmitExecution`, streaming, optimistic
  transcript entries, credential persistence, or an unapproved server route.
- D3 may persist layout presentation preference only in browser-local UI
  storage; it must never contain credentials, project/server data, canonical
  state, or command state.
- D4–D10 are out of scope. D3 must stop for a production-like visual gate;
  only a frozen semantic conflict or new Design Gap stops this authorized run.

---

### Task 0: Baseline hygiene—Bootstrap import ordering

**Files:**

- Modify: `apps/web/src/pages/bootstrap/BootstrapPage.tsx`
- Test: root `pnpm check`, Web tests, architecture suite

**Interfaces:**

- Consumes: existing Biome import-order rule.
- Produces: no behavioral or visual changes; a green baseline commit that
  later D0–D3 commits can build on.

- [x] **Step 1: Verify the sole baseline diagnostic**

  Run `pnpm check` with the repository's Node/Biome compatibility launcher.
  Confirm the only error is Biome `assist/source/organizeImports` at
  `BootstrapPage.tsx:8`, and compare the file to the user-owned main-worktree
  correction without copying any other change.

- [x] **Step 2: Apply only the Biome import order**

  Move the command-form/type imports before the visual Card import, preserving
  every import, component body, behavior and stylesheet unchanged.

- [x] **Step 3: Run the baseline gates**

  Run `pnpm check`, `pnpm --filter @arbor/web test`, and `pnpm architecture`.
  Expected: every command exits 0.

- [x] **Step 4: Commit hygiene only**

  Commit only `BootstrapPage.tsx` as
  `chore(web): restore baseline import ordering`.

### Task 0b: Complete latent D-1 expectation coverage

**Files:**

- Modify: `tests/p10-tree-status.test.ts`, `tests/p12-transport.test.ts`
- Test: root `pnpm check`

**Interfaces:**

- Consumes: committed D-1 Tree projection fields (`parentWorkspaceId`, current
  Work `status` and canonical `revision`).
- Produces: historical integration expectations that fully describe the
  additive D-1 DTO instead of rejecting the valid new fields.

- [x] **Step 1: Reproduce the two latent assertions**

  Run `pnpm test -- tests/p10-tree-status.test.ts tests/p12-transport.test.ts`.
  Confirm only the old current-work and Tree key-list expected values fail
  because D-1 has already correctly added fields.

- [x] **Step 2: Update expectations, not the D-1 implementation**

  Require Tree current Work to include `status: "Open"` and `revision: 0` in
  the canonical test seed, and require transport to preserve the additive
  `parentWorkspaceId` key in its unchanged DTO response.

- [x] **Step 3: Run the clean baseline gates and commit**

  Run `pnpm check`, Web tests and architecture. Commit test-only compatibility
  completion as `test: complete D-1 read-model expectation coverage`.

### Task 1: D0 contract guardrails and fixture matrix

**Files:**

- Modify: `apps/web/src/views/fixtures.ts`
- Create: `apps/web/test/d0-contract-guardrails.test.ts`
- Modify: `apps/web/test/api-router.test.ts`,
  `apps/web/test/no-forbidden-controls.test.tsx`, and fixture consumer tests
  when TypeScript requires the frozen carrier fields.

**Interfaces:**

- Consumes: all nine `ViewResponseMap` entries, six `Problem` categories, and
  the D-1 Tree/Work/Verification carriers.
- Produces: named typical/minimal/unknown fixture variants and scan-level
  regression coverage that D1–D3 can use without changing transport.

- [x] **Step 1: Write failing D0 tests**

  Require three fixtures for each of responsibility-tree, attention,
  workspace-detail, current-work, verification, dependency-view, transcript,
  usage and inbox-view. Assert the tree root comes only from the unique
  `parentWorkspaceId === null`, present current Work includes its server
  revision, and selected Verification identity has both exact fields. Assert
  all six Problem categories render, every typed route round-trips its
  `projectId`, and source scans reject forbidden command names, EventSource,
  WebSocket transcript payload handling, and local transcript mutation.

- [x] **Step 2: Run D0 tests RED**

  Run `pnpm --filter @arbor/web test -- d0-contract-guardrails api-router
  no-forbidden-controls problems-render`. Expected: the matrix module and its
  exhaustive fixture assertions do not yet exist.

- [x] **Step 3: Add the minimum typed fixture matrix and scans**

  Export one `D0_VIEW_FIXTURES` record keyed by all nine View IDs with
  `typical`, `minimal`, and `unknown` values. Reuse existing real DTO fixture
  rows, make unknown labels literal server values, and add no new fetch/cache
  code. Extend the existing scans rather than inventing an alternate contract
  registry.

- [x] **Step 4: Run D0 tests GREEN and commit**

  Run the focused suite and `pnpm --filter @arbor/web typecheck`; commit D0
  code/tests as `test(web): lock product UI contract guardrails`.

### Task 2: D1 visual foundation and primitive coverage

**Files:**

- Modify: `apps/web/src/tokens.ts`, `apps/web/src/tokens.css`,
  `apps/web/src/styles/reset.css`, `apps/web/src/components/components.css`
- Modify: existing component modules for Button/Input/Card/Badge/Dialog/Empty/
  Problem; create a shared Sheet primitive if no existing Dialog behavior can
  represent a bottom/side panel accessibly.
- Modify: `apps/web/test/tokens.test.ts`,
  `apps/web/test/design-system.test.tsx`, and Problem rendering tests.

**Interfaces:**

- Consumes: D0 fixture guardrails and the P13/TR-WPU-A token discipline.
- Produces: a token-only modern-light primitive layer; semantic class names
  remain stable for present page consumers.

- [x] **Step 1: Write D1 visual/primitive tests RED**

  Assert a sans primary body token, non-3px radius scale, warm neutral/white
  surfaces, Arbor Green primary Button, mono technical component, card density,
  unknown badge treatment, and Dialog/Sheet keyboard close/focus behavior.
  Assert no primitive uses legacy serif as UI body or literal colors/sizes.

- [x] **Step 2: Run D1 tests RED**

  Run `pnpm --filter @arbor/web test -- tokens design-system problems-render`.
  Expected: legacy serif and 3px token expectations fail and Sheet is absent.

- [x] **Step 3: Implement token-first visual foundation**

  Update the mirrored TS/CSS token source together; preserve the named-token
  invariant. Update primitives and component CSS to consume only tokens,
  compactly normalize controls, add an accessible Sheet surface, and retain
  status/unknown text semantics.

- [x] **Step 4: Run D1 tests GREEN and commit**

  Run focused D1 tests, Web typecheck and build; commit as
  `feat(web): establish modern product visual foundation`.

### Task 3: D2 runtime seam preservation regressions

**Files:**

- Modify: `apps/web/test/api-transport.test.ts`,
  `apps/web/test/ws-invalidation-query.test.tsx`, `apps/web/test/session.test.tsx`,
  `apps/web/test/command-forms.test.tsx`, and D0 contract scan as needed.
- Modify production code only if a D1/D3 presentation change threatens an
  existing seam; do not replace `transport.ts`, `useViewQuery.ts`, router,
  session provider, or command submission abstractions.

**Interfaces:**

- Consumes: existing transport/query/session/command modules and D-1 carriers.
- Produces: explicit evidence that the visual work has no protocol/state-layer
  fork and passes server-supplied zero revisions through unchanged.

- [x] **Step 1: Write D2 seam tests RED**

  Add a static/behavior assertion that a page boundary receives a server
  `revision: 0` value unchanged and has no fallback assignment, while the
  existing WS test continues to prove invalidate/refetch without frame DTO
  payload. Assert auth source has no credential storage and router navigation
  remains typed project-scoped.

- [x] **Step 2: Run D2 tests RED**

  Run the named transport/WS/session/command regression tests. Expected: the
  new page-boundary no-guessing assertion is absent before D3 wiring.

- [x] **Step 3: Add only regression coverage or the narrowest seam repair**

  Reuse existing query keys, invalidation channel and `navigate` API. If a
  D3 component needs a local UI preference, isolate it in a layout hook and
  never pass it through a query, route, session or command envelope.

- [x] **Step 4: Run D2 tests GREEN and commit**

  Run focused D2 tests plus Web typecheck; commit as
  `test(web): preserve product runtime seams`.

### Task 4: D3 responsive App Shell and Workbench skeleton

**Files:**

- Modify: `apps/web/src/api/router.ts`, `apps/web/src/pages/AppRouter.tsx`,
  `apps/web/src/shell/AppShell.tsx`, `apps/web/src/shell/shell.module.css`
- Create: `apps/web/src/pages/workbench/RootWorkbenchPage.tsx`,
  `apps/web/src/pages/workbench/workbench.module.css`, and a focused local
  splitter/preference hook if it keeps the page component concise.
- Modify: `apps/web/test/api-router.test.ts`, `apps/web/test/session.test.tsx`,
  and create `apps/web/test/workbench-shell.test.tsx`.

**Interfaces:**

- Consumes: `Route` with canonical `/p/:projectId`, D1 primitives and D2's
  unmodified runtime seams.
- Produces: an accessible responsive product shell whose primary landing is
  Root Workbench with local-only Tree/Conversation pane order and size.

- [x] **Step 1: Write D3 shell tests RED**

  Assert `/p/:projectId` resolves to a Workbench route/page, project switch
  navigates independently of conversation history, desktop exposes Tree and
  Conversation panes plus swap/reset/drag-divider controls, double-clicking
  divider restores the documented default, and mobile exposes one-pane
  navigation without the desktop splitter. Assert the preference payload has
  only `{order, treeBasis}` and no token/project/server values.

- [x] **Step 2: Run D3 tests RED**

  Run `pnpm --filter @arbor/web test -- workbench-shell api-router session`.
  Expected: the project overview dashboard still owns `/p/:projectId` and no
  local Workbench layout controller exists.

- [x] **Step 3: Implement the shell-only Workbench**

  Replace the `project-overview` route presentation with `workbench` while
  retaining its URL and all other route formats. Render only skeleton Tree and
  Conversation panes with semantic loading/empty guidance—no D4 graph
  rendering, transcript query/composer, workspace tab, or command action.
  Use pointer/click handlers for a local splitter, swap pane order without
  changing data targets, and CSS media queries for desktop, laptop/tablet,
  and mobile single-pane behavior.

- [x] **Step 4: Run D3 tests GREEN and commit**

  Run focused tests, Web build/typecheck, and root architecture; commit as
  `feat(web): add responsive product workbench shell`.

### Task 5: D3 production-like visual gate

**Files:**

- Create: `planning/results/D0-D3-web-product-ui-foundation.result.md`

**Interfaces:**

- Consumes: latest `apps/web/dist` and existing single-workspace static
  transport daemon.
- Produces: captured visual evidence for 1920, 1440, 1280, 1024, 768 and
  390 viewport widths, with no advance into D4–D10.

- [x] **Step 1: Build and host the actual dist same-origin**

  Run `pnpm --filter @arbor/web build`, start the repository daemon with
  `ARBOR_WEB_DIST` pointing at that dist, and use the frozen login/session
  path or production-like fixture service only through existing HTTP/WS seams.

- [x] **Step 2: Exercise visual gate in a browser**

  Capture viewport screenshots at 1920, 1440, 1280, 1024, 768 and 390. Check
  pane proportion/typography/navigation/spacing, swap/drag/double-click
  reset, mobile one-pane mode, and absence of bare/demo presentation.

- [x] **Step 3: Repair ordinary CSS/React/layout defects and repeat**

  Keep repairs inside D0–D3 presentation/skeleton scope, rerun focused tests
  after every repair, and stop only if a frozen semantic conflict or new Design
  Gap appears.

- [x] **Step 4: Run final gates and record evidence**

  Run `pnpm check`, Web tests and architecture; record exact outcomes, visual
  paths and any residual visual deviations. Commit the result as
  `docs(web): record D0-D3 visual gate` and stop before D4.
