# S2 SteerWork Revision — L2 public-process qualification

**Status: PENDING — scripted qualification source is prepared but has not been
run.** This file is a test plan and result ledger, not evidence of runtime
qualification.

## Source and scope

`tests/functional/process/s2-steer-work-revision.functional.test.ts` defines a
single disposable-database public-process journey using the scripted provider
fixture. Public APIs cause all writes; SQLite reads are test-oracle snapshots
only. There is no real Provider. The journey intentionally exercises the
normal scripted daemon/restart harness, but must only be run in the mainline
functional-test slot after its unified build is ready.

## Qualification assertions

1. Admit a fresh root Work through the public conversation and settle a PASS
   Verification at revision 0.
2. Submit legacy DirectionGuidance through `/commands`; assert revision 1,
   exact unchanged contract snapshot, `DirectionGuidance` history source
   CommandId, and no `ExecutionStopRequested`.
3. Hold the revision-1 Workspace main at a scripted Provider boundary. Submit
   Critical Steer with a complete ContractAmendment. Assert revision 2 is the
   exact amendment snapshot, one `WorkAmended` fact, one Stop fact bound to the
   held ExecutionId, and no extra ProviderTurn/ToolInvocation for that stopped
   Execution.
4. Submit the old revision-0 PASS Verification against Work revision 2 and
   assert `VerificationAcceptanceMismatch`; after hard restart, replay the
   exact Critical Steer CommandId and payload and assert one receipt, one
   revision-2 history row, and one exact Stop fact.
5. Allow the amended revision-2 Work to produce and conclude its own PASS
   Verification. Assert its mission snapshot equals the amendment and no
   revision-1 Verification was created; accepting the revision-2 Verification
   then succeeds.

## Evidence ledger

| Gate | Result |
|---|---|
| Test source authored | PASS |
| Focused process test executed | PENDING — deliberately not run |
| Full `pnpm typecheck` | BLOCKED by unrelated mainline test error in `packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts` (`PortableModelRequest.inputItems` is not narrowed from the V1/V2 union); the initial run also found and fixed an S2 test-oracle cast error |
| Biome on changed test/support files | PASS |
| Full process / release qualification | PENDING |

No daemon test, migration, real Provider, or functional suite was run in this
turn. L2 remains unqualified until the focused test passes in the authorized
mainline slot.
