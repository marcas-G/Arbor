# F23 Wave 3 — Typed Internal Gateway Input Validation

Date: 2026-10-10  
Baseline: `e2b3848ddc4e63b5a8d159309ef6130341bd462d`  
Accepted contract: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`  
Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

## Result

**The authorized internal-ingress slice is implemented and targeted-qualified. F23 remains open.**

For `System`, `ExecutionOrigin`, and `RecoveryController`, `CommandGateway`
now reuses the registered command input descriptor to validate the typed
payload immediately after resolving the handler and before fingerprint
derivation, transaction entry, receipt lookup, fencing, authority evaluation,
or handler execution. `External` submissions retain their existing
Composition/decoder route.

A descriptor failure returns the typed `InternalCommandContractDefect`
Gateway error with the descriptor's path/rule issues. It is a non-command
failure, not `CommandRejection` or `AuthorityDenied`; it does not create a
receipt, resolving/retryable attempt, Event, or canonical write, and it does
not create a model-usable rejection. On the AgentAction path, the existing
`actionOperationalFailure` mapping classifies an unrecognized Gateway error
as `AgentActionOperationalFailure`; the Agent Loop safety-stops that failure.
Only `AgentActionRejected` takes the model-usable rejection path. A valid
typed internal payload continues through the existing Gateway path.

The accepted design says an internal validator failure is a typed contract
defect/Attention but does not define a general durable Attention sink or its
delivery fields/ownership. Following the scoped instruction, this wave emits
the typed defect only. It adds no `AttentionSource`, persisted Attention,
retry policy, or other new failure semantics.

## Red/green evidence

Before the Gateway change, the three new malformed-payload cases returned
`Right` for `System`, `ExecutionOrigin`, and `RecoveryController`; the expected
typed defect was absent. After implementation:

- `pnpm exec vitest run packages/application/test/p1-gateway.test.ts` — PASS,
  1 file / 19 tests. The cases assert failure before transaction, fence,
  handler, receipt, attempt, or Event effects. The malformed `undefined`
  `messageId` also proves validation precedes fingerprint serialization.
- The valid typed `SubmitHumanMessage` case reaches the handler and commits.
- `pnpm typecheck` — PASS, exit 0.
- `pnpm exec biome check` on the three changed TypeScript files — PASS.
- `git diff --check` — PASS.

`pnpm check` is **not claimed as passed**. An initial full run advanced through
lint/typecheck into the root Vitest suite, but its exec session ended without a
retrievable final status. A second session-tracked run confirmed lint (with
one existing warning in `packages/agent-runtime/src/model-decision.ts`),
typecheck, and architecture tests (31 files / 158 tests passed), then reached
the root Vitest suite. That duplicate full run was interrupted to avoid
spending another long interval on the suite; it does not qualify the full
check. The integration owner can run the full check after combining the
isolated F23 waves.

## Scope

Changed files:

- `packages/application/src/gateway.ts`
- `packages/application/src/gateway-contracts.ts`
- `packages/application/test/p1-gateway.test.ts`
- `planning/results/F23-wave3-internal-ingress.result.md`

No HTTP, WebSocket, CLI transport, Composition, receipt result/error decoder,
historical receipt row, receipt store, migration, or `docs/design/**` file was
changed. No receipt-integrity or old-row behavior is qualified here. No
durable Attention delivery is claimed. F23 / FT-DG-03 remains open pending
the other authorized waves and their independent evidence.
