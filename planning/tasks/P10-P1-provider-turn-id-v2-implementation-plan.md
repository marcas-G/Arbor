# P10 → P1 ProviderTurnId V2 Codec — Fixed Implementation Plan

Status: **PLAN ONLY — implementation authorization is not established**

## Pinned owner contract

This plan implements only the accepted ProviderTurnId V2 codec contract:

- Acceptance token: `ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`.
- Accepted proposal SHA-256:
  `5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E`.
- Owner landing commit:
  `b10f8eba9191b93a5de59883bd9d1618fec48920`.
- Independent post-landing review:
  `planning/results/P10-P1-provider-turn-id-post-landing-review.md`,
  B0=0/B1=0/B2=0; review record commit `49779b37`.
- Accepted implementation contract:
  `docs/design/03-detailed-implementation-design.md` §2.2.1, P3 `01`/`02`/`04`/`08`,
  P2 `01`/`04`, P1 `01`, P4 `06`, and P9 `07`.

The existing pre-intent bootstrap implementation authorization is
`AUTHORIZE_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_IMPLEMENTATION`. Whether
that token covers this newly accepted ProviderTurnId dependency is a separate
authorization decision reserved for the coordinating root after this plan's
review. This plan itself authorizes no production edits, tests, migration,
database operation, provider run, release, or deployment.

## Frozen codec

New writes use exactly these deterministic V2 forms:

| Family | ProviderTurnId string |
|---|---|
| Inference | `ptn_<ExecutionId>_<stepNo>` |
| Repair inference | `ptn_<ExecutionId>_<stepNo>_r<repairAttempt>` |
| Summary compaction | `ptn_<ExecutionId>_<stepNo>_compact_<contextEpoch>` |
| Provider Native compaction | `ptn_<ExecutionId>_<stepNo>_native_compact_<contextEpoch>` |
| Conversation Summary checkpoint compaction | `ptn_<ExecutionId>_<stepNo>_conversation_compact_<contextEpoch>` |
| Conversation Native checkpoint compaction | `ptn_<ExecutionId>_<stepNo>_conversation_native_compact_<contextEpoch>` |
| P20 OverflowReplacement | `ptn_<ExecutionId>_<stepNo>_overflow_0` |

`ExecutionId` uses its existing UUIDv7 codec. Numeric fields are canonical
safe decimal integers without leading zeroes; `stepNo` and `contextEpoch` are
non-negative, `repairAttempt` is positive when its suffix is present, and the
v1 overflow ordinal is exactly `0`. `ptn_<UUIDv7>` remains accepted only for
read/replay of existing evidence. No other suffix or arbitrary string is
accepted. The version is the codec contract, not an added string segment.

The spelling of every persisted or externally observed ProviderTurnId remains
byte-for-byte stable through SQLite, Manifest, ProviderAttempt/Result,
Session source refs, P3 Actions, RecoveryBindings, P20 links, BlockedActionRef
results/commands and public progress events. No existing identity is
normalized, re-encoded, reconstructed from Session text, or backfilled.

## Goal and explicit non-goals

Implement one strict parser/decoder and typed V2 constructors so current
production ProviderTurnId producers and readers use the accepted grammar. The
pre-intent CandidateRead → P1 → approval → P4 intent path must no longer reject
the current deterministic P3 Step ID. Existing P1 source comparison remains
structural and exact.

This plan does not change:

- `DecideSandboxPolicy` request schema, P1 semantic fingerprint, receipt
  schema, result shape or stale-field behavior;
- P9 ProviderUnavailable terminal/no-later-action behavior;
- P20 overflow ordinal/role/link semantics;
- SQLite schema, DDL, migrations, or historical persisted ID bytes;
- the public CandidateRead DTO or provider capability/support status.

No provider/helper, online database, preserved database, migration/upgrade,
deployment or release operation is in scope.

## TDD work DAG and qualification gates

### Wave 0 — inventory and RED codec matrix

- Pin all producer and reader callsites listed by the owner landing: inference,
  repair, Summary/Native compaction, Conversation Summary/Native checkpoint,
  P20 overflow links, Provider/Manifest/Session, P2/P1 command codecs, P4
  requirement reads, and P9 legacy/recovery.
- Add tests from §2.2.1 for every accepted value family and strict rejection
  of malformed ExecutionId, wrong UUID version, negative/out-of-range or
  leading-zero ordinals, `_r0`, unknown/duplicate suffixes, non-zero overflow
  ordinal, truncation, arbitrary prefix-only strings and cross-family
  ambiguity.
- Prove UUIDv7 is accepted for read/replay and never emitted by a new-write
  constructor. Preserve a historical value byte-for-byte in the fixture.

### Wave 1 — Domain codec and deterministic constructors

- Implement a closed `ProviderTurnId` decoder that accepts exactly the V2
  families plus the read-only UUIDv7 legacy variant.
- Replace direct `as never` string construction at every production callsite
  with typed constructors for the exact family. Do not change generated V2
  strings or call-site identity inputs.
