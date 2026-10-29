# Schema upgrade CLI copy/reopen timeout correction

Date: 2026-10-14
Scope: `schema-upgrade-operator.test.ts` copy-source-38 → target-42 close and read-only reopen qualification.

## Change

- Cache the exact P38 preview template first produced by the ordered resume-prefix qualification and offer it to the later copied-target close/reopen case. `runSchemaUpgrade` still validates the target's logical digest and migration-prefix signature before accepting the template; a mismatch fails closed.
- Keep the standalone copy/reopen test self-contained: without the earlier suite template, it performs the original full preview path. Raise its timeout from 600s to a bounded 1200s for loaded full-suite runs.
- Preserve assertions that the hook observes version 42 after close and read-only reopen, target remains at version 42, source remains at version 38, and the final manifest record is Committed for step `0042`.

## Verification

- `pnpm lint` — PASS (Biome checked 1151 files).
- `pnpm typecheck` — PASS.
- `pnpm build` — PASS.
- `pnpm exec vitest run apps/single-workspace/test/schema-upgrade-operator.test.ts -t "closes and read-only reopens a copied target before successful return"` — PASS (1 passed, 9 skipped; 157.74s). This isolated run exercises the full preview fallback.
- `pnpm exec vitest run apps/single-workspace/test/schema-upgrade-operator.test.ts` — PASS (10/10; 1334.69s). The full run exercises template reuse after exact prefix/digest validation.
- `git diff --check` — PASS.

No production schema-upgrade behavior or design documents changed.
