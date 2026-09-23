# D-1 Product UI Contract Closure Implementation Plan

> **For agentic workers:** Execute inline task-by-task with a failing test before production
> code. Do not start D0–D10.

**Goal:** Adopt DID v1.17 and land only the TR-WPU-A–D presentation/read-model contract
migration, with no canonical semantic, command, DDL, authority, transport, or Web-surface change.

**Architecture:** The public view DTOs gain only parent and exact revision carriers. Projection
derives copy them from canonical Workspace, Work, and Verification records; Tree validates its
input hierarchy before building its existing preorder wire list. Documentation records the narrow
v1.17 supersession while preserving P13/P14 historical boundaries.

**Tech Stack:** TypeScript 7, Effect 4, Vitest 5, pnpm workspace, Markdown governance records.

**Spec:** `planning/proposals/web-product-ui/01-implementation-spec.md` and
`planning/proposals/web-product-ui/02-contract-closure.md`

## Global Constraints

- System Design v1.3, canonical aggregates, events, commands, DDL, authority, and HTTP/WS stay unchanged.
- `TreeViewNode.parentWorkspaceId` is additive; no `depth` field or nested wire children is introduced.
- Current Work and Verification revisions always originate in canonical records; no browser/default `0`.
- A root composer, visual redesign, or any D0–D10 work is out of scope.
- G2–G5 remain deferred and fail closed.

---

### Task 1: Add failing public-contract and projection regressions

**Files:**

- Modify: `tests/p10-api-contracts.test.ts`
- Modify: `tests/p10-acceptance.test.ts`
- Modify: `tests/p10-views-detail.test.ts`
- Modify: `apps/web/src/views/fixtures.ts`
- Modify: affected `apps/web/test/*.test.tsx` fixture consumers

**Interfaces:**

- Consumes: frozen canonical `Workspace.parentWorkspaceId`, `Work.revision`, and
  `Verification.targetWorkRevision`.
- Produces: failing expectations for public Tree, CurrentWorkSummary, and VerificationView wire
  shapes; malformed hierarchy rejection; exact acceptance identity matching.

- [x] **Step 1: Add API shape fixtures**

  Require a Tree node to carry `parentWorkspaceId`, a present CurrentWorkSummary to carry
  `revision`, and a present Verification identity to carry `targetWorkRevision`. Assert an empty
  Verification has neither paired identity member.

- [x] **Step 2: Run the focused API test and observe RED**

  Run: `pnpm vitest run tests/p10-api-contracts.test.ts`

  Expected: the new DTO object literals fail type checking or the shape assertions fail because
  the carriers do not yet exist.

- [x] **Step 3: Add projection regression cases**

  Add cases for zero root, multiple roots, dangling parent, and a parent cycle; each must reject
  before traversal. Add a valid root-first preorder case with explicit parent edges, tree current
  Work `status`/`revision`, and omitted absent currentWork. Add exact Work revision propagation
  and a re-verification-at-the-same-revision case that must not attach another verification's
  acceptance.

- [x] **Step 4: Run focused projection tests and observe RED**

  Run: `pnpm vitest run tests/p10-acceptance.test.ts tests/p10-views-detail.test.ts`

  Expected: hierarchy construction currently promotes bad parents/uses first root; current-work
  and verification derives omit the new revision values.

- [x] **Step 5: Update typed Web fixtures only**

  Add server-supplied values to every typed fixture/mock; retain a literal `0` only where a test
  explicitly models a server-supplied revision. Add a static regression scan for D-1
  read-model producers and typed fixtures; page-level command binding stays deferred to D7.

### Task 2: Implement the minimal API and projection migration

**Files:**

- Modify: `packages/api-contracts/src/views.ts`
- Modify: `packages/projection-runtime/src/tree.ts`
- Modify: `packages/projection-runtime/src/query-runtime.ts`
- Modify: `packages/projection-runtime/src/views/shared.ts`
- Modify: `packages/projection-runtime/src/views/current-work.ts`
- Modify: `packages/projection-runtime/src/views/workspace-detail.ts`
- Modify: `packages/projection-runtime/src/views/verification.ts`

