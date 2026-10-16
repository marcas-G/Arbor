# P43/P44 schema activation and qualification

Date: 2026-10-16

Qualification start HEAD: `46f8ce00482df01dac3aeb3b4be7b1f605dc3e65`.
Accepted proposal raw SHA-256:
`C6FEFB7FEEF60B02BA9E0B9D3461F4CC3415CB35356C580F6794F9A595FCA6ED`.

The accepted activation package was implemented in the ordered current schema
prefix: P43 42→43 followed by P44 43→44. The current schema/readiness target is
44. P39 remains the separate privileged maintenance step. The offline upgrade
CLI now pins both descriptors, records and resumes each prefix through 44,
checks P43/P44 contracts, and closes/reopens schema-44 targets read-only before
successful return. Current-runtime and functional fixtures now use schema 44;
schema-42 fixtures remain available for historical migration qualification.
P44 changes only the two P40 observation guards by allowing the frozen
`ApprovalRejected` no-effect denial reason.

## Evidence

- Layered persistence, schema-44 fixture, P43 store, current migration registry,
  runtime boundary, and architecture batch: **5 files / 27 tests PASS**.
- Offline schema upgrade operator suite: **1 file / 10 tests PASS**. This
  includes fresh and copy completion, prepared/committed interruption and
  resume across migrations 40–44, exact manifest-prefix checks, competing
  resume, and version-44 closed read-only no-op verification. Duration:
  1,236.90 seconds.
- Public P38 executable-approval Reject and Expire paths on the schema-44
  functional fixture: **2 tests PASS** (4 unrelated tests skipped by the test
  filter). Both resumed the original action, persisted `Denied` with the
  expected `ApprovalRejected` / `ApprovalExpired` reason, and admitted no shell
  effect.
- `pnpm typecheck` — PASS.
- Biome on 61 changed TypeScript files — PASS.
- `git diff --check` — PASS.

All SQLite qualification used test-owned disposable databases. No online or
preserved database was opened or upgraded; no deployment or release upgrade
was performed. The full functional suite was not run.
