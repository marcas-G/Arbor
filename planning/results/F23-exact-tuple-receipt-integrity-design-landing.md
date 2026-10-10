# F23 Exact-Tuple Receipt Integrity — Design Owner Landing Record

状态：**owner clauses landed; runtime implementation and qualification remain open**
隔离树：`C:\Users\ThinkPad\.codex\worktrees\f23-receipt-integrity\Arbor`
Landing base: `c1a7116e113bd9d4a4e966bf6e89b83b742265fd`
Proposal SHA-256 (Git/LF blob): `70D55E2AD117D28522297B7BF55EC8AD479CA1BFEEF4025AEA7F1901793DD1A7`

## Authorization and basis

The fixed candidate was independently reviewed at **Blocking = 0**. The user
provided standing authorization to land high-confidence design changes without
seeking separate item-by-item permission. This owner landing applies the
candidate's result-decoding and AH10/P9 disposition without changing its fixed
semantics. The proposal remains preserved at the recorded SHA; this record does
not invent a new decision token or claim a new manual acceptance document.

The underlying evidence remains isolated: the prior Gateway exact-tuple and
ordinary AH10 consumer RED cases are recorded in
`planning/results/F23-exact-tuple-receipt-integrity.result.md`; the direct-child
A1 test at landing base asserts the P9 `ReceiptMismatch` writer call but fails
because malformed JSON currently exits before that call. That pending RED is
evidence for the accepted disposition, not implementation or GREEN evidence.

## Owning documents and post-landing digests

Owner digests below are SHA-256 of the exact committed Git blob bytes returned
by `git cat-file blob <commit>:<path>` at landing commit
`ac4a1ea9fb06aa78c1cbd3fd3b166fd951257563`. This byte sequence (not the
working-tree CRLF representation) is authoritative for the recorded digest.

| Owner | Revision/status after landing | Git-blob SHA-256 |
|---|---|---|
| `docs/design/03-detailed-implementation-design.md` | DID v1.35 | `870DC29BB807E79DC63EE5E7D591E81EB4DCF33298F18E63AFBD93191598FE3C` |
| `docs/design/implementation/P1/01-command-contracts.md` | P1 phase-scoped owner amended | `DE1C5BC7A7FA1AB58AEAA57A86E722061CB6C1EDD4567DF1EE8F47D7C02CFE78` |
| `docs/design/implementation/P1/02-port-contracts.md` | P1 phase-scoped Port owner amended | `D4E347BD63E196BD0F9D9BD6CD64B751812E4326BDDD28F7DF6CA212E40BFBDF` |
| `docs/design/implementation/P1/03-transaction-model.md` | P1 phase-scoped transaction owner amended | `1B9571E8559486B4C38D5608D18C38A8390A04863402332C790D3E513751D366` |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | Frozen P1 `07` owner amended | `3663BD8B0AACDDD505F5E8FE4DDC2BDCD131168D42D23A1CBC8C2811DD0B0804` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | Frozen P9 `07` owner amended | `8B82994A19420CD821AA0B136569D00D151843657F6032B932A23D858A0396D1` |

The top-level change is recorded as DID v1.34 → v1.35. The phase-owned P1/P9
documents do not have independent numeric revision headers; their owner clauses
are amended in place. No other design owner was changed.

## Landed disposition

- **Gateway exact tuple:** the existing `BEGIN IMMEDIATE` comparison order is
  unchanged. Mismatch still yields `IdempotencyConflict` before JSON parsing,
  disclosure or repair. Exact match selects the strict registered decoder by
  `(commandType, Handler.schemaVersion)` for each of the current 26 handlers'
  Committed result and the exhaustive `CommandRejection` union. Unknown/missing
  decoder, invalid JSON or shape fails as non-retryable
  `PersistenceCorruption<"CommandStore">`, rolls back the same transaction and
  creates no receipt, attempt, handler effect, canonical write or Event. The
  existing safe non-retryable transport Problem is reused. No SQL, DDL,
  migration, event version, tuple comparator or tuple priority changed.
