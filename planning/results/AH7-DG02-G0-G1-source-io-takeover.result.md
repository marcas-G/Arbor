# AH7-DG-02 G0/G1 source-I/O takeover qualification

Date: 2026-10-17  
Implementation/test commit: `3f8eb34d538b69f53206ec93f43d4e0c6518fa7a`  
Production baseline: `7d722de2ed577f9b96cfad71149b4a0fe83affd2`

Status: **PASS for one test-only `NotOccurred` source-I/O takeover case.** This
does not close the AH7 matrix or qualify a production Reconcilable profile.

## Qualification

The real-process test pauses old daemon G0 after its test-only authoritative
source has observed the exact invocation and attempt 0, but before that source
result returns. While G0 remains blocked, the isolated fixture expires the
observed lease row with an exact test-only CAS. A separate daemon G1 then uses
the production LeaseService path to acquire the immediately following fencing
generation. The test verifies distinct daemon PIDs and worker incarnation IDs.

G1 queries the same invocation/attempt-0 path, observes no prior external
effect, commits the one `NotOccurred` P39 RecoveryInput fact, admits attempt 1
of that same invocation, and converges to P4 Success and the existing P3
Applied action. Before G0 is released, the durable records already contain
exactly attempts 0 and 1 and one external effect. G0's delayed source result is
then released; its call returns, while the P39 fact and attempt records remain
byte-for-byte unchanged. The external-effect ledger contains one row, the
workspace marker contains one effect, and the persisted ProviderTurn/action
identity is reused without a second provider decision.

The fixture forces lease expiry to create a bounded concurrency window; this
qualification does not claim natural TTL expiry timing. The external source,
profile and effect ledger are test-only.

## Verification

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (existing large-chunk advisory only).
- `pnpm exec biome check --write tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts tests/functional/support/ah10-process-child.mjs` — PASS.
- `node --check tests/functional/support/ah10-process-child.mjs` — PASS.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "fences gen0 after delayed reconciliation I/O" --maxWorkers=1 --no-file-parallelism --retry=0` — 1 passed, 9 skipped; case 51.948s, Vitest run 68.71s.

The first authorized run timed out waiting for the G1 source-I/O observation.
Inspection found that the test child emitted that event only when the explicit
pause flag was set. The test-only trace flag now emits the event for both roles;
only G0's pause flag blocks. The successful run above used this corrected
observation point. No production code changed in this qualification increment.

## 2026-10-17 source-lookup process-kill case (pending serial execution)

Added an independent real-daemon scenario, `restarts after SIGKILL during
reconciliation source lookup`, using the same test-only source-I/O pause gate.
The old daemon is killed while its source query is held before return. A fresh
read-only SQLite connection checks before and after the kill that attempt 0 is
the only effect attempt, no reconciliation fact or P4 selection/settlement is
durable, and the test-source call remains unreturned. After the recorded lease
expires, the fixture restarts under a new daemon generation and the exact same
test profile re-queries attempt 0. The assertions require one selected
`NotOccurred` fact, attempts 0 and 1 sharing the effect key, one test external
effect, one P40 observation hash, one P3 ToolResult/Applied action and one
workspace marker effect.

This case has **not been executed**. Per serial-run coordination, no daemon
functional test was started in this checkpoint. Static checks completed:

- `pnpm exec biome check --write tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts` — PASS.
- `pnpm typecheck` — PASS.
- `git diff --check` — PASS.

After the main thread releases the daemon-test window, run:

`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "restarts after SIGKILL during reconciliation source lookup" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose`

Until that run passes and the recorded observations are reviewed, this scenario
is pending evidence and does not extend the qualification status above.
