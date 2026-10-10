# Functional port-zero nonce handshake — Wave F

Date: 2026-10-10

Base: `1f7cf13b453afb928d0a752611dc53d5596066ba`.

## AH10 custom-runner integration

`tests/functional/support/ah10-process-child.mjs` now uses the existing
test-only `createFunctionalDaemonListenReporter`. Every AH10 role process
emits its own STARTED nonce/PID and reports the actual bound port after its
own successful `listen`. It also constructs the same host
ProjectResourceProfile Port from `ARBOR_PROJECT_ROOT` as the production
entrypoint, needed by profile-backed test setup.

In nonce mode, `ProductionFixture` now permits custom `firstDaemonEntry`,
restart `entry`, and `startAdditionalDaemon` entries. It does not trust entry
names: every custom child must pass the same PID/nonce/actual-port handshake or
the fixture fails closed. Additional daemons request port zero; the fixture
returns the port and base URL from that exact child's matched listening
report. Main-daemon restarts rebind the fixture's initial port to preserve
existing clients. No public HTTP route, test nonce in production config, or
production semantic change was added.

Migrated the `ah10-process-child.mjs` consumer group:

- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts`
- pending `tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`

The direct-child AssignWork takeover case adds explicit assertions that the
primary standard daemon and custom restart share the same actual URL port,
while the additional AH10 role uses its own distinct reported port/URL. All
three processes must have distinct PID/nonce identities and each listener
report must match its own start report.

## Focused qualification

Three independent Vitest processes ran concurrently after the host-profile
Port correction:

- direct-child AssignWork `before` case: PASS, 1/1;
- SelectCurrentWork `before` case: PASS, 1/1;
- SendMessage Query `before` case: PASS, 1/1.

The direct-child AssignWork file had also passed both before/after cases
(2/2) before the host-profile Port correction. After that correction, its
`before` case was rerun successfully; this result does not claim a post-fix
2/2 whole-file run.

`pnpm typecheck`: PASS. Biome on the nine changed source/test files: PASS.
No complete functional suite or `pnpm check` was run.

## Pending AH10 diagnostic

The filtered `workspace` case in pending
`ah10-submitted-decision-binding-integrity.functional.test.ts` did not reach
its additional-daemon step. After the host Profile catalog became available,
fixture setup failed at the test's public `CreateChildWorkspace` call with
HTTP 403 `authority/denied` / `UnsupportedOrigin:CreateChildWorkspace`.
This is not a nonce handshake failure and is not the expected orphan-state
assertion in the older
`planning/results/AH10-submitted-decision-binding-integrity.result.md`; the
current pending test/contract precondition needs separate owner review. It is
not counted as passing or as qualification of AH10 additional-daemon behavior.
The historical RED record remains unchanged.

## Remaining boundary

Only the AH10 custom-runner group was migrated in this wave. Other
`ah-crash-child`, AH17/AH18/AH19, P10 and other custom child groups remain on
their existing startup paths. Across the original 36 fixture files, 14
default-gate files are fully nonce opted-in, 4 pending files use the new
handshake but remain excluded from default gates, and 18 files remain legacy.
This is not a claim that the whole functional catalog is safe to shard. F20
clean-checkout and Playwright/browser journeys remain serial.
