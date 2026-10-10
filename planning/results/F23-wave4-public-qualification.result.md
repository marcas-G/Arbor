# F23 Wave 4 — Default Public Qualification

Date: 2026-10-10
Accepted contract: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`
Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

## Result

**The Wave 4 public qualification slice is implemented and its targeted tests
pass. F23 / FT-DG-03 remains OPEN.** The two existing F23 public-process cases
are now under `tests/functional/process/`, so the default functional process
configuration collects them.

The moved tests continue to use a real isolated daemon and database. Each
journey successfully creates its project through the public `CreateProject`
command, demonstrating that the strict external codec accepts the corrected
envelope/payload split.

## Historical malformed receipts

One public-process case seeds two historical `Committed` rows into the same
isolated database. Both have a legal `SubmitHumanMessage` result shape with a
UUIDv7 `MessageId`, a valid schema version, and fingerprint algorithm 1:

- A malformed historical `CommandId`, submitted with an otherwise valid
  current payload.
- A valid current `CommandId` whose submitted payload has an invalid
  `MessageId`.

The daemon returns HTTP 400 `InvalidCommandPayload` for each request before
replay. The test compares every old receipt column before and after, including
hex encodings of the persisted text columns, and confirms byte-identical row
content. It also confirms no `command_attempts` row or Event is added for
either ID. The public response assertions determine the outward behavior;
SQLite reads are supplementary checks of the preserve-only invariant.

## Shell-face boundary

The shell contract test submits authenticated malformed input through
`HttpShell`, `WebSocketShell`, and `CliShell`. Each returns HTTP-style status
400 with the same non-reflecting Problem and no call to facts loading, Resolver,
or Gateway. A separate unauthenticated malformed-input case continues to
return 401 through all three shell faces without calling the submission port.

This qualifies the shell adapters directly. It does not claim a real network
WebSocket command journey or a standalone production CLI process journey; the
public daemon test exercises HTTP.

## Verification

- `pnpm build` — PASS.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/command-input-validation.functional.test.ts` — PASS, 1 file / 3 tests.
- `pnpm exec vitest run apps/single-workspace/test/external-command-boundary.test.ts` — PASS, 1 file / 3 tests.
- `pnpm typecheck` — PASS.
- Biome on the two changed TypeScript test files — PASS.
- No production implementation or `docs/design/**` file was changed.
- Full `pnpm test:functional` and `pnpm check` were not run in this wave.

## Remaining work

This result does not close F23. Broader replay, resolver-visibility, concurrency
and release qualification remain outside this slice. The HTTP/WS/CLI shell
adapter test is not a substitute for the real daemon WebSocket command face or
a standalone production CLI journey. Tuple-order corruption and receipt
result/error shape decoding remain explicitly outside scope pending governance.
