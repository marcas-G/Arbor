# AH10 direct-child P32 historical fixture qualification

Date: 2026-10-23

The `legacy-p32-upgrade` direct-child AssignWork case builds the historical
image from the populated current-schema fixture without changing production
migrations or editing `user_version` backwards. A dedicated disposable schema
44 database is first created through the trusted migration chain. A test-only
schema-51→44 projection uses the actual frozen v44 destination columns, carries
the required parent rows and the exact committed AssignWork command/receipt and
binding, and handles P45 inbox shape, P46 verification snapshots, and P49 grant
provenance explicitly. The projection is transactional and checks the exact
receipt/binding plus foreign-key and integrity constraints. The existing
`copySchema44RowsIntoP38Seed` still accepts only source version 44 and a P38
target; it was not relaxed.

The projected v44 image seeds the real P38→P39→P42 schema-42 builder. The test
checks the exact committed receipt and binding in schema 42 before the accepted
schema-42→P32 image builder creates the historical image. The P32 image is
checked at `user_version=32`, retains the committed receipt, has no
`assign_work_target_bindings` table, and matches a pristine P32 schema
snapshot.

The P32 image is then upgraded to schema 44. Before continuing, the case
asserts the v44 boundary, exact committed receipt/result preservation, absence
of a fabricated AssignWork binding, seven-column pre-P45 Inbox shape,
pre-P46 verification shape, and both P44 observation guard triggers including
`ApprovalRejected`. It then calls the strict
`upgradeSchema44ToCurrentTestDatabase` helper, which only accepts source 44,
applies the existing P45/P46/P47/P48/P49+50/P51 offline suffix in order, and
finishes at schema 51 with foreign-key, P51 activation-highwater, and WAL
checkpoint checks. P45 uses the production `backfillRetryVerificationOrigins`
implementation inside the migration transaction. The ordinary daemon is
started only after schema 51 is verified; the exact receipt remains committed
and the historical binding remains absent.

The schema-51 fixture builder also calls the same 44→current helper, keeping
the ordinary current-schema fixture path aligned with this legacy upgrade
path. Temporary v44/v42 databases and their P39 report/lock files live in a
random private direct child of the repository, outside system temp. Before
P39, the test records and checks the actual primary, report, lock, and journal
paths, confirms the root is non-reparse and protected, and requires every path
to remain inside that root and at most 240 characters. The run measured the
longest path (P39 lock journal) at 202 characters.

## Verification

- Exact `legacy-p32-upgrade` process case — **1/1 passed** after the final P51
  highwater digest assertion.
- `schema42-database-fixture.test.ts` and `schema44-database-fixture.test.ts` —
  **6/6 passed**.
- Entire `agent-loop-ah10-direct-child-assign-work-receipt-binding` functional
  file — **15/15 passed**.
- Biome on all five changed code files — **PASS**.
- `pnpm typecheck` — **PASS**.
- `git diff --check` — **PASS**.
- `tests/architecture/schema-upgrade-test-layering.test.ts` — **1/1 passed**.

No production migration or frozen design document changed. These scoped tests
do not close the broader AH10 takeover matrix.