**Interfaces:**

- Consumes: the failing tests from Task 1 and canonical read dependencies already injected into
  each derive.
- Produces: additive typed DTOs and exact, read-only projections.

- [x] **Step 1: Make public DTOs satisfy the new carriers**

  Add `parentWorkspaceId: WorkspaceId | null`, `revision: WorkRevision`, and conditional
  `targetWorkRevision?: WorkRevision`. Keep `TreeViewRes.nodes` preorder and request shape
  unchanged.

- [x] **Step 2: Make Tree validation and wire adaptation pass**

  Reject invalid hierarchy input before `childrenOf` traversal; use the sole null-parent root;
  copy parent IDs. Copy Work `lifecycle` and `revision` into a present current Work. At the wire
  boundary omit internal `currentWork: null` and emit no `children` member.

- [x] **Step 3: Make Work and Verification derives pass**

  Copy `work.revision` through current-work, workspace-detail, and Tree. Build Verification
  identity as a pair from the selected canonical row. Only expose AcceptanceView when the found
  acceptance's verificationId matches that selected row.

- [x] **Step 4: Run focused suites and observe GREEN**

  Run: `pnpm vitest run tests/p10-api-contracts.test.ts tests/p10-acceptance.test.ts tests/p10-views-detail.test.ts`

  Expected: all carrier, malformed hierarchy, and exact-identity cases pass with no canonical
  writes.

- [x] **Step 5: Commit the API/projection migration**

  Commit only Task 1/2 code and test files as `feat: close product UI read-model contracts`.

### Task 3: Adopt the v1.17 governance record and validate closure

**Files:**

- Modify: `docs/design/03-detailed-implementation-design.md`
- Modify: `docs/design/implementation/P13/00-contract-index.md`
- Modify: `docs/design/implementation/P13/04-design-tokens.md`
- Modify: `docs/design/implementation/P14/00-contract-index.md`
- Modify: `docs/design/implementation/P14/04-web-surface.md`
- Modify: `AGENTS.md`
- Modify: `planning/results/` D-1 result record

**Interfaces:**

- Consumes: the approved TR-WPU-A–D closure and passing migration evidence.
- Produces: DID v1.17 governance adoption, phase/index supersession markers, and a D-1 evidence
  record without reopening P13/P14 backend phases.

- [x] **Step 1: Write the DID v1.16 → v1.17 governance record**

  Update the DID header/status/supersedes/version markers and append TR-WPU-A–D. State that
  only visual presentation, additive read models, and landing route placement supersede prior
  documents; canonical semantics stay frozen.

- [x] **Step 2: Update only owning phase/index passages**

  Make P13 token rules defer their superseded visual values to TR-WPU-A, and make P14 Web Surface
  describe `/p/:projectId` Workbench plus its existing root conversation deep-link mirror. Record
  successor TRs in P13/P14 indices without changing their historic P13/P14 baseline claims.

- [x] **Step 3: Update baseline/status records**

  Correct AGENTS and DID Appendix C to v1.17, state D-1 complete only after final evidence, and
  record G1a/G1b/G6 closed while G2–G5 remain deferred.

- [x] **Step 4: Run closure verification**

  Run: targeted projection/API suites; Web fixture/type suites; `pnpm architecture`; `pnpm check`.

  Evidence: targeted projection/API, architecture, Web type/build/test, and D-1 producer/fixture
  static scan pass. Full `pnpm check` was run and stops at one pre-existing base import-order
  diagnostic in `apps/web/src/pages/bootstrap/BootstrapPage.tsx`; it is outside D-1 and the
  primary workspace already has an unrelated user-owned correction. No D0–D10 production surface
  changes are present.

- [x] **Step 5: Commit DID adoption and result evidence**

  Commit documentation/evidence only as `docs: adopt DID v1.17 product UI closure`.
