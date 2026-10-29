# F23 Wave 1 — Application Wire-v1 Codec

Date: 2026-10-10
Accepted contract: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`
Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

## Result

**Wave 1 pure codec foundation implemented and locally qualified. F23 remains
OPEN.** This result covers only the Application-owned input contract registry,
the pure external command decoder, and closed payload codecs for the current
26 production command types. It does not qualify an external submission route,
receipt behavior, transport mapping, or release readiness.

The codec returns a discriminated typed command envelope only after validating
the outer envelope and selected payload. It rejects unknown properties at every
closed object depth, uses the shared Domain `ID_SCHEMAS` for branded IDs, and
returns sorted issues containing schema-authored field paths and the fixed
`<unknown-field>` marker. It does not include caller values or unknown property
names in failures. Dynamic policy/configuration records retain their declared
JSON-record shape.

The contract descriptor set matches the handler factories referenced by the
current production composition: 26 unique command types, including the
conditionally composed `ResolveControlApproval`. The six accepted factory-only
commands remain absent. Every descriptor carries its accepted external-origin
policy; policy classification does not grant authority. External wire codec
version is server-selected v1 and remains distinct from Handler `schemaVersion`
and fingerprint algorithm version; this wave does not derive or persist either
receipt value.

The first Wave 1 work turn ran the two F23 malformed-ID cases and the
unknown-field canary against a temporary permissive stub; all three failed as
expected and then passed with the codec. That temporary stub and its negative
control output were not retained, so this historical RED is **not independently
reproducible from the result artifact**. Do not count it as preserved negative
control evidence.

## Changed files

- `packages/application/src/external-command-codec.ts` — pure rule decoder,
  26 input descriptors, origin policy, registry parity guard, and typed
  external-envelope decoder.
- `packages/application/src/index.ts` — exports the Application codec API.
- `packages/application/test/external-command-codec.test.ts` — 9 initial focused codec
  cases covering malformed `MessageId` / `AcceptanceId`, nested and top-level
  unknown fields, ID validation in an array member, envelope decoding,
  unsupported commands, and inherited-key enum rejection.
- `apps/single-workspace/test/external-command-codec-registry.test.ts` —
  source-drift assertion plus real `SingleWorkspaceCommandHandlerRegistryLive`
  composition with `ControlApprovalStore` present and absent. It asserts the
  production 26-command set with the store, the exact 25-command test
  configuration without it, descriptor parity for each active set,
  factory-only exclusion, fail-closed drift, and separate origin policy.

## Verification

- `pnpm build` — PASS.
- `pnpm exec vitest run packages/application/test/external-command-codec.test.ts apps/single-workspace/test/external-command-codec-registry.test.ts` — PASS: 2 files, 19 tests.
- `pnpm exec biome check packages/application/src/external-command-codec.ts packages/application/src/index.ts packages/application/test/external-command-codec.test.ts apps/single-workspace/test/external-command-codec-registry.test.ts` — PASS.
- `pnpm exec vitest run tests/architecture` — PASS: 31 files, 158 tests.
- Full `pnpm test:functional` and `pnpm check` were not run in this wave.
- No database or receipt payload was read; no historical receipt inventory is
  claimed by this result.

## Remaining implementation waves

1. Integrate raw bounded HTTP/WS/CLI submissions into Composition: authenticated
   Principal, exact Actor binding, strict wire decode, Handler schema/fingerprint
   derivation, Resolver visibility, then existing Gateway. Keep receipt lookup
   exclusively inside the Gateway transaction and preserve AH10 contracts.
2. Validate typed System/ExecutionOrigin/Recovery submissions with each same
   descriptor, add the transport-only non-reflecting `InvalidCommandPayload`
   mapping (HTTP 400), and prove invalid input cannot reach Resolver/Gateway or
   create receipts/events/canonical writes.
3. Complete any authorized read-only historical receipt inventory using counts
   and non-sensitive representative metadata only, then qualify preserve-only,
   non-replayable behavior for malformed historical inputs. No database was
   inspected in Wave 1.
4. Promote the isolated F23 cases only after production-boundary qualification;
   complete accepted replay/visibility/concurrency and broader release gates.

F23 / FT-DG-03 is **not closed** by pure schema and registry tests. No Gateway,
Composition, HTTP, WebSocket, CLI, database, migration, or AH10 source was
changed in this wave.

## Review follow-up: EGP new-write closure

The initial codec accepted `WorkspaceMain` with only legacy `focus`, with no
episode, or with both, and accepted historical `CoordinationCompleted` /
`QueryCompleted` settlement results. The five test definitions are retained in
`packages/application/test/external-command-codec.test.ts` and now pass against
the corrected codec. The pre-correction RED output was observed during review
but was not persisted as a fixture or transcript; record that RED as **not
saved**. The decoder now requires the exact `ExecutionEpisodeBinding`, rejects
legacy `focus`, and excludes the two historical CompletedResult tags. The
semantic descriptor decoder itself remains independent of
`externalOriginAllowed`, so denied external-origin commands can still be
checked on the same typed internal path.
