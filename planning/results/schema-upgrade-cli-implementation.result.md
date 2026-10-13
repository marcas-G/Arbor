# Offline P39–P42 schema-upgrade CLI implementation

Date: 2026-10-13
Worktree base: `b3322b735996664d19cd2bf9643909bef6704bfb`
Accepted plan SHA-256: `7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`

## Implemented scope

- Added the explicit `schema:upgrade` operator command with `fresh`, `copy`,
  and `resume-copy` modes. `copy` uses Node SQLite's online backup API from a
  read-only source connection; source, target, P39 report, manifest, and writer
  lock aliases are checked using canonical paths and stable file identities.
- Added a protected JSONL provenance chain with a random 256-bit nonce,
  canonical hash-chained records, descriptor pins, deterministic typed logical
  SQLite digests, and exact `Prepared`/`Committed` resume reconciliation.
  `resume-copy` revalidates the original source prefix/digest, target digest,
  report schema/rows, manifest chain, file identities, and P39 isolation state.
- The P39 maintenance adapter can run its established preflight/migration gate
  under one acquired `MaintenanceExclusive` permit and retain that permit while
  0040–0042 execute. The P39 primary reservation still ends with its existing
  0037→0039 transaction; continuation failures and permit-release failures are
  surfaced.
- P39 preview qualification runs through the trusted P39 maintenance entry
  point on a private SQLite backup. Scratch databases/reports stay under the
  protected worktree test directory and are removed only by their owning
  routine. A P39 blocker report creates a terminal `Isolated` manifest record;
  subsequent resume is refused.
- No migration registry/runtime gate activation, live or retained database,
  deployment, release, or `docs/design/**` file was changed.

## Verification

- `pnpm --filter @arbor/single-workspace build` — PASS.
- Targeted Biome check of all changed TypeScript/package files — PASS.
- `git diff --check` — PASS.
- `pnpm vitest run apps/single-workspace/test/schema-upgrade-cli.test.ts` —
  PASS, 1 file / 5 tests. Coverage includes explicit mode validation, typed
  digest behavior, backup plus P40 commit-before-manifest fault recovery and
  version-42 no-op, P39 permanent blocker isolation, and hard-link/junction
  aliases. All databases used by the tests were newly created disposable
  fixtures under the worktree.

The Vitest run used the reviewed invocation-wide protected Windows TEMP and
PowerShell module-path setup from `cafa95e91a1c2c85bd8047fa685207c9c310219d`
and `fa04f315f9761c500d770e28dc3af9c5497b8d74`; no ACL check was bypassed.
The full repository `pnpm check` and functional suite were not run in this
subtask.
