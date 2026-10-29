# ProviderTurnId V2 Closed Codec — Governance Decision

Decision: **ACCEPTED — Option A, ProviderTurnId V2 closed codec**

Acceptance token: `ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`

Accepted fixed proposal:
`planning/proposals/P10-P1-provider-turn-id-codec-gap-draft.md`

Canonical LF UTF-8 SHA-256:
`5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E`.

The user accepted this exact option and proposal SHA on 2026-10-21. The
owner-document landing is delegated under the manual governance exception in
the repository guide. The complete file pre/postimage manifest is
`planning/results/P10-P1-provider-turn-id-landing-manifest.md`.

## Accepted contract

- `ProviderTurnId` has one strict, versioned, closed V2 codec. Its accepted
  V2 composite families are Inference, repair Inference, Summary compaction,
  Provider Native compaction, Conversation Summary/Native checkpoint
  compaction, and the ordinal-0 P20 OverflowReplacement. The exact grammar is
  frozen in DID §2.2.1 and referenced from the owning P2/P3/P4/P9 contracts.
- The new-write forms are only the reviewed deterministic V2 composites
  derived from exact Execution/step/repair/compaction/checkpoint identity.
  UUIDv7 ProviderTurnIds are read/replay-only compatibility values. No V1
  UUIDv7 value is generated for new work by this contract.
- Unknown suffixes, malformed IDs/ordinals/epochs, leading-zero numeric
  components, non-zero overflow ordinals, and arbitrary strings fail the
  existing strict typed decode/recovery boundary. No `string as
  ProviderTurnId` or prefix-only acceptance is allowed.
- The codec preserves the exact source spelling. SQLite keys, Provider
  intents/attempts, Manifest, Session source refs, P3 Action and
  RecoveryBinding identities, P20 links, BlockedActionRef command/result
  values, Provider events and public conversation progress values are never
  normalized, reconstructed, re-encoded, or rewritten. Existing UUIDv7 and
  V2 composite records remain byte-identical and replayable.
- P2 Blocked action references and P1 receipt/result decoding accept only the
  closed V2 codec plus the exact legacy UUIDv7 read variant. A legacy value
  used in a current action-reference submission must still bind to its exact
  existing canonical P3 Step/Manifest/Action evidence; the external value
  cannot mint or rebind a ProviderTurn.
- Existing SQLite TEXT identity columns, uniqueness/FK behavior and P20
  `(step identity, overflow_ordinal, role)` identity remain unchanged. No DDL,
  migration, backfill, online database access, or row/receipt/result rewrite
  is authorized.
- No P1 request payload, semantic fingerprint, handler/result schema,
  receipt tuple, P9 terminal/no-later-action rule, CandidateRead DTO,
  provider capability status, or supported-provider claim changes.

## Owner scope

The exact edited owners are listed in the landing manifest. DID §2.2 owns the
closed identifier grammar. P3/01 and P3/08 own provider propagation and
AgentLoopStep/P20 identities; P3/02 and P3/04 own Manifest and storage
bindings; P2/01 and P2/04 own Blocked references and Step storage; P1/01 owns
exact typed receipt replay; P4/06 consumes the exact typed source; P9/07 owns
recovery and legacy adoption. Their indexes are updated where needed.

No System Design, Problem & Goals, Scenarios, Web behavior, production code,
tests, migration or database file is part of this landing.

## Authorization boundary

This decision authorizes only the exact owner-document landing and its
consistency review. It does **not** authorize production code changes,
migrations, backfill, provider/helper execution, database operation, release,
or deployment. A SHA-pinned implementation plan and independent review must
be completed first; the coordinating root will determine separately whether
the existing P10/P1 bootstrap implementation authorization covers this newly
accepted dependency.
