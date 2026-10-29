# P40 release-base integration result

## Scope and boundary

Semantically ported the accepted final P40 snapshot `52632fbb` onto the
integration tree, preserving the already integrated P39 authenticated
RecoveryBinding path, Blocked P3/P6 behavior, P8 retry verification, and F21
Project Resource Source contracts. The only direct merge conflict was the
`consumeApproved` test-fixture parameter type in `p4-pipeline.test.ts`; the
integration keeps the current P39 required-method service signature. Other
P3/P9/P10 runtime, storage, and migration hunks applied cleanly.

P40 consumes only P39's typed authenticated `findSelected` evidence. Its
standalone migration descriptor and store/codec are exported but
`CURRENT_MIGRATIONS` remains `P38_MIGRATIONS`; no P40 descriptor was added to a
current or production migration list. P40 tests exercised only test-owned
temporary SQLite fixtures. No user/preserved DB, daemon, full functional
suite, deployment, or live environment was touched.

The P40 implementation plan and the pending, unexecuted functional-test source
and helper were excluded from the port. The accepted P3/P9/P10 production
qualification result was retained. Four non-P40 domain-event tests were
excluded by name from the combined P40 71-test target; the complete domain
event catalog file was separately run after updating its expected set to
include the two already-integrated P6 WorkBlocker events.

## Verification

- P40 combined targeted suite: 12 files, 71 passed; `P40 P4 persistent
  observation admission gates` passed 8/8.
- `packages/domain/test/events.test.ts`: 5/5 passed, including the exact event
  catalog with P6 Blocker and P40 replay-evidence events.
- `pnpm typecheck` — passed.
- Biome on all 41 changed TypeScript/TSX files — passed.
- `CURRENT_MIGRATIONS = P38_MIGRATIONS`; P40 remains unregistered.
- No full `pnpm check`, functional, P41 implementation, daemon, or existing-DB
  migration was run.
