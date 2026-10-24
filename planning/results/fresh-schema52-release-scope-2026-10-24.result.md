# Fresh schema-52 first-release scope — 2026-10-24

Tested source: `eece5de33dfed3af631ab4da10d45e3a74fff1f2`.

Status: **PASS for a fresh-database-only first release. Preserved user database
upgrade remains unsupported.**

The runtime and readiness gate require exact schema 52 and fail closed for
schemas 38–51 and newer schema 53. The operator guide now directs first-release
users to `schema-upgrade --mode fresh` and explicitly restricts `copy` /
`resume-copy` to disposable development qualification fixtures. Normal daemon
startup never upgrades a database.

Verification, serial and zero retry:

- `p38-runtime-schema-boundary.test.ts`: **33/33 PASS** in 179.68 seconds,
  including exact schema-52 readiness/startup and rejection of non-current
  prefixes.
- `schema-upgrade-operator.test.ts -t "creates a P52 fresh target without
  accepting a source"`: **1/1 PASS** in 197.83 seconds.
- Schema-upgrade CLI argument selection: **1/1 PASS**; the other 24 cases were
  explicitly skipped by the name filter.

No existing, live, online, preserved or user database was opened, copied or
upgraded. This result chooses the conservative first-release scope allowed by
the RC condition: fresh schema 52 only. Supporting preserved-database upgrades
later requires separate authorization, backup/restore qualification and a new
release claim.
