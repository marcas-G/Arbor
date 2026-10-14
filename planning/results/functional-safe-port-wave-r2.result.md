# Functional test safe port handshake — Wave R2

Date: 2026-10-14

Base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`.

## Implementation

`ProductionFixture` now starts its primary and additional daemons with
`ARBOR_HTTP_PORT=0`. It accepts the port only after the child reports
`FUNCTIONAL_DAEMON_STARTED` and `FUNCTIONAL_DAEMON_LISTENING` with the same
UUID nonce, the spawned child PID, and an integral bound port. The fixture then
probes that reported port. The `freePort` reserve/close/rebind sequence was
removed. The old `isolatedPortHandshake` option is retained as a deprecated
source-compatibility flag; safe startup is the default for every fixture.

Restarts first await the prior child exit through `stopChild`, then request the
actual port reported by the first incarnation. Ordinary production entries
continue to use the nonce wrapper. Custom daemon entries must emit the same
handshake and fail closed if they do not; there is no legacy port-allocation
fallback.

Custom daemon reporters were added to the AH17, AH18, AH19, F21 and P4 child
entries. Existing AH crash, AH10 and P37 custom entries already used the shared
reporter. The checkout audit found 39 process test files with direct fixture
startup and all 6 UI specs use the fixture path; all therefore inherit the
safe default. All daemon child entries used by those fixture restart and
additional-daemon paths now report lifecycle identity. No production daemon
or `docs/design/**` file changed. No daemon child remains on an unsupported
serial-only path, so no serial-only manifest tag was needed.

## Focused evidence

- `pnpm typecheck`: PASS.
- `pnpm --filter @arbor/web build`: PASS (prerequisite for the fixture's HTTP
  readiness probe).
- `pnpm exec biome check` on the 8 changed source/test files: PASS.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/production-fixture-port-handshake.functional.test.ts --reporter=verbose`:
  PASS, 1 file / 5 tests. Coverage includes two concurrently starting fixtures
  with distinct child-reported ports and PID/nonce identities, restart reuse of
  the actual original port after the old PID exits, wrong PID, wrong nonce, and
  early child exit.
- `git diff --check`: PASS.

No full functional suite or `pnpm check` was run.
