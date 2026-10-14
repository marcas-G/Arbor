# RAI-DG-01 Work Readmission Hold Qualification

**Status:** PASS — both focused process journeys qualify the accepted exact-
WorkRevision gate. No RAI semantics or design owner files changed.

## Baseline and diagnosis

- Baseline: `275ea886d730eb5e59e19f99b833940ff1c6811a` (R3).
- The original Inbox-mismatch journey built a committed Deliver action directly
  into the initial multi-step Work execution. After restart, that fixture did
  not reliably re-enter the exact action before its safety boundary, so the
  journey timed out without exercising the intended P9 mismatch source.
- The P37 process suite already has a qualified receipt-first fixture that
  performs public `SteerWork`, creates the exact Work Execution, commits the
  Deliver effect, and pauses before Observation/Action completion. The RAI
  journey now reuses that path and binds assertions to the exact Work revision,
  Execution, LogicalAction, Message and receipt returned by the helper.
- The P37 child previously ignored its test-only
  `ARBOR_P37_MAX_NO_PROGRESS_TURNS` value and had no post-Settle commit pause.
  It now applies that value to the explicit test-child runtime safety policy
  and maps the existing AH12 post-commit seam to an exact-Work-revision
  `P37AfterSettlementCommit` probe. These are test-only hooks; production
  composition and the accepted RAI gate are unchanged.

## Evidence

Both cases in `tests/functional/process/rai-readmission-hold.functional.test.ts`
passed together with one zero-retry focused run:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/rai-readmission-hold.functional.test.ts
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    174.38s
```

The Inbox mismatch journey observed `PriorReceiptResultMismatch` for the same
committed LogicalAction and Message, committed the exact P9 fact/event, and
reached the matching P10 marker. It then verified RuntimeSafetyStop held the
same open Work revision across restart without another Execution or Provider
request. A public SteerWork advanced the revision and made the Work eligible
again; stale-revision Attention was no longer active.

The ordinary safety-only journey produced `Interrupted(RuntimeSafetyStop)` on
the exact Work revision with no P9 fact, verified the same-revision hold across
restart, then verified an authorized SteerWork advanced the revision and
released that hold.

Additional checks:

- `pnpm typecheck` — PASS.
- `pnpm exec biome check` on the three changed test/fixture files — PASS.
- `git diff --check` — PASS.
- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (existing bundle-size advisory only).

The full release functional suite was not run as part of this focused
qualification. No production code, migration, `docs/design/**`, or governance
semantics changed.
