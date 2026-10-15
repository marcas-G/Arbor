# AH10 Live-Owner Expiry Qualification Repair

Date: 2026-10-15

## Regression and disposition

Commit `3f015df` replaced several natural `expires_at` waits with
`expireExecutionLeaseForQualification`. That helper deliberately crashes its
selected daemon before performing an exact lease-tuple CAS. The replacement
was invalid for AH10 cases whose next required step releases the old daemon's
gate and observes its stale `FencingRejected` receipt: after the helper call,
the old process was no longer available to produce that evidence.

The helper is now named
`expireExecutionLeaseAfterOwnerExitForQualification`; its exit check, exact
tuple CAS, and fail-closed behavior are retained. A separate
`waitForLiveOwnerLeaseExpiryForQualification` reads but never writes the lease
row and never crashes a daemon. It requires the exact
`AH10BeforeLeaseRenewal` pause evidence, matching generation, one unchanged
live PID, and an unchanged `(execution_id, worker_id,
worker_incarnation_id, generation, expires_at)` tuple throughout the wait.
It returns only after real `Date.now()` reaches the unchanged lease expiry and
fails with tuple/process diagnostics on drift, exit, or deadline.

The six unconditional live-owner replacements now use the live wait:

- current-Workspace AssignWork;
- direct-child AssignWork takeover (`before`/`after` branches);
- AcceptResult FencingRejected takeover;
- SelectCurrentWork takeover;
- SendMessage Reply takeover;
- SendMessage DecisionRequest takeover.

The direct-child receipt-binding site is explicitly split by `crashSide`:
`approval-fencing-before` uses live-owner qualification; the already-exited
branches use the owner-exit CAS. Other owner-exit callsites,
including AH17–AH19 and P37, were mechanically renamed without changing their
qualification behavior.

## Verification

- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on all changed TypeScript files — PASS.
- `pnpm exec vitest run tests/lease-qualification.test.ts` — PASS, 8/8. Covers
  owner-exit CAS, refusal to CAS a still-live daemon, live natural expiry with
  no crash/no write, early owner exit, tuple drift, and bounded timeout.
- The following focused functional commands used `vitest.functional.config.ts`
  and `-t` filters to run only the listed cases:
  - `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts -t "takes over AcceptResult when the old FencingRejected receipt is interrupted|takes over current-Workspace AssignWork after killing gen0"` — PASS, 4/4.
  - `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts -t "takes over the genuine Scheduler DecisionEpisode after gen0 FencingRejected receipt commits after|recovers a Reply after gen0 after its Gateway transaction|takes over a DecisionRequest after killing gen0 after its FencingRejected receipt commits|takes over direct-child AssignWork after gen0 after its command boundary"` — PASS, 4/4; receipt-binding `approval-fencing-before` ran in its separate command below.
  - `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts -t "takes over direct-child AssignWork after gen0 approval-fencing-before its command boundary"` — PASS, 1/1.
- Focused AH10 real-process tests — PASS, 9/9:
  - AcceptResult `before` and `after` FencingRejected commit — 2/2;
  - current-Workspace AssignWork `before` and `after` — 2/2;
  - SendMessage Reply `after` — 1/1;
  - SendMessage DecisionRequest `after` — 1/1;
  - SelectCurrentWork `after` — 1/1;
  - direct-child AssignWork takeover `after` — 1/1;
  - direct-child receipt-binding `approval-fencing-before` — 1/1.

The functional suite was not run. Production code and `docs/design/**` were not
changed. Existing action-identity, stale-fence receipt, and no-duplicate
assertions remain in the tests.
