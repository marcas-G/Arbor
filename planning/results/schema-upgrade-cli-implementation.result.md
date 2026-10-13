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
- Resume manifest validation/reconciliation now occurs only after that exact
  cross-process permit is acquired. All provenance appends—including prepared,
  committed, and terminal isolation records—remain under the permit, so two
  resume processes cannot append from the same stale manifest head.
- Manifest append retries short writes until complete, fails closed on
  zero/invalid progress, and fsyncs only after the full envelope is written.
  The opened descriptor is rechecked against the manifest's device/file ID and
  single-link identity before append.
- P39 writer-lock `busyTimeout` is configured in `SqliteClient.layer` so it is
  active immediately after `DatabaseSync` opens and before the first journal or
  schema query. Runtime callers retain the 30-second default; the offline CLI
  uses a named 20-minute bounded wait. A competing writer still fails closed
  after that bound.
- Structured P39 failures are mapped to safe schema-upgrade refusals carrying
  an enumerated maintenance phase plus bounded P39 code/reason code. CLI output
  filters absolute paths and secrets and omits arbitrary SQL/database error
  text. Test-only phase hooks identify report path/ACL/alias/identity/profile,
  writer-lock, manifest, P39 reservation, and P40–P42 continuation stages.
- P39 preview qualification runs through the trusted P39 maintenance entry
  point on a private SQLite backup. Scratch databases/reports stay under the
  protected worktree test directory and are removed only by their owning
  routine. A P39 blocker report creates a terminal `Isolated` manifest record;
  subsequent resume is refused.
- No migration registry/runtime gate activation, live or retained database,
  deployment, release, or `docs/design/**` file was changed.

## Verification

- `pnpm --filter @arbor/single-workspace build` — PASS.
- Manifest short-write/zero-write focused test — PASS, 1/1.
- Structured CLI failure rendering/filtering focused test — PASS, 1/1.
- P39 writer-lock initialization contention adapter test — PASS, 1/1. A
  separate Node process holds an exclusive lock for 16 seconds; a competing
  writer layer configured for 20 seconds waits and acquires after release.
- Cross-process CLI resume race test — PASS, 1/1. It creates a disposable
  copy, truncates only that test-owned manifest to a valid P42 `Prepared`
  prefix representing DB-commit-before-manifest-ack, verifies a standalone
  external CLI resume baseline, restores that exact valid prefix, and starts
  two independent CLI processes. Both exit 0, the target remains at 42, and
  exactly one P42 `Committed` envelope is appended.
- `git diff --check` — PASS.
- The expanded complete CLI test file and full repository `pnpm check` were
  not rerun after the final B1/race changes; earlier extended-file attempts
  exposed and then fixed the Windows writer-lock initialization timeout. Do
  not count those earlier failed attempts as qualification.

The Vitest run used the reviewed invocation-wide protected Windows TEMP and
PowerShell module-path setup from `cafa95e91a1c2c85bd8047fa685207c9c310219d`
and `fa04f315f9761c500d770e28dc3af9c5497b8d74`; no ACL check was bypassed.
All databases were newly created temporary fixtures under the worktree. No
online/retained database or deployment was accessed. The functional suite and
full repository `pnpm check` were not run in this subtask.