- **Decoder shape ownership:** command result shapes remain owned by their
  existing command contracts; Domain Event schemas are not result schemas.
  Domain ID/value schemas may be reused as sub-schemas. The current schema-v1
  `ConcludeVerificationResult.conclusionReason` is absent in persisted JSON when
  `undefined`; decoding reconstructs the existing typed `undefined` value.
  This landing resolves the earlier RED report's serialization question; it is
  no longer an open design decision, though runtime decoder qualification is
  still open. No semantic result or Handler schema version is changed.
- **Prior-generation consumers:** these are separate from Gateway replay and do
  not compare a candidate tuple. They validate the expected prior CommandId and
  Project before decoding, then select by trusted action-route CommandType and
  registered Handler schema. The current route map is recorded in P1 `07`.
  Unsupported historic versions fail closed; there is no inferred fallback.
- **Ordinary prior consumers:** corrupt JSON/result shape remains a non-retryable
  operational failure, not `AgentActionRejected`; no P9 AssignWork fact,
  Observation, new Gateway Command, handler replay or receipt mutation.
- **Direct-child AssignWork A1/A2/B:** syntax-invalid A1 keeps an internal
  non-disclosing `PersistenceCorruption<"CommandStore">` classification and is
  routed to the existing P9 `ReceiptMismatch` fact/event transaction, then
  `AgentActionRecoveryBlocked`. A2 parseable wrong shape follows the same
  existing P9 receipt-mismatch path; B structurally valid binding/effect
  mismatch keeps its existing exact failure code. No decoder cause/raw JSON is
  placed in the P9 fact; `AgentActionRecoveryBlocked` carries only execution
  and logical-action identity. The direct-child route does not return the
  receipt corruption as `AgentActionOperationalFailure`/
  `ControlActionHandlerRejected`, replay the handler, issue a new Command,
  repair the receipt, append Observation, or mark Applied.
- **P9 fact durability:** existing identity
  `(executionId, logicalActionId, committedCommandId)`, fact/event atomic
  transaction, deduplication and before/after-commit crash convergence remain
  in force. If the fact transaction fails, no durable fact is claimed and
  recovery remains fail-closed without action advancement, Observation or new
  Command. No new failure code/table/event version was added.
- **Attention/diagnostics:** the existing AH10 P9 fact continues through its
  accepted P10 `Action Required` projection. No generic CommandStore corruption
  Attention source is added. There is no current observable diagnostic/logging
  sink asserted here; a new operator-visible diagnostic port/logger remains
  OPEN and must not be represented by `AgentActionRecoveryBlocked` or persisted
  P9 fact detail.

## Cross-owner consistency self-check

- P1 `01` defines strict result/rejection decoding and the safe failure type;
  P1 `02` keeps `CommandStore` raw, version-neutral and non-parsing; P1 `03`
  puts exact-tuple decode in the existing transaction and excludes corruption
  from retryable-attempt recording.
- Gateway still compares the three tuple fields before interpreting raw
  result/error data. The one transaction remains the receipt linearization
  point. No external Resolver/Actor order or P12 transport contract changed.
- P1 `07` assigns trusted decoder keys and prior identity/decode order. P9 `07`
  owns the direct-child A1/A2/B recovery disposition and uses only its existing
  fact/event and dedup identity. SD §4.11 and DID §6A.16 remain the semantic
  owners for the binding proof; P10 source/projection semantics were not
  changed.
- Exact tuple mismatch with corrupted raw JSON still has mismatch precedence;
  prior-consumer lookup remains a distinct route and cannot claim that
  comparator.
- `git diff --check` passed at landing preparation. No tests were run during
  this documentation-only landing; the listed RED evidence is retained as RED.

## Qualification still open

This is a design landing, not F23 implementation closure. Keep these explicit
OPEN items:

1. Runtime implementation and real adapter qualification for all 26 registered
   result decoders plus the complete rejection union: exact-tuple CommandStore
   writer/decoder transaction, rollback/no-attempt behavior, P9 fact/event
   writer failure-closed behavior, and pre/post-commit crash convergence.
2. Any operator-visible corruption diagnostic/log sink; currently there is no
   asserted observable sink and no new port is authorized here.
3. Cross-schema-version prior receipt replay compatibility; unsupported version
   remains fail-closed until an explicit compatibility mapping is governed.
The isolated landing commit SHA is recorded by Git and reported out-of-band to
avoid a self-referential commit record. No push or merge was performed.
