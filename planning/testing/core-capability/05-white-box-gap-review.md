# White-Box Gap Review

**Audit date:** 2026-09-27

This review does not add unit tests merely to increase a count. It records
where targeted mechanical coverage is valuable and where existing suites
already provide strong evidence.

## Existing strong areas

- Domain transitions and ADT validation have broad table-driven and negative
  coverage under `packages/domain/test/**`.
- Tool authority/admission, P1 idempotency, P6 governance/steer, P7 matcher,
  P8 verification lifecycle, and P9 recovery/fencing each have meaningful
  negative assertions.
- Architecture tests cover package boundaries and phase-specific source
  constraints.
- SQLite adapters have dedicated migration, repository, lease, command, and
  recovery tests.

These are component/integration evidence. They do not close the missing L3
capability cases.

## Gaps to review in the next test-maintenance pass

1. **Evidence metadata:** Existing tests have no explicit L1/L2/L3 or
   provider-mode label. Add a per-test annotation/catalog and fail audit
   generation when a test is unclassified; do not infer capability status
   from file path alone.
2. **Invalid input and exhaustive routing:** During annotation, locate critical
   codec invalid-input cases and exhaustive ADT routing branches that lack
   table-driven negatives. Keep additions scoped to frozen contracts.
3. **Schema/runtime drift:** Add or retain contract checks only where they
   compare a concrete schema/projection against its actual runtime consumer.
   Prompt-name/hash checks do not establish runtime activation.
4. **Fail-closed authority and idempotency:** Current coverage is substantial.
   Do not duplicate it; identify actual untested branches while assigning
   evidence tags.
5. **Provider-mode clarity:** Test descriptions/files called “real-provider”
   must identify which individual tests use a real endpoint and which use
   recording fetches.
6. **Failure report retention:** Preserve the first failed test report with
   case name, file, provider mode, environment, and exact assertion. The
   current run's aggregate says two failed suites but exposes only one failed
   assertion in the captured detail.

No white-box gap review authorizes implementation changes. If the gap review
finds a contract ambiguity, stop and raise it for manual governance.
