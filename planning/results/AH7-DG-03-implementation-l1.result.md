# AH7-DG-03 implementation L1 result

Status: **L1 adapter/migration unit scope PASS; overall AH7-DG-03 remains open.**

This work is based on the accepted AH7-DG-03 contract landed at
`5cab270642f3a738f1da3dcb846ce734d477f8b2` and is confined to the independent
`ah7-approval-atomicity` worktree. It does not modify production effect ordering
in ToolRuntime, AgentLoop behavior, or P9 recovery qualification.

## RED → GREEN

The first focused run of the new migration/store tests was RED: P36 migration
registration and the new store operations did not exist. After adding the P36
schema/adapter and P4 ports, the focused SQLite run passed:

```text
pnpm exec vitest run \
  adapters/persistence-sqlite/test/p4-invocation-store.test.ts \
  adapters/persistence-sqlite/test/p4-approval.test.ts \
  adapters/persistence-sqlite/test/p4-ddl.test.ts \
  adapters/persistence-sqlite/test/p4-ah7-dg03-store.test.ts \
  adapters/persistence-sqlite/test/p36-ah7-tool-invocation-state-migration.test.ts
Test Files  5 passed (5)
Tests       10 passed (10)
```

`pnpm --filter @arbor/persistence-sqlite... build` passed. `git diff --check`
passed.

## L1 contract coverage

- P36 migration rebuilds `tool_invocations`, records `effect_admission_state`,
  and maps every prior invocation to `LegacyUnknown` because the old schema did
  not durably identify whether effect admission occurred.
- The store tests cover fenced intent recording, same-transaction approval
  claim plus intent with rollback on injected failure, losing claim behavior,
  no-effect Denied/Interrupted only while `NotAdmitted`, stop admission,
  current-generation admission, and stale-generation rejection.
- `LegacyUnknown` cannot be reclassified as no-effect or admitted for a new
  effect.
- Production migration wiring advances to P36. No effect handler ordering has
  yet been changed.

## Integration boundary and limitations

`pnpm --filter @arbor/single-workspace build` was run as a boundary check and
currently fails in the not-yet-implemented L2 caller integration:

- `packages/tool-runtime/src/runtime.ts:124`: existing Denied observation is
  missing the newly required typed `reasonCode`.
- `packages/tool-runtime/src/runtime.ts:795`: settlement observation mapping
  can produce `undefined` under the widened settlement union.

These are expected cross-layer compile errors, not a new design gap. No full
suite, real multi-process matrix, or push was run. Those remain gated on L2
unit/module and `@arbor/single-workspace` build passing.
