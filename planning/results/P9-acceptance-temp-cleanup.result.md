# P9 acceptance SQLite temp cleanup

Status: **PASS**

`durableFile` now records only its own `mkdtemp` roots. Vitest `afterEach` and
`afterAll` close out those roots after success or failure; cleanup verifies
registration, realpath containment under system Temp, and the
`arbor-p9-accept-*` basename before removal. Cleanup errors are thrown and
retained so a later cleanup cannot hide an earlier failure. `runOn` now scopes
its Layer so SQLite finalizers close the database before directory removal;
P7 and P9 runners already use scoped execution.

Regression coverage exercises multiple roots, repeated cleanup, and an expected
throwing test body. A pure containment check receives a canonical Temp sandbox;
tests use a sibling candidate, prefix lookalikes, and a synthetic checkout
inside system Temp, so containment does not depend on where the actual checkout
lives. Rejected paths remain untouched.

## Evidence

- P9 acceptance: **11 passed, 1 expected failure** (the expected-failure case
  verifies `afterEach` cleanup after a thrown test body).
- Existing `arbor-p9-accept-*` Temp directories: **418 before and 418 after**;
  no new roots remained after the run.
- `pnpm typecheck`: PASS.
- Biome and `git diff --check`: PASS.

No full test suite was run.
