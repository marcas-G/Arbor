# AH10 SendMessage Real-Process Takeover Qualification

**Status: PASS for the covered SendMessage Query takeover case; AH10 remains
PARTIAL.** This result covers one real dual-daemon generation takeover after a
generation-0 `FencingRejected` receipt commits. It does not close AH10 or qualify
other SendMessage outcomes and crash boundaries.

## Scenario

The isolated functional test
`tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts`
uses the production fixture, public `CreateProject`, `CreateChildWorkspace`, and
`AssignWork` commands, two independent production daemons, one SQLite database,
and the production 30-second lease. Both daemons use the existing test-only
`ah10-process-child.mjs` gates; neither the lease nor command receipt is written
directly by the test.

The child Work's single Provider decision calls `send_message` with `kind=Query`
and the exact parent Workspace as recipient. Generation 0 pauses after durable
ActionIntent and at the real lease-renewal boundary. After the persisted lease
expires, generation 1 acquires the same Execution and pauses at the same pinned
ActionIntent. Releasing generation 0 causes its actual Gateway attempt to commit
a `TerminalRejected(FencingRejected)` receipt. The test observes that receipt
and confirms there is no Message yet, then kills the old daemon. Generation 1 is
released and resolves the old receipt before committing under its new
generation-specific CommandId.

## Assertions

- Both generations retain the exact ProviderTurnId, LogicalActionId, and
  `callRef`; generation 0 and generation 1 use different CommandIds.
- Exactly one canonical Query Message exists, from the child to the root, with
  a content-addressed body reference and persisted correlation ID.
- Exactly one root `Message` Inbox entry exists for `msg:<messageId>`, bound to
  the same correlation ID.
- The Action is `Applied`, there is one AgentLoopAction Observation, and the
  Provider was called once.
- The new daemon reports no daemon errors.

## Verification

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
1 test passed (1/1; 41.529s test time)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed

pnpm exec biome check tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
passed
```

The qualification is limited to the post-commit old fencing receipt path for a
Query. It does not cover killing generation 0 before that receipt transaction
commits, a Committed old receipt takeover, other message kinds, or other AH10
control actions.

## Integrated revalidation (2026-10-07)

The AH10 primary process file and this SendMessage file were rerun together:
2 files / 8 tests passed in 301.41s. Full `pnpm check` also passed: Biome 943
files; TypeScript build and test typecheck; architecture 155 tests; core 1708
passed and 3 skipped; Web typecheck/build; Web 216 tests. AH10 remains PARTIAL;
this local run is not a full functional suite or phase-closure claim.
