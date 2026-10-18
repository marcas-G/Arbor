# Native OS Sandbox T1 — storage and migration vertical slice

**Baseline:** `8cd0a94653f1278a194cf23e63503bf154885373`
**Authorization:** `AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION`
**Scope:** persistence migrations, offline schema-upgrade descriptor/prefix
validation, storage/upgrade qualification, and this result record. No
`docs/design/**`, domain commands, runtime sandbox/provider, live database,
deployment or release changes.

## Delivered

- Registered offline-only migration 0049 (`requiresUserVersion=48`) and 0050
  (`requiresUserVersion=49`); `CURRENT_SCHEMA_VERSION` and migration baseline
  are now 50.
- 0049 fails closed on every NULL grant revision except an already Revoked
  P29-unbound row, which alone is normalized to revision 0. It creates the
  immutable grant-issuer provenance and immutable, committed-only
  `sandbox_policy_decisions` relations without historical provenance or
  decision backfill.
- 0050 adds the immutable unavailable fact, retained attention queue and
  disposable marker with the accepted composite FKs, checks, indexes and
  triggers. It adds no event FK, cascade or historical fact/queue backfill.
- The offline upgrader now previews, commits and records versions 49 and 50,
  accepts only canonical schema-48/49/50 input prefixes, checks 0049/0050
  foreign keys before transaction commit, and verifies the exact schema-50
  read-only no-op head. The P39 maintenance adapter now recognizes 50 as its
  final continuation boundary.
- P43/0043 and P44/0044 remain inherited registered prefix migrations. Their
  exact schema state is part of the pinned schema-48 and schema-49 signatures;
  neither is duplicated or altered.

## Fixed signatures

| Descriptor | SQL SHA-256 | Accepted descriptor fingerprint | Canonical schema signature after migration |
|---|---|---|---|
| 0049 / `requiresUserVersion=48` | `b8145e3a49f1de191544bd2598eea250910f2d54f9f56e497dd9e49e03cf22dc` | `2d5860493f471c226cafc54b7b6b4e75adaad1ff5ca3f19713ef106e5512c80f` | `83995e8b4d1d124c1dab226ba4e96f94a73fbaedbaf6a84deefc5ca1f353c531` |
| 0050 / `requiresUserVersion=49` | `9f1bd851506ca468098c56f2efd6db3b277f443f1ed65ea910b3370db45bdf98` | `3a4c8ed3e75b3017869ebfc67b60320bb56639719ba48810f09792eadc12426e` | `e196df9930f33dda47420f0ed3105711220dd7044fda5195742f70c2aad9da2c` |

The pinned schema-48 signature is
`f4333689c6f854362a985bd95153e9141f9c6ed443289a224185fe0a30e95a50`.
Descriptor fingerprints use the accepted LF UTF-8 lines
`predecessorVersion\nname\nnormalizedSqlSha256`, with no trailing LF.

## Qualification

All databases used for migration and offline-upgrade tests were disposable
fixtures.

- `pnpm build` — PASS.
- `pnpm typecheck` — PASS, including test TypeScript.
- Changed-file Biome check — PASS (16 files).
- `native-os-sandbox-storage-migration.test.ts` — 5/5 PASS: exact 48→49→50
  registration, fingerprint derivation, allowed revision normalization,
  fail-closed NULL cases with transactional rollback, exact relation columns,
  empty ledgers, foreign-key check and immutable/retained triggers.
- `schema-upgrade-operator.test.ts` focused cases — 11/11 PASS: fresh target
  to 50; exact 48→50; unexpected schema, missing P43 table and changed P44
  trigger rejection; invalid NULL revision refusal before persistent writes;
  altered 0049 signature rejection before 0050; 0049 pre-commit rollback and
  post-commit recovery; exact schema-50 copy/no-op; and schema-47→50 plus
  resume/no-op.
- `p38-runtime-schema-boundary.test.ts` focused cases — 5/5 PASS: startup
  admits schema 50, a real `--once` daemon binds Web from the schema-50 fixture,
  schema 51 is refused, readiness requires exactly 50, and registry/baseline
  ends at 50.
- `p39-claim-atomicity.test.ts` — 2/2 PASS; architecture
  `mac-p4-convergence.test.ts` — 3/3 PASS.

An initial fresh-target run exposed that the P39 maintenance adapter still
treated 48 as the terminal continuation version, skipping the final no-op
verification callback. The adapter was advanced to 50; the fresh-target and
read-only verification case then passed.

This closes only the T1 storage/migration slice. Writing the new policy,
provenance and unavailable-fact rows remains for the separately assigned
domain-command/runtime/provider work; no repository write API or runtime
semantics were invented here.