- Keep domain logic pure and architecture edges unchanged. The Provider
  adapter receives the ID; it does not allocate or re-encode it.

Gate: domain/agent-runtime unit tests, typecheck, build, targeted Biome,
architecture checks for affected packages, and diff check.

### Wave 2 — Provider, Manifest, persistence and exact replay

- Route ProviderContext, ProviderTurn/Attempt, Manifest, ModelOutput source
  refs, AgentLoopStep and P20 link reads through the strict codec.
- Keep SQLite TEXT values and existing UNIQUE/FK keys unchanged. Reads return
  the exact stored string; do not normalize or rewrite historical UUIDv7 or
  composite values.
- Exercise each P20 role (Inference, OverflowCompaction,
  OverflowReplacement), both compaction implementations, Session source refs,
  Manifest binding and restart replay. Assert one provider identity/Manifest
  per exact persisted source and no second ordinal or replacement ID.
- Prove an unknown/corrupt persisted ID fails before provider request, Action,
  receipt, Observation, or P20 mutation through the existing typed failure
  path.

Gate: focused persistence/agent-runtime tests, P20 process restart targets,
typecheck/build/architecture/Biome/diff checks. No schema fixture is upgraded
or rewritten.

### Wave 3 — receipts, external action references and streams

- Update strict `BlockedActionRef.providerTurnId` result and external-command
  decoders to the same closed codec.
- Exact-replay historical Blocked command receipts containing UUIDv7 and
  recognized composite IDs. Assert same CommandId returns identical stored
  bytes without re-encoding, new decision, event or ID rewrite.
- Validate external action-reference input against the exact existing P3
  Step/Manifest/Action source. Legacy UUIDv7 is not authority to mint or rebind
  a ProviderTurn.
- Assert canonical `TurnStarted`, Provider execution context and existing
  public ConversationStreamEvent `started`/`delta`/`reset` values echo the
  same exact ID; clients and adapters do not parse/re-encode it.

Gate: focused P1/P2/P3 result, external-command and stream tests; exact legacy
receipt compatibility; typecheck/build/Biome/diff checks. No result/handler
schema bump, P1 fingerprint change, wire-field change or migration.

### Wave 4 — P4/P1 pre-intent CandidateRead integration

- Run the existing real public P38 journey from a fresh disposable schema-50
  database. The strict P4 source reader must recognize the current P3 V2
  ProviderTurnId and exact Pending approval.
- Qualify public `workspace-detail` CandidateRead before P4 intent; assert no
  ToolInvocation, RecoveryBinding, Observation, effect, event, approval
  consumption or provider request is created by the read.
- Commit P1 from the public safe V2 DTO, then human-resolve the exact approval.
  Prove the first P4 intent uses the same P3 Action/approval/provider identity.
- Cover Action drift, approval resolution/expiry races, trusted GatewayNow with
  unchanged approval revision, Action-first stale precedence, same-CommandId
  replay before source reads, fresh stale receipt, and the existing P1
  pre-/post-commit crash boundaries.
- Kill/restart after P1 policy commit but before approval resolution; verify
  the original exact Action/approval and P1 receipt remain usable without a
  new identity or rewritten receipt.

Gate: targeted P1/P4/P10/functional process cases pass; build before process
qualification; process fixtures use only fresh disposable databases and the
local deterministic provider boundary.

### Wave 5 — legacy recovery and full convergence

- Qualify P9 legacy adoption and P20/Manifest/Session exact replay with both
  recognized read variants. Unknown strings fail closed with existing typed
  classification and no provider/action/receipt replay.
- Prove old result receipts, external action references and public progress
  records remain exact after restart.
- Re-run registered public/schema-50 qualification and independent
  implementation review.
- Run `pnpm check` and `pnpm test:functional` only after all targeted gates
  pass and their time/resource budget is established.

Completion evidence must explicitly state: no SQL migration/backfill, no
Provider support claim, no P1 fingerprint/result-schema change, and unchanged
P9 terminal semantics. Only Wave 5 may claim the codec dependency closed.

## Stop conditions

- A production constructor or accepted persisted source emits a format not
  listed in DID §2.2.1: stop and raise a Design Gap; do not widen the parser.
- Exact receipt/Manifest/Session/P20 replay would require changing historical
  bytes or a decoder/result schema beyond the accepted landing: stop and raise
  a Design Gap.
- DDL, migration, backfill, alias rewrite, new P1 payload/fingerprint, P9
  continuation, or provider-support change appears necessary: stop and request
  manual governance; do not implement it as a codec cleanup.
- Any ID is reconstructed from Session/model text or accepted by prefix-only
  validation: stop the affected work and fix within the accepted contract.

This plan pins the accepted contract and proposes an implementation DAG only.
The previously authorized bootstrap implementation token's coverage of this
new dependency remains for the coordinating root to decide after this plan's
review. Until that decision, implementation is not authorized.
