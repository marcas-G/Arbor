# D-1 Result Record — Product UI Contract Closure

**Scope:** DID v1.17 TR-WPU-A–D only · **Date:** 2026-09-23 · **Authorization:** D-1 only;
D0–D10 remain explicitly unauthorized.

## Verdict

**D-1 scope COMPLETE.** The closure adopts the visual presentation supersession and lands the
minimum additive server read-model carriers without reopening P13/P14 backend work. No Design Gap
was found in the authorized scope. The repository-wide `pnpm check` was run but is not green for
one pre-existing base lint diagnostic documented below; all D-1 targeted, architecture, type,
Web fixture, test, and build evidence is green.

## Adopted contract surface

| TR | D-1 result | Compatibility / unchanged boundary |
|---|---|---|
| TR-WPU-A | DID v1.17 and P13 token contract now specify modern minimal light, warm-neutral/white surfaces, Arbor Green, sans UI/body, mono technical metadata, limited optional serif, and new spacing/radius/density. | Presentation only: no API, command/event, auth, WS, SSoT, authority, or backend change. No visual implementation was started. |
| TR-WPU-B | `TreeViewNode.parentWorkspaceId` is required and server-projected from canonical Workspace. Projection rejects zero/multiple roots, dangling parents and cycles before root-first preorder traversal. | Additive field; ordered/list clients can ignore it. No `depth`, mutation, DDL, or browser parent reconstruction. |
| TR-WPU-C | `CurrentWorkSummary.revision` is required and copied from canonical `Work.revision` through current-work, workspace-detail and Tree current-work. | Additive read value; no Work mutation/change to command semantics. Tree absence omits `currentWork`; a present value includes status/revision. |
| TR-WPU-D | Selected Verification pairs `verificationId` with frozen `targetWorkRevision`; acceptance is shown only for the same verification ID. Documentation makes `/p/:projectId` the Root Workbench landing and preserves Tree Focus/root deep-link mirror. | Additive read value and IA record only; no acceptance command/event/authority/transport change and no route/component implementation. |

## API / projection migration

- `packages/api-contracts/src/views.ts`: adds `parentWorkspaceId`, canonical `revision`, and
  conditional `targetWorkRevision` with branded `WorkRevision` types.
- `packages/projection-runtime/src/tree.ts`: validates the canonical parent graph before deriving;
  copies parent, status and canonical revision.
- `packages/projection-runtime/src/query-runtime.ts`: keeps preorder flattening, removes only
  derive-side `children`, and omits absent `currentWork` from the wire.
- `views/current-work`, `views/workspace-detail` and shared mirrors carry canonical Work revision.
- `views/verification` and workspace detail construct the selected Verification identity pair from
  the canonical row and filter acceptance by `verificationId`.
- Typed Web fixtures/mocks carry server-shaped values. No page-level form binding was changed:
  existing W-08 `revision=0` page props remain explicitly deferred to D7/D0–D10 authorization.

## Mechanical evidence

| Gate | Evidence | Result |
|---|---|---|
| API/projection + D-1 static regressions | `vitest run tests/p10-api-contracts.test.ts tests/p10-acceptance.test.ts tests/p10-views-detail.test.ts tests/architecture/d1-product-ui-contract-closure.test.ts` | PASS — 4 files / 45 tests |
| Root typecheck | `pnpm typecheck` | PASS |
| Architecture | `pnpm architecture` | PASS — 18 files / 109 tests |
| Web fixture/type/build | `pnpm --filter @arbor/web typecheck` + `build` | PASS |
| Web suite | `pnpm --filter @arbor/web test` | PASS — 26 files / 171 tests |
| D-1 source formatting/lint | Biome check over every D-1 TypeScript producer/fixture/test | PASS — 13 scoped files |
| Full orchestration | `pnpm check` | RUN; exits 1 at pre-existing `BootstrapPage.tsx` import-order lint diagnostic before later stages. It is present in base `0753911`; its independent user-owned primary-workspace correction was not taken into this D-1 branch. |

The Tree test includes valid preorder/parent edges plus zero root, multiple root, dangling parent,
and cycle rejection. Revision source tests use nonzero canonical Work revision `7`, Tree revision
`4`, and selected Verification target revision `5`/`7`; acceptance mismatch at the same Work
revision is rejected from the read view. The D-1 static scan rejects a newly introduced
`revision = 0` fallback in D-1 projection/API/Web-fixture producers. It does not rewrite deferred
W-08 page bindings.

## Independent review

An independent review first found two Important issues: the public Verification DTO allowed a
one-sided identity pair, and the two proposal records still selected root by preorder index. The
API now uses an all-or-nothing `VerificationIdentity` union with negative compile-time fixtures;
the proposals select the unique server-projected `parentWorkspaceId === null` node and an
architecture regression forbids a `nodes[0]` rule there. Re-review found no Critical or Important
issues and judged **Blocking=0**. Its one Minor finding—the old C4 illustrative optional/`number`
snippet in `02-contract-closure.md`—was also reconciled to the adopted union and `WorkRevision`.

## Closure status

```text
G1a SteerWork revision carrier       CLOSED (TR-WPU-C)
G1b Acceptance target revision       CLOSED (TR-WPU-D)
G6  Tree hierarchy relation          CLOSED (TR-WPU-B)
G2  PermissionGrant inventory        DEFERRED
G3  rich project/member/provider/... DEFERRED
G4  advanced usage analytics         DEFERRED
G5  richer Attention semantics       DEFERRED
```

No command semantics, event semantics, DDL, authority, transport protocol, canonical
responsibility semantics, System Design, or D0–D10 implementation changed.
