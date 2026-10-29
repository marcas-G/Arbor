# ProviderTurnId Closed Codec Gap — Governance Draft

Status: **DRAFT / NOT ACCEPTED — no design landing or implementation authorization**

## Decision requested

Choose the canonical closed encoding and compatibility contract for
`ProviderTurnId`. The domain parser currently accepts only `ptn_<UUIDv7>`, but
authorized runtime paths create deterministic composite values such as
`ptn_<ExecutionId>_<turn>` and `ptn_<ExecutionId>_<turn>_r<repairAttempt>` and
persist them as `ProviderTurnId`. A newly required P4 source decoder therefore
rejects a real current P3 Action before P10 can expose CandidateRead.

The governance decision must freeze a versioned, closed grammar across all
current producer families and legacy evidence. Arbitrary strings must remain
invalid. This draft does not authorize changing `docs/design/**`, runtime code,
SQL, migrations, receipts, provider support, or deployment.

Recommended Option A acceptance token:
`ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`.

## Observable failure evidence

The production-process reproduction is recorded in
`planning/results/P10-P1-provider-turn-id-design-gap-red.md`.

On a fresh disposable schema-50 database, the existing public P38 journey
successfully makes three provider requests: Root `assign_work`, the
`WorkAssigned` response, then the Workspace shell Action. When P10 reads the
exact Pending P3 Action and P4 approval, the daemon fails closed with:

```text
PersistenceCorruption
repository: ToolObservationEvidenceStore
operation: sandbox-policy-requirement-read
reason: pre-intent P3 source contains malformed ProviderTurnId
```

The Executable approval Inbox row is consequently never published. The old
P38 public approval case reproduces the same failure, so this is an existing
runtime/source compatibility defect exposed by the new source decoder, not a
candidate fixture or pure-producer artifact.

## Cross-layer evidence

| Layer | Current evidence | Consequence |
|---|---|---|
| Domain decoder | `packages/domain/src/ids.ts` defines `ProviderTurnId` as `ptn_` plus UUIDv7 only. | The current `parse(ProviderTurnId)` rejects runtime composites. |
| P3 write identity | `packages/agent-runtime/src/model-decision.ts`, `agent-loop-actions.ts`, and `agent-loop-step-completion.ts` construct inference and repair IDs from Execution plus turn/repair ordinal and cast them to `ProviderTurnId`. | New canonical ProviderTurns already use deterministic composite IDs. |
| Compaction / checkpoints | `compaction-coordinator.ts`, `conversation-checkpoint-compaction.ts`, and `model-decision.ts` construct Summary, Native, and Conversation checkpoint IDs from Execution/step/context epoch. | A fixed grammar must cover every producer family, not just inference. |
| P20 overflow chain | DID v1.23 OVS-1…OVS-7 / §9.11A, migration 0020, and P3/08 persist exact `Inference`, `OverflowCompaction`, and `OverflowReplacement` IDs, predecessor IDs, and manifests under unique ProviderTurn links. Recovery compares these exact identities and does not allocate replacements. | Re-encoding an existing ID can break chain uniqueness, predecessor binding, or restart replay. |
| SQLite | `provider_turns`, `agent_loop_steps`, and `agent_loop_step_provider_turns` store ProviderTurn IDs as `TEXT`; uniqueness/FKs bind the exact string and no SQL constraint limits it to UUIDv7. | Storage currently preserves both forms without an encoding discriminator or migration. |
| Manifest / output / Action | P3 ProviderContext, Manifest, ModelOutput source refs, AgentLoopStep, P3 Action identity, and RecoveryBinding all carry or compare the exact ProviderTurn string. | Any format change must preserve exact source refs and same-Step Action binding. |
| Result / command codecs | `packages/application/src/command-result-codec.ts` strictly decodes `BlockedActionRef.providerTurnId`; `external-command-codec.ts` strictly decodes the related action-reference shape. | Historical Blocked result receipts and accepted action-reference command bytes can fail replay/decode when the ID is a current composite. |
| External observation | `ProviderExecutionContext` uses `ProviderTurnId`; the existing public `ConversationStreamEvent` exposes `providerTurnId` in `started`, `delta`, and optional `reset` frames. The accepted P1 pre-intent source proof remains an internal in-memory structural tuple, outside the request payload, result JSON, and semantic request fingerprint. | A codec decision must preserve exact historical stream/replay values. Do not infer that the new P1 proof changes P1 wire or fingerprint. |
| Legacy / recovery | Legacy adoption and recovery readers retain or compare historical IDs from persisted evidence; current ID consumers include both strict UUIDv7 parsing and exact-string reconstruction/comparison. | Compatibility cannot be solved by globally tightening reads or rewriting historical rows. |
| Public P1/P4 source | Accepted P4/06 makes `providerTurnId: ProviderTurnId` part of the closed pre-intent proof. The implementation plan requires existing branded decoders, and the new reader uses `parse(ProviderTurnId)`. | Current legitimate P3 state is rejected before CandidateRead can reach P1. |

These layers establish a contract mismatch. They do not authorize changing the
accepted P10/P1 source tuple, the P9 terminal rule, the P1 payload/fingerprint,
or the historical ProviderTurn rows.

## Option A — formalize current deterministic composites (recommended)

