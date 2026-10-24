# S2 SteerWork Revision — L2 public-process qualification

**Status: PASS — scoped scripted public-process qualification.** This record
qualifies only the named journey on the exact candidate below; it does not
qualify a real Provider, all S2 branches, or the complete release profile.

## Source and scope

`tests/functional/process/s2-steer-work-revision.functional.test.ts` defines a
single disposable-database public-process journey using the scripted provider
fixture. Public APIs cause all writes; SQLite reads are test-oracle snapshots
only. There is no real Provider. The normal scripted daemon/restart harness
was exercised in the authorized mainline functional-test slot.

## Qualification assertions

1. Admit a fresh root Work through the public conversation and settle a PASS
   Verification at revision 0.
2. Submit legacy DirectionGuidance through `/commands`; assert revision 1,
   exact unchanged contract snapshot, `DirectionGuidance` history source
   CommandId, and no `ExecutionStopRequested`.
3. Hold the revision-1 Workspace main at a scripted Provider boundary. Submit
   Critical Steer with a complete ContractAmendment. Assert revision 2 is the
   exact amendment snapshot, one `WorkAmended` fact, one Stop fact bound to the
   held ExecutionId. The already-sent held Provider request may settle as at
   most one additional ProviderTurn for that exact stopped Execution; assert
   no additional ToolInvocation, no terminal acceptance/completion facts, and
   that Work remains Open at revision 2. A separately scheduled revision-2
   Execution is outside this old-Execution quiescence oracle.
4. Submit the old revision-0 PASS Verification against Work revision 2 and
   assert `VerificationAcceptanceMismatch`; after hard restart, replay the
   exact Critical Steer CommandId and payload and assert one receipt, one
   revision-2 history row, and one exact Stop fact.
5. Allow the amended revision-2 Work to produce and conclude its own PASS
   Verification. Assert its mission snapshot equals the amendment and no
   revision-1 Verification was created; accepting the revision-2 Verification
   then succeeds.

## Evidence ledger

Exact candidate: `410695f9fa1b58905d42c33b5ac0f9d1ad7e17c2`.

Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/s2-steer-work-revision.functional.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
```

Result: exit 0; 1 file / 1 test passed; test 44,593 ms, total 64.79 s. The
journey covers public SteerWork revision history, exact Critical Stop binding,
stale Verification rejection, hard restart and same-command replay, revision-2
verification and acceptance. This is scripted-provider public-process
qualification only; real-provider S2 remains OPEN.

| Gate | Result |
|---|---|
| Test source authored | PASS |
| Focused scripted public-process test | PASS — exact command and candidate above |
| Earlier oracle correction 1 | The first quiescence oracle incorrectly rejected durable settlement of the ProviderTurn whose request was already held before Critical committed. It now allows at most that one held turn while asserting no old-execution ToolInvocation or completion. |
| Earlier oracle correction 2 | A subsequent global fixture provider-call count included a legitimate request from a newly scheduled revision-2 Execution. It was removed; quiescence is asserted only against the exact stopped Execution. |
| Fixture setup correction | Profile admission was enabled in the disposable fixture after setup reported zero available Profiles; this was fixed before the passing run and was not treated as qualification evidence. |
| Biome on changed test/support files | PASS |
| Real Provider / complete S2 / full release qualification | OPEN |

No migration or real Provider was used. The single scripted daemon process
journey passed; this does not qualify the broader functional suite.
