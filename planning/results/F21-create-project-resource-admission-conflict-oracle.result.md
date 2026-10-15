# F21 CreateProject Resource-Admission Conflict Oracle — Follow-up

状态：**F21 resource-admission focused cases pass; no production or design semantics changed**

## Diagnosis

Input log: `.test-results/check-c732bb2d-20261016-063025.log`, candidate
`c732bb2d2dd74593c6b6d31f1fafeb2b9aefa4fe`. The two F21 assertions expected
HTTP 409 Problem objects, while the actual public response was HTTP 200. Both
were stale test oracles, not production resource-admission regressions:

1. After a forged Profile selection is terminally recorded as
   `ProjectResourceUnavailable`, a different/repaired payload reusing the
   same CommandId changes the semantic tuple. Gateway's existing tuple
   mismatch is `TerminalRejected(IdempotencyConflict)`, and the external
   `receiptToView` intentionally serializes that as the existing HTTP 200
   TerminalRejected receipt view. It is not a transport Problem.
2. A current v2 CreateProject candidate reusing a CommandId with a seeded v1
   receipt likewise takes the P1 schema/fingerprint tuple-mismatch branch.
   P1 `01` §3 and DID §4.1C specify non-disclosing
   `TerminalRejected(IdempotencyConflict)` through the existing receipt view;
   no old v1 decoder is used. The prior 409 Problem expectation contradicted
   that frozen receipt contract.

The test now asserts the exact public shape
`{ok:true,status:200,body:{commandId,resolution:"TerminalRejected",
rejection:"IdempotencyConflict"}}`. Existing security and mutation checks
remain: unavailable/forged/stale requests still produce the original typed
terminal receipt; profile resolution remains at three calls; repaired same-ID
selection does not change receipt count; legacy raw v1 remains HTTP 400 before
Gateway; the v2 collision leaves the v1 receipt byte-equivalent, performs no
profile resolution, and does not reflect the historical address.

## Verification

```text
pnpm exec vitest run tests/f21-create-project-resource-admission.test.ts
pnpm exec vitest run tests/p1-create-project.test.ts apps/single-workspace/test/external-command-codec-registry.test.ts apps/single-workspace/test/project-resource-profile-catalog.test.ts packages/application/test/external-command-codec.test.ts adapters/persistence-sqlite/test/p42-project-resource-source-migration.test.ts adapters/persistence-sqlite/test/schema42-database-fixture.test.ts
pnpm typecheck
pnpm exec biome check tests/f21-create-project-resource-admission.test.ts
git diff --check
```

Results: F21 file **5/5 PASS**; related **6 files / 51 tests PASS**; typecheck
PASS; Biome PASS; diff check PASS. The supplied full `pnpm check` log also
contains a separate Node/Vitest heap OOM and worker exit in
`tests/p9-acceptance.test.ts`; the full suite was not rerun, per task scope.
No `docs/design/**`, production code, migration, or schema behavior changed.