Define a closed `ProviderTurnId` V2 codec that accepts the UUIDv7 form only as
an explicit legacy variant and recognizes each reviewed deterministic
producer family as an exact grammar. New writes keep the current stable
Execution/turn/repair/compaction/checkpoint identity rules. Every producer,
manifest codec, Action/RecoveryBinding source, P20 link, and replay path uses
the same codec or a typed constructor. Unknown suffixes, malformed Execution
IDs, invalid ordinals/epochs, and arbitrary strings fail closed.

For this option's new-write/legacy split, accepted deterministic composite
V2 forms are the only forms written by new runtime work; UUIDv7 ProviderTurn
IDs remain read/replay-only compatibility values. Existing rows, manifests,
receipts and source refs are retained byte-for-byte and are never normalized
or backfilled. The owner landing must enumerate the exact composite grammar
before it authorizes this split.

The owner landing must inventory and either accept or retire every observed
producer shape before it publishes the grammar. The current source scan
includes ordinary inference, output repair, Summary compaction, Native
compaction, Conversation Summary/Native checkpoint compaction, and P20
overflow IDs. Provider turns already committed under a recognized historical
shape remain byte-identical; no database backfill or receipt rewrite is
inferred.

This option matches current new-write and recovery behavior, preserves
deterministic identity across restart, and avoids inventing a random-ID
allocation step for existing idempotent constructors. Its cost is a formal
closed grammar and a careful compatibility inventory.

## Option B — UUIDv7 for all new writes; composites become read-only legacy

Keep UUIDv7 as the only new-write encoding and change every producer to
allocate/persist one UUIDv7 before any Provider request or durable reference
is written. Existing composite values remain accepted only by a bounded
legacy read codec and are never regenerated for new work.

This follows the current simple domain parser for new writes, but requires a
durable identity-allocation contract for AgentLoopStep creation, P20 links,
compaction/checkpoint recovery and same-ID retry. It must prove a crash before
and after allocation cannot create another ProviderTurn, Manifest, Action,
output source ref, or P20 successor. It is a wider runtime and recovery change
than Option A.

## Required owner decisions

1. Select Option A or B, or request a bounded alternative.
2. Freeze the complete versioned grammar and identify the canonical constructor
   and strict decoder. The accepted grammar must cover or explicitly retire
   every current producer family found in source and persisted records.
3. Define validation and compatibility for SQLite rows, P3 ProviderContext,
   ProviderManifest/ProviderResult receipts, Session source refs, P3 Action and
   RecoveryBinding identities, P20 chain links, and legacy adoption. Exact
   historical IDs must remain replayable; no lossy rewrite is proposed.
4. Inventory every wire DTO, persisted result/receipt, semantic request
   fingerprint, and event codec that contains ProviderTurnId. Current evidence
   includes ProviderExecutionContext, public conversation progress frames,
   `BlockedActionRef` result receipts and its external action-reference codec;
   P1's accepted pre-intent proof is not serialized or fingerprinted. If a
   changed string is externally observable, specify versioning and exact
   replay before implementation. No P1 request/result field or fingerprint
   change is presumed by this draft.
5. Specify migrations or explicitly no DDL/backfill. Malformed or unknown
   values must fail closed with a typed boundary result; they must not be
   coerced to a UUID, silently normalized, or reconstructed from Session text.
6. Keep the accepted P9 terminal/no-later-action rule unchanged. The current
   gap occurs before P4 intent and does not authorize a successor ProviderTurn.

## Required qualification after governance landing

- Unit matrix for every accepted grammar variant, malformed prefix/suffix,
  ordinal, ExecutionId, repair attempt, compaction epoch, and cross-family
  ambiguity.
- Real process public P38/P10 reproduction: Pending P3 Executable Action plus
  exact Pending P4 approval → public CandidateRead with no ToolInvocation or
  RecoveryBinding → P1 decision → human approval → first exact P4 intent.
- Restart/replay for ordinary inference, repair, Summary/Native compaction,
  Conversation checkpoint, and P20 overflow chain using exact persisted IDs.
- Decode and exact-replay old `Blocked` result receipts containing composite
  `BlockedActionRef.providerTurnId`, and decode the related external
  action-reference shape; preserve accepted old bytes while rejecting unknown
  formats.
- Legacy UUIDv7 and recognized composite read/replay fixtures; unknown legacy
  value fails closed without rewriting DB, Manifest, receipt, source ref, or
  chain links.
- Verify no P1 request/fingerprint/result or P9 terminal behavior changed
  unless a separate accepted contract explicitly says otherwise.

## Explicit non-goals

- No permissive `string as ProviderTurnId` workaround in the P4 source reader.
- No arbitrary-string decoder or prefix-only acceptance.
- No change to the accepted pre-intent source tuple, P1 payload/schema 2,
  semantic request fingerprint, P9 terminal behavior, or candidate DTO in this
  draft.
- No edits to `docs/design/**`, implementation, migrations, receipts, or
  persisted rows before manual acceptance and exact landing review.

## Requested disposition

Accept Option A with token
`ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`, choose Option B, or request a
bounded alternative. The resulting owner landing must specify the complete
grammar and identify the owning P3/P2/P9 contracts and versioned package.
Until acceptance, the P4 pre-intent reader's strict ProviderTurnId branch
remains blocked; do not claim the public pre-intent CandidateRead → P1 →
approval qualification.
