# Sandbox Policy Candidate Read Model V5-B — P2 Integration Review

**Date:** 2026-10-19

**Integration base:** unified candidate `0ce5194b`.

**Integrated commits:** V6 owner landing `24307d68` as `002f1681`; P2 gate `0b20a6ec`, `3783a70d`, and `1ab6e445` as `8638e775`, `4dfe0743`, and `3c9019a2`.

**Independent review:** `/root/native_sandbox_wave_d_review` reviewed cumulative P2 source HEAD `1ab6e445` read-only and reported B0 = 0, B1 = 0, B2 = 0. This is a P2 scope review; it is not a V5 or V6 implementation completion review. No separate reviewer artifact hash was supplied.

## Reviewed P2 behavior

- With a verified current V2 authority bundle and exact joined P1 decision/result, an unexpired TrustedLocal or OsEnforced policy with the matching full bundle proceeds once.
- A full bundle revision/digest change, including registry-only drift, parks both variants before lease acquisition, worker dispatch, and driver invocation. The Pending P3 action and NotAdmitted P4 invocation remain intact.
- When no exact pending sandbox policy requirement exists, P2 does not read or audit the P5 authority source.
- P4 remains the final effect-admission recheck. The review does not qualify a dual-daemon restart or complete the other V5 slices.

The V6 owner landing relocates the candidate handle-binding digest to each candidate at the design layer. This integration does not change the V5-A DTO or implement the V6 candidate query/selection mapping.

## Integrated verification

- `pnpm build`: PASS.
- `pnpm typecheck`: PASS after constraining test fixture IDs, principals, digest and literal mounts to their contract types. The first integrated typecheck exposed the widened test-only literals; no production code changed in this repair.
- `pnpm exec vitest run tests/p2-driver.test.ts`: PASS, 13/13.
- V5-A four focused suites: PASS, 45/45.
- `pnpm lint` (Biome, 1,306 files): PASS after test import ordering repair; no fixes applied by Biome.
- `git diff --check`: PASS for both the integrated commit range and final working changes.

No schema, migration, database upgrade, provider qualification, release, or V6 code implementation is claimed.
