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
- A resume that requires an existing P39 report now uses only the existing-file
  validator; it cannot initialize or replace a deleted report. The report's
  bound file identity and evidence are rechecked under the same exclusive
  permit as manifest reconciliation. Deletion and valid-database replacement
  between preflight and permit acquisition are both refused.
- Version-42 resume holds the exclusive permit while explicitly closing the
  migration connection, reopening the target read-only, and checking version,
  foreign keys, required schema, row invariants, logical digest, provenance
  head, and report identity. This proves the no-op path from a fresh connection.
- Fresh/copy migrations that reach version 42 during the same successful CLI
  call now take that identical close/reopen verifier before releasing the
  permit or returning. The verifier test hook carries `{ userVersion: 42,
  reopenedReadOnly: true }` evidence only after the read-only reopen and checks
  complete, and focused fresh and copied-source regressions assert the evidence.
- Error rendering now removes Windows drive/UNC and Unix absolute-path
  remainder text, including paths with spaces; regression assertions confirm
  that neither path nor trailing fragments are rendered.
- P39 Windows owner/ACL/local-filesystem PowerShell probes share a named
  30-second timeout and remain fail-closed on timeout. The injected probe test
  proves a simulated six-second success is accepted and a 30-second timeout is
  rejected. This is committed separately as `251ef294` for cross-branch reuse.
- P39 preview qualification runs through the trusted P39 maintenance entry
  point on a private SQLite backup. Scratch databases/reports stay under the
  protected worktree test directory and are removed only by their owning
  routine. A P39 blocker report creates a terminal `Isolated` manifest record;
  subsequent resume is refused.
- No migration registry/runtime gate activation, live or retained database,
  deployment, release, or `docs/design/**` file was changed.

## Verification

- `pnpm --filter @arbor/single-workspace build` — PASS.
- P39 Windows security timeout injection test — PASS, 2/2 (6-second success;
  30-second timeout refused).
- Manifest short-write/zero-write focused test — PASS, 1/1.
- Structured CLI failure rendering/filtering focused test — PASS, 1/1,
  including Windows/Unix paths containing spaces.
- P39 report delete/replace TOCTOU, exact-prefix resume, and explicit
  version-42 close/reopen read-only no-op qualification — PASS, 1/1 extended
  test (`resumes exact prefixes`, 1163.18 seconds; 8 other tests filtered).
- Same-call version-42 close/reopen verification — PASS for fresh (1/1,
  145.70 seconds) and copy from a disposable version-38 source (1/1,
  211.56 seconds); both assert the read-only reopen evidence, and copy also
  verifies the source remains at version 38.
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
  not run after these final-review fixes; the targeted extended-prefix run and
  the staged adapter/build checks above are the evidence for this increment.
  An earlier tampered-version fixture changes `user_version` to 41 without
  changing the version-42 schema; SQLite then reports a duplicate
  `resource_source_json` column during replay, which is accepted only as
  fail-closed evidence that the manifest/database version binding is invalid.

The Vitest run used the reviewed invocation-wide protected Windows TEMP and
PowerShell module-path setup from `cafa95e91a1c2c85bd8047fa685207c9c310219d`
and `fa04f315f9761c500d770e28dc3af9c5497b8d74`; no ACL check was bypassed.
All databases were newly created temporary fixtures under the worktree. No
online/retained database or deployment was accessed. The functional suite and
full repository `pnpm check` were not run in this subtask.

## Qualification timeout follow-up (2026-10-14)

The 20-minute exact-prefix test was changed to reuse one immutable offline
preview template across its before/after and provenance-resume calls. The test
hook accepts the template only after checking the live target's version and
logical digest; versions 39–42 also require the exact prepared schema-prefix
signature. The normal CLI path still computes its own preview. The test timeout
is bounded at 30 minutes.

- `pnpm exec biome check apps/single-workspace/src/schema-upgrade.ts apps/single-workspace/test/schema-upgrade-operator.test.ts` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm build` — PASS.
- Focused `resumes exact prefixes` qualification — PASS, 1/1 in 804.77 seconds
  (13m 24s). The earlier 1,163.18-second focused result is reduced by 358.41
  seconds (31%). During development, one run exposed and fixed a stale
  source-digest assumption in the template path; the subsequent completed
  focused run passed.
- Full `schema-upgrade-operator.test.ts` — PASS, 10/10 in 1,250.75 seconds
  (20m 51s). This includes the exact-prefix case and the independent CLI race,
  fresh/copy reopen, isolation, and path-alias cases.
- Final process and fixture audit found no remaining CLI/Vitest process or
  `.schema-upgrade-*` temporary directory. Full repository `pnpm check` was not
  run for this test-focused change.
