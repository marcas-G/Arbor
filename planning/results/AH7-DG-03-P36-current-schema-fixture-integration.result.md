# AH7-DG-03 P36 Current-Schema Fixture Integration

Date: 2026-10-11  
Base: `629b562df4ddd4e7ace10f0b9883cd349ee70d34`  
Integrated HEAD: `8efb0608e0c4be9bdef8f7284edd6714109aa350`

## Historical full-check record

The first full `pnpm check` on the 629b562 candidate recorded **1826 passed,
14 failed, 4 skipped**. This follow-up addresses only the three independently
reviewed test/fixture groups requested for P36; it does not erase or replace
that initial gate result and does not claim that full check is now green.

## Selective commits

| Group | Source commits → integration commits | Scope |
|---|---|---|
| A | `b7ea349` → `ce32cf9` | Update the two current-production schema assertions from 35 to 36. |
| B | `6586785` → `e1b8d02`; `218cbfd` → `57e95ae` | Migrate only current P9 ToolInvocationStore fixtures through P36 while retaining their historical P8/P12 starting schema; add the fixture-compatibility result. |
| C | `50a7156` → `8efb060` | Correct the P4 concurrent-intent helper expectation and migrate the P4 expiry fixture to the current P36 schema/source snapshot. |

No production source, migration definition, design document, or unrelated
historical baseline assertion changed in these groups.

## RED/GREEN and targeted evidence

For group A, a fresh worktree first failed to load package entrypoints because
`@arbor/agent-runtime` and `@arbor/application` build outputs were absent.
After `pnpm build` passed, the minimal two-file reproduction failed exactly
as expected: each test expected 35 and observed 36. After changing only those
two current-version assertions, the same selection passed:

```text
pnpm exec vitest run \
  apps/single-workspace/test/p34-attention-projection-daemon.test.ts \
  apps/single-workspace/test/p5-composition.test.ts
Test Files  2 passed (2)
Tests       2 passed (2)
```

The P9 migration group retains historical P8/P12 entry schemas and upgrades
to P36 before current ToolInvocationStore runtime reads/writes. It leaves the
P12 version-13 durability oracle, explicit P8/P12 migration-baseline tests,
and P16 Story D setup unchanged. Source-branch evidence is recorded in
`planning/results/AH7-DG03-P9-runtime-fixture-compatibility.result.md`.

The requested seven-file initial-failure group passed:

```text
pnpm exec vitest run \
  tests/p9-acceptance.test.ts \
  tests/p9-worker-crash.test.ts \
  tests/p9-tool-outcome-unknown.test.ts \
  adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts \
  adapters/persistence-sqlite/test/p4-tool-settlement-fence-expiry.test.ts \
  apps/single-workspace/test/p34-attention-projection-daemon.test.ts \
  apps/single-workspace/test/p5-composition.test.ts
Test Files  7 passed (7)
Tests       33 passed | 1 skipped (34)
```

The P4 store/runtime regression selection passed:

```text
pnpm exec vitest run \
  adapters/persistence-sqlite/test/p4-invocation-store.test.ts \
  adapters/persistence-sqlite/test/p4-ddl.test.ts \
  adapters/persistence-sqlite/test/p36-ah7-tool-invocation-state-migration.test.ts \
  adapters/persistence-sqlite/test/p4-ah7-concurrent-invocation.test.ts \
  packages/tool-runtime/test/p4-pipeline.test.ts
Test Files  5 passed (5)
Tests       20 passed (20)
```

P12 B7/B8 composition smoke passed separately:

```text
pnpm exec vitest run tests/p12-production-composition.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)
```

`pnpm typecheck` passed. Biome passed on 44 changed TypeScript/JavaScript
files, and `git diff --check` passed.

## Limits

No full `pnpm check`, full `pnpm test:functional`, or Playwright run was
started. These targeted counts are not a whole-repository gate. Historical
P8/P12/P16 schema starts were not globally rewritten. The tests establish
fixture compatibility only; they do not close AH7-DG-02, qualify a production
approved-Executable approval handoff, or close AH7 overall.
