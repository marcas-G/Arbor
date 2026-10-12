# P4 live lease acquisition across daemons — qualification result

## Scope

Qualify that a second real daemon's scheduler observes and skips an exact
Execution with a live lease, and that the same second daemon's test-only probe
can enter the production `runExecution` path once and observe the real
`LeaseService.acquire` rejection. No P4 adapter/store or lease row is invoked
or modified directly to manufacture that rejection. The probe callbacks are
absent in normal production startup.

Source commit: `fc7353e27595498f5f9a2373373e776edd2b69db`.

## Qualification

Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-live-lease-acquisition.functional.test.ts
```

Result: **PASS**, 1 file / 1 test, 12.70 seconds.

The first daemon (PID 18436) acquired the target Work Execution
`exe_85b00f5d-1139-7fc4-89f8-6f008ee4ea1c` at generation 0 and held the
Provider request. The second real daemon (PID 23408) emitted
`AH10PreDispatchSkippedLiveLease` for that same Execution. After the test gate,
the child invoked the production `runExecution(exactExecutionId)` once through
a separate production `main(config)` layer; its real `LeaseService.acquire`
returned `LeaseFencingRejected` at generation 0. The second daemon never
emitted `AH10AfterLeaseAcquired` for the target Execution.

The DB and probe log are retained at:

```text
C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-TwqA3y
```

The exact probe sequence is in `p4-live-lease-probes.ndjson`. The target
Execution has one P4 ToolInvocation (`tin_018f2b3c-4d5e-7abc-8def-f4363dd4cc87`)
and one `callRef` (`call_6c4d02dc9277432db5b8854a0e96492f`). The old process
reported effect-before-settlement and settlement-commit for that same pair.
The ToolInvocation settled `Success`; the Work Execution settled `Completed`
with `CompletionClaimed`. Its final lease row remained generation 0. The
NonIdempotent effect file `workspace/p4-live-P4-LIVE-ecdd2425.txt` contains
exactly one line, `P4_LIVE_EFFECT_P4-LIVE-ecdd2425`.

The Work Execution produced two distinct ProviderTurns, each with exactly one
successful provider attempt (attempt number 0). No duplicate provider request,
ToolInvocation, external effect, or settlement was observed.

## Checks

- Biome on all five changed source/test files: PASS.
- `node --check tests/functional/support/p4-tool-lease-fencing-child.mjs`: PASS.
- `pnpm --filter @arbor/execution-runtime build`: PASS.
- `pnpm --filter @arbor/single-workspace build`: PASS.
- `git diff --cached --check`: PASS before source commit.
- No `docs/design/**` files changed.

The complete v18 `tsconfig.test.json` check still reports existing errors in
other P4/adapter tests that have not adopted the `executionFence` argument;
the new qualification test itself had no TypeScript diagnostics.
