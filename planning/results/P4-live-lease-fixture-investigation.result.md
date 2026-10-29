# P4 Live-Lease Functional Fixture Investigation

Date: 2026-10-15
Base: `42ee71f6b10a9c95054429dad0af01b725c4e3bd`

## Outcome

The live-lease case remains unqualified. On the only run with the required Web
build present, the public `ResolveExecutableApproval` command returned
`Committed`, then the test timed out waiting for the old daemon's
`AH10AfterLeaseAcquired` probe. It did not reach the executable catalog or
shell effect boundary. The `visibleRefs` count and project registry contents
were therefore not observed in that run.

The test's lease event predicate now starts its timestamp window immediately
before the public approval request. This allows the scheduler to reacquire the
lease after the approval commit but before the HTTP response reaches the test.
The exact public approval and committed-resolution assertions remain in place.
The revised predicate has not been rerun.

The executable handler's exact-one `matchingRefs` gate was not changed. The
shell fixture continues to use `NonIdempotent` semantics.

## Diagnostics added

- The P4 child emits a bounded snapshot of builtin definition refs and their
  side-effect semantics, plus bounded main-entry/resolution/rejection markers.
- Failure snapshots include the target project's `project_tool_registry` rows,
  builtin catalog evidence, and the derived visible ref inventory (capped at 32
  refs).
- Failure artifacts under `.test-results` cover startup and approval-resume
  failures; the post-effect timeout artifact retains its execution-specific
  filename.

## Validation

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS; `apps/web/dist/index.html` present.
- `pnpm typecheck` — PASS.
- Targeted Biome check, `node --check` for the child, and `git diff --check` —
  PASS.
- Focused Vitest case — FAIL at the approval-resume lease wait described above.
  No rerun was made after changing the predicate and adding the final catalog
  snapshot fields.

An earlier focused attempt omitted the Web build; readiness returned 503
because `apps/web/dist/index.html` was absent. That startup artifact is retained
at `.test-results/p4-live-lease-startup-failure.json` and is not evidence about
P4 lease reacquisition or catalog visibility.
