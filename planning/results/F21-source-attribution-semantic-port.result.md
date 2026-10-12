# F21 Project Resource Source Attribution Port

Status: implementation slice complete; awaiting independent B0 review.

Base: `ce58e0ceac7c0b0e0f48a586c0bcd70c01ce1cd4`.
Accepted package: `B50C8251D77981B2A57A4E3A15741D2024C1FEF97D8151534DB38F0DA1BB49C0`;
combined governance baseline DID v1.44.

## Landed scope

- Added the Project-owned `ProjectResourceSource` union, strict exact-shape
  decoder, and new-write type excluding `LegacyUnknown`.
- `CreateProject` v2 records the exact selected Profile ref/version or
  `ConversationOnly` atomically with Project creation.
- Project repository reads reject malformed or noncanonical stored source as
  `PersistenceCorruption`; ProjectDirectory returns the decoded source through
  its port, HTTP response, and Web DTO.
- Added standalone migration descriptor 0042. Its `requiresUserVersion: 41`
  precondition is enforced by the runner; historical rows receive only
  `LegacyUnknown`.
- Updated test-local P1/P6/P7 project seed schema, repository/Directory tests,
  and transport DTO coverage. The current CreateProject result decoder remains
  schema v2; the existing preserve-only v1 receipt test passes.

No files under `docs/design/**` changed. `CURRENT_MIGRATIONS` remains P38;
0042 is not registered. Migration behavior was exercised only against isolated
in-memory SQLite fixtures with explicit user versions 38–41, never a live or
preserved database.

## Verification

- `pnpm build` — PASS.
- Biome on all changed source/test files — PASS.
- Focused SQLite/domain/API/P1/P6/P7 tests — 9 files, 51/51 PASS.
- Preserve-only CreateProject v1 receipt test — 1/1 PASS.
- `pnpm typecheck` is blocked by pre-existing integration-base test typing
  errors (P39 migration test, existing implicit-any test callbacks, and
  unrelated RetryVerification/P10/P12 fixtures); this slice introduced no
  additional type errors in the build or listed diagnostics.

This result does not claim full F21, FT-DG-01, full functional, daemon, release,
or live-database qualification.
