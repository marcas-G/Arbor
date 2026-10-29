# Functional port-zero nonce handshake — Wave C

Date: 2026-10-10

Base: `d377ef14d1eb8d8e9d39201003641ed7835a296a`.

## Migrated entrypoints

All fixture starts in these three default-gate files now opt into nonce-bound
port-zero readiness:

- `tests/functional/process/cross-work-wake.functional.test.ts`
- `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts`
- `tests/functional/process/command-input-validation.functional.test.ts`

Each was audited for `fixture.restart`, `startAdditionalDaemon`,
`firstDaemonEntry`, direct `spawn`, and post-start `baseUrl` references. They
have no restart, second daemon, custom entry, or direct child process. Clients
are created only after the fixture publishes its verified actual port. The two
other cases in command-input-validation now use the same opt-in handshake as
its Wave A malformed-MessageId case.

Also enabled the two previously reviewed pending fixtures, without changing
their assertions or moving them into the default gate:

- `tests/functional/pending/resource-admission.functional.test.ts`
- `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`

## Verification

- `pnpm typecheck`: PASS.
- Biome on the five changed test files: PASS.
- Single-case stage: cross-work-wake PASS, 1/1.
- Default-gate file stage: cross-work-wake + F23 tuple ordering + command
  validation PASS, 3 files / 6 tests.
- Parallel stage: three separate Vitest processes ran those same three files
  concurrently; cross-work-wake 1/1, F23 tuple ordering 2/2, command
  validation 3/3 (6/6 total).
- Separate pending diagnostics: resource-admission PASS, 1/1; F23 exact-tuple
  file PASS, 5/5. These remain on `vitest.pending-functional.config.ts` and are
  not included in default-gate or release qualification counts.
- No full functional suite or `pnpm check` was run.

The checked-in F21 resource-admission and F23 exact-tuple result/proposal files
contain earlier RED evidence. The tests no longer reproduce those recorded
failures on this integrated base: the raw-path rejection and all five exact-
tuple pending cases passed in this run. Those historical records are retained
unchanged here; this fixture migration neither reconciles their ownership nor
promotes pending tests, accepts governance, or closes F21/F23.

## Migration accounting

The original Wave A inventory counted 36 files calling
`startProductionFixture`. At this HEAD, six non-pending functional files are
fully port-zero/nonce opted in and two additional pending files are opted in
but excluded from default gates. Twenty-eight other fixture files remain on
the legacy free-port/readiness path. F20 clean-checkout and Playwright/browser
journeys remain serial.

## Restart/additional-daemon audit — design only

The only fixture files found with a no-argument `fixture.restart()` and no
custom first/additional entry are:

- `tests/functional/process/recovery-verdicts.functional.test.ts`
- `tests/functional/pending/f21-create-project-profile-process.functional.test.ts`

Both create a client before restart and reuse that URL afterward. The current
opt-in fixture semantics support this safely: the first bind chooses an OS
ephemeral port; restart rebinds that same per-fixture port so the client URL
does not change, while requiring a fresh child nonce/PID/listening report
before the readiness GET. `fixture.crash()` waits for old-child exit. If
another process takes that port during the gap, the restart cannot bind and
cannot emit a matching listening report; it fails closed rather than accepting
another service's response.

Other restart/second-daemon callers specify `ah-crash-child.mjs`,
`ah10-process-child.mjs`, AH17/AH18/AH19-specific entries, or related custom
startup options. The fixture currently rejects those in nonce mode. Before
they can opt in, each such runner must emit a start nonce and, after its own
successful listen, the same nonce/PID/actual port through the process-local
observer. Additional daemons must then receive their own port-zero bind report
and return the actual URL. This wave makes no custom-runner edits.
