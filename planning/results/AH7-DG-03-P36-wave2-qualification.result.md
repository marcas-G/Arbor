# AH7-DG-03 P36 Wave 2 Targeted Qualification

Date: 2026-10-11  
Tested HEAD: `ee00b98c5af67f45875966e22464b7bb3c0dcc92`  
Wave 1 authorization: `planning/results/AH7-DG-03-P36-implementation-authorization.record.md`

## Scope and sequence

This record covers only the Wave 2 P3 module, P12 compatibility, and selected
AH7-DG-03 L4 real-process qualifications. Tests were run serially; each test
command reached a terminal result before the next was started. The Web client
was built once before the L4 process tests because `apps/web/dist` was absent:

```text
pnpm --filter @arbor/web build
PASS (Vite build; existing >500 kB bundle-size warning)
```

Every Vitest selection below ran at `ee00b98`. The corresponding source
implementation commits and their selective integration mappings are noted in
the table; those are provenance, not additional test runs.

## P3 AgentLoop module

Source `8ccc6b3` → integrated `084d968` (`Qualify AH7 AgentLoop denial projection`).

```text
pnpm exec vitest run tests/p3-driver.test.ts
Test Files  1 passed (1)
Tests       41 passed (41)
```

This was the whole P3 driver file. It covers the executable Denied and
Interrupted projections alongside the existing Control Denied behavior. The
previous source-branch result selected only seven AH7 cases; this integrated
run exercised the entire file.

## P12 compatibility selection

P36/P12 fixture source `7b30b4d` → `da67974`, with the source-revision
qualification fixture change `6438778` → `7b47b7e`. The P12 production
composition compatibility fix was present in the integrated base and was
retested here.

The exact 15-file selection was:

```text
tests/p12-acceptance.test.ts
tests/p12-plugin-sdk.test.ts
tests/p12-observability.test.ts
tests/p12-closure.test.ts
tests/p12-authority-resolver.test.ts
tests/p12-providers-tools.test.ts
tests/p12-production-composition.test.ts
tests/p12-region-encoding.test.ts
tests/p12-remote-worker.test.ts
tests/p12-transport.test.ts
tests/p12-toolcatalog.test.ts
tests/p12-storage.test.ts
tests/p12-security-performance.test.ts
tests/p12-secret-store.test.ts
tests/p12-runtime-safety.test.ts
```

```text
Test Files  15 passed (15)
Tests       160 passed (160)
```

The production-composition assertions preserve the B7 upgrade from a P35
database through startup to P36 and B8 direct P36 readiness. The view request
uses the configured `user:local` credential; command submission retains the
`user:governance` human credential. No production auth rule was relaxed.

The P12 selection executes its existing restore-drill test, which writes the
tracked `planning/results/P12.restore-drill.json` artifact. Its generated diff
was verified to change only `timestamp` and `restoredDbHash`; those two volatile
fields were restored to the pre-Wave-2 values. The drill run is not counted as
a new P12 restore qualification or as a change to that artifact.

## Selected L4 real-process boundaries

| Qualification | Source → integrated implementation/evidence | Command result |
|---|---|---|
| Store claim, Denied and Interrupted pre/post-COMMIT with independent child processes | `a17f547` → `1789c4a` hardening; `8067073` → `551e8b4` result | `agent-action-ah7-p4-store-process-crash.functional.test.ts`: 1/1 test passed, six kill/replay branches; 14.34s total |
| `NotAdmitted` / `MayHaveStarted` effect-admission takeover for Reconcilable and NonIdempotent | `95341a4` → `09a8212`; final three-case qualification `db92965` → `6c52ed8` | `p4-ah7-effect-admission-takeover.functional.test.ts`: 3/3, 50.82s |
| Old-generation post-effect settlement fence | Existing F80 P4 lease-fencing implementation and test | `p4-ah7-tool-settlement-lease-fencing.functional.test.ts`: 1/1, 17.15s |
| P4 settlement plus P3 ToolResult/Observation/Action/cursor crash boundaries | `db92965` → `6c52ed8` | `agent-action-ah7-pending-intent.functional.test.ts`: 7/7, 276.40s |
| Multi-action B effect followed by settlement interruption/restart | `db92965` → `6c52ed8` | `agent-loop-ah7-b-effect-before-settlement.functional.test.ts`: 1/1, 69.77s |

The L4 fixtures use public Work-level Control approval only to admit Work and
no-approval Executable invocations. They do not exercise an approved
Executable `InvocationApproval` handoff.

## Limits

No full `pnpm check`, full `pnpm test:functional`, or Playwright suite was run
at this HEAD. These selected test counts must not be added together and
reported as a whole-repository gate. Wave 2 qualifies only the listed
no-approval P3/P4 paths; it does not close AH7-DG-03 or overall AH7.

AH7-DG-02 remains open: `MayHaveStarted` does not establish external reality,
and active Reconcilable reconciliation is not qualified here. The
production-approved Executable approval issuance/binding route remains absent
per `planning/results/AH7-DG-03-approved-executable-route-audit.result.md`;
no test-only approval injection or Work Control approval is evidence for that
route. Those boundaries require separate owner direction and qualification.
