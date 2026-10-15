# P37 Exited-Owner Lease Evidence Qualification

Date: 2026-10-16

## Failure evidence

Release run `.test-results/2026-10-15T14-37-52-600Z-8476` at
`07f0f88291ee653e1100bfeb2e93d351ef370c78` failed only
`keeps an existing P9 fact ActionRequired after Inbox evidence drifts, without
a new Command or Observation` in the P37 DeliverMessage crash matrix.

The failure showed durable generation 4 for the target Execution but the
helper's synchronous reverse scan had selected a generation-3 acquire probe
from the same PID/incarnation. Comparing that stale probe to the authoritative
row correctly failed the old qualification, but it could not distinguish
stdout lag from a contradictory owner. The old helper could not prove the
durable owner at that handoff.

## Qualification change

All eight P37 process callsites and the RAI caller now pass `probes` and the
daemon controller directly to `expireP37LeaseForQualification`; callers no
longer pick an owner probe themselves. The wrapper requires an already-exited
daemon and pins the exact PID/snapshot, then reads the authoritative SQLite
lease tuple before waiting. During the bounded wait it repeatedly verifies the
same exited PID and unchanged full tuple.

The evidence resolution is:

- Prefer an exact `AH10AfterLeaseAcquired` probe matching execution ID,
  exited PID, worker ID, incarnation, and durable generation.
- If the exact durable-generation probe is absent after the deadline, allow
  only a lower safe-integer generation probe for the same execution, exited
  PID, worker ID, and worker incarnation. Incarnation binds the process-lifetime
  owner; the returned evidence uses the durable generation, never the lower
  observed generation, and marks provenance as
  `DurableGenerationWithStableIncarnation`.
- Any conflicting owner probe at the durable generation, higher generation
  for that incarnation, PID change, tuple drift, or missing prior probe fails
  closed with bounded tuple/probe-generation/daemon diagnostics.

The resolved evidence and exact tuple are then passed to the unchanged
owner-exit CAS. No production execution, lease, or design semantics changed.
An attempted test-child stdout-flush change did not produce the missing marker
and was reverted; the final fix relies only on exact/derived owner evidence.

## Verification

- `pnpm exec vitest run tests/p37-lease-qualification.test.ts` — PASS, 7/7:
  exact probe after stdout lag, durable-generation derivation across a gap,
  tuple drift, PID mismatch, conflicting same-generation owner, higher
  same-incarnation generation, and no prior probe.
- P37 ActionRequired-after-Inbox-drift exact case — PASS, three consecutive
  rounds (about 51–52s each).
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p37-delivermessage-process-crash.functional.test.ts` — PASS, 11/11, 501.07s.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/rai-readmission-hold.functional.test.ts` — PASS, 2/2, 70.31s.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on changed TypeScript/JavaScript files and `git diff --check` — PASS.

The full release suite was not rerun.
