# P39–P42 schema activation plan hardening

Date: 2026-10-13  
Base: `80ba7d1208b03164aa24c6e5eec87e64b6b73f92`  
Scope: documentation only; no design documents or production code changed.

The implementation-closure plan now makes the accepted P39–P42 design
operationally explicit while retaining the separate implementation
authorization boundary. It adds explicit `fresh`, `copy`, and `resume-copy`
modes; read-only source and SQLite backup requirements; canonical-path and file
identity alias rejection; no-replacement behavior; one maintenance-exclusive
permit held continuously over P39 and 0040–0042; generic migration-runner
refusal of descriptor 39; and exact, hash-pinned committed-prefix validation
for same-copy continuation. Intra-step, tampered, or unverifiable states fail
closed.

The plan also assigns one standard schema-42 test fixture, enumerates the
bounded implementation and qualification files, and requires evidence for the
42 startup no-op and refusal at versions 38–41. It states that any actual
semantic conflict must be raised as a Design Gap rather than resolved in the
implementation plan.

Updated plan SHA-256:
`C6B97468871FFD9B68EA351FAD8A3F166622AD4E75DBCC35EC4D7432328D3E8B`

## Verification

- `git diff --check`: PASS.
- No tests or builds were run, as requested for this documentation-only change.
- No migration registration/activation, database operation, daemon startup,
  deployment, or release action was performed.
- Implementation remains separately gated by the authorization recorded in
  the plan; this document change does not grant that authorization.
