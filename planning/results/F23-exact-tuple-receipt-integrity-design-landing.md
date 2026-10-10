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

| Owner | Revision/status after landing | SHA-256 |
|---|---|---|
| `docs/design/03-detailed-implementation-design.md` | DID v1.35 | `C7FAA94E80C8B9B7C379EDE8C6FFEABDE2F459170224D72A409EC4AA326EFCF6` |
| `docs/design/implementation/P1/01-command-contracts.md` | P1 phase-scoped owner amended | `EDF6822F5E12EA8E560A40A65440AC9D2CCE6F5B8B371F6B36B24F46236D71ED` |
| `docs/design/implementation/P1/02-port-contracts.md` | P1 phase-scoped Port owner amended | `5CE3CE2B4CAF1DF6FC55B2E66FA17D5E634ED4099935EE66AD67F145584B4176` |
| `docs/design/implementation/P1/03-transaction-model.md` | P1 phase-scoped transaction owner amended | `D635CBBE4AF48E6308FA2957670CB4A734DD96592F2EC878ADA8556D714F97F8` |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | Frozen P1 `07` owner amended | `D9DCDC866FFEF1DDBFD1A20A0BC24460438D4060BBC61674DC6379A6571AF686` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | Frozen P9 `07` owner amended | `C53D825A3B232BA0E2BA19AC533EE67C0157152E173DAB61EF32F881067183A4` |

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
  No semantic result or handler schema version is changed.
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
