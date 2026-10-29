# Schema-42 current-runtime test fixtures

Date: 2026-10-14
Base: `d0511ade`
Scope: test setup and fixture behavior only; no production semantics or design documents changed.

## Changes

- Runtime and composition tests now use `createSchema42TestDatabaseFactory`:
  one trusted template per suite and a private real-file clone per case.
- The S1–S4 black-box suite starts a fresh daemon, Provider stub, and schema-42
  clone for each scenario. Each scenario creates its Project through the public
  HTTP command surface. S4 independently drives the public Work approval,
  verification, and acceptance path before its hard restart. `afterEach`
  cleanup uses `finally`; the shared template is removed in `afterAll`.
- The scripted verifier emits `Write-Output 'BB_VERIFIED'`, which matches the
  shell allowlist. It waits for a successful public ToolResult, records evidence
  against newest-first result `1`, then reads the Runtime-produced evidence id
  from the subsequent public Provider context before concluding.
- No test fabricates `user_version`, skips P39, or reads internal state in
  S1–S4.

## Verification

- `pnpm typecheck`: PASS.
- Biome for the five changed tests and `git diff --check`: PASS.
- `pnpm --filter @arbor/web build`: PASS.
- P7 wake pipeline, P34 daemon wiring, P5 registry, and provider config:
  4 files / 16 tests PASS, single worker.
- Focused S1: 1 test PASS (the other three were excluded by the name filter).
- Full S1–S4 black-box: 1 file / 4 tests PASS, including independent
  per-scenario startup and S4 hard restart.

The initial unquoted shell command was classified as requiring approval and
left Verification Open with `Unknown` and no evidence. The corrected command
produced a successful observation; Runtime-bound verification evidence and
Acceptance then completed through public APIs.
