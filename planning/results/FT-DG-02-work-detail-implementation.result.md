# FT-DG-02 — Work Detail implementation result

Date: 2026-10-08

Status: **IMPLEMENTATION FOLLOW-UP READY FOR REVIEW; F22 targeted
qualification PASS.**

## Authorization and scope

The user explicitly authorized implementation with the reply “授权实现（推荐）”
after FT-DG-02 was accepted and landed as System Design v1.10 / DID v1.32,
including the shared absent/foreign `NotFound` / HTTP 404 decision. This result
implements that accepted Work Detail contract only.

The implementation adds the read-only `work-detail` projection to the frozen
ViewId/request/response surface and wires it to canonical Work, Acceptance and
Verification repositories. Exact `{projectId, workspaceId, workId}` identity
is required. Missing and out-of-scope identities return the same typed
`projection/work-not-found` Problem with empty `safeDetails`. A Completed Work
without a same-revision Acceptance bound to its exact concluded PASS
Verification fails closed with a typed, non-retryable
`ProjectionIntegrityFailure`; the response contains no target identifiers.

The Work page renders objective, rationale, completion expectation, canonical
revision and lifecycle. It distinguishes `Open + acceptedResult` as “已验收、待完成”,
`Completed` as “已完成”, and `Cancelled` as “已取消”; cancellation labels any
preserved Acceptance as history. The Verification view selects only the
current revision's accepted Verification when an Acceptance exists. Terminal
Work pages expose no governance action controls. The Work ID remains available
inside a collapsed “工作引用” disclosure rather than primary page copy.

Independent review found a page-level privacy bypass: WorkPage queried
`workspace-detail` before the exact Work Detail lookup had succeeded. The page
now enables both `workspace-detail` and `verification` only after the returned
`{projectId, workspaceId, workId}` matches the route exactly. P10 failure
qualification now also injects wrong Work, wrong revision, wrong Verification
ID and non-PASS Verification bindings for a Completed Work; each fails with
`ProjectionIntegrityFailure`. This includes an explicit check that the
Verification returned by its repository has the exact ID named by Acceptance.

The P2 evidence-consistency review also found that Work Detail fixtures and
their rendering assertions still named the previous nine-view count. The P13
fixture header, embedded Verification criteria, and web assertions now all say
ten views × three fixtures; this is display/test evidence text only and does
not change fixture IDs or route identity.

No command, event, DDL, migration, authority or permission surface was added.
No files under `docs/design/**`, FT-DG-01, FT-DG-03, F21 or F23 were changed.
The accepted Work Detail DTO carries canonical lifecycle rather than a separate
completion-event timestamp; the page therefore presents the canonical
Completed state without inventing event-time semantics.

The F22 browser scenario is in the default functional UI suite at
`tests/functional/ui/completed-work-visibility.spec.ts`. The old pending copy
is retained as a skipped historical reproduction; it is not current red
evidence.

## Evidence

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- `pnpm --filter @arbor/web typecheck` — PASS.
- P10 contracts, projections, acceptance and ViewId suites — 48/48 PASS.
- Web Work Detail and renderer suites — 37/37 PASS, including Open with
  Acceptance, Completed, Cancelled, exact Verification/Acceptance binding,
  terminal action suppression, and the negative-route assertion that a failed
  exact Work Detail query sends no Workspace Detail or Verification request.
- Biome check on 20 touched implementation/test files — PASS.
- `pnpm --filter @arbor/web build` — PASS.
- Targeted F22 Playwright browser journey — 1/1 PASS. The test accepts a
  verification, records Acceptance, restarts the production fixture and opens
  the original Work URL; objective, Completed state, Acceptance and
  Verification remain visible. The test creates a second real Project and
  Workspace with a distinct resource boundary, then uses the existing real
  Work to probe absent Work, foreign Workspace and foreign Project identities.
  All three public API reads return HTTP 404 with identical Problem DTOs and
  empty `safeDetails`. On separate browser pages, each failed deep link sends
  only the exact `work-detail` request; no `workspace-detail` or `verification`
  fetch occurs and the target Work objective is not rendered.

The full `pnpm check` and `pnpm test:functional` were not run in this isolated
qualification; integration validation remains with the integration agent.

## Integration qualification (2026-10-08)

An independent review first found that a failed exact Work Detail lookup still
allowed a `workspace-detail` request. This was fixed by requiring the returned
Project/Workspace/Work identity to match the route before enabling either
`workspace-detail` or `verification`. The default browser test now uses actual
second Project/Workspace identities and asserts each failed deep link issues
only `work-detail`; independent re-review found no remaining P1 blocker.

Final validation:

- P10 Work Detail suites: 48/48 PASS; Web Work Detail/renderer suites: 37/37
  PASS; F22 default Playwright: 1/1 PASS.
- Full `pnpm check`: Biome 960 files; architecture 31 files/158 tests; core
  318 files/1733 passed/3 skipped; Web typecheck/build and 31 files/223 tests
  all PASS.
- The first full-check attempt stopped at a Biome export-order issue. The next
  two attempts exposed stale D0 Web fixture guardrails after the view count
  changed from nine to ten: first the expected ViewId list omitted
  `work-detail`, then its unknown lifecycle assertion expected `weird-state`
  while the fixture's literal unknown value is `Paused`. The guardrail now
  covers all ten views and asserts the fixture value; the final full run passed.
- The Web production build reports the existing advisory that the main JS
  chunk exceeds 500 kB; build succeeded. No design contract or F21/F23 code was
  changed. F21 and F23 remain open; FT-DG-02/F22 is qualified.

## Changed F22 files

- `packages/domain/src/projection.ts`
- `packages/api-contracts/src/views.ts`
- `packages/ports/src/errors.ts`
- `packages/projection-runtime/src/query-runtime.ts`
- `packages/projection-runtime/src/freshness.ts`
- `packages/projection-runtime/src/index.ts`
- `packages/projection-runtime/src/views/work-detail.ts`
- `packages/projection-runtime/src/views/verification.ts`
- `apps/single-workspace/src/projection-query.ts`
- `tests/support/p10-fixture.ts`
- `tests/p10-api-contracts.test.ts`
- `tests/p10-views-detail.test.ts`
- `tests/p10-acceptance.test.ts`
- `tests/p10-domain-events.test.ts`
- `apps/web/src/pages/work/WorkPage.tsx`
- `apps/web/src/pages/work/fixtures.ts`
- `apps/web/src/views/WorkDetailView.tsx`
- `apps/web/src/views/fixtures.ts`
- `apps/web/test/work-page.test.tsx`
- `apps/web/test/views-render.test.tsx`
- `tests/functional/ui/completed-work-visibility.spec.ts`
- `tests/functional/pending/completed-work-visibility.spec.ts` (historical
  copy is skipped and no longer described as the active red case)
- `planning/results/FT-DG-02-work-detail-implementation.result.md`

The shared `apps/single-workspace/src/composition.ts` change is the separate,
pre-existing AH19 binding-fingerprint work. F22 did not edit it; its original
fingerprint wiring remains present. No commit or push was made.
