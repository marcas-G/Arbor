# ProviderTurnId Codec Gap — Independent Review

Reviewed artifacts:

- `planning/proposals/P10-P1-provider-turn-id-codec-gap-draft.md`
- `planning/results/P10-P1-provider-turn-id-design-gap-red.md`

Proposal canonical LF SHA-256 independently recomputed:

```text
5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E
```

Review disposition: **NO BLOCKING FINDINGS — suitable for manual governance
option decision; the exact grammar remains for the accepted owner landing.**

The independent review checked the domain UUIDv7-only `ProviderTurnId` parser
against production inference, repair, Summary/Native compaction, Conversation
checkpoint, and overflow constructors; the migration-0020 exact identity/P20
chain; P3/08; SQLite TEXT/unique bindings; ProviderContext/Manifest/Action/
RecoveryBinding and replay comparisons; P1 `BlockedActionRef` result and
external action-reference decoders; and public ConversationStreamEvent
ProviderTurnId fields. The evidence supports the Option A recommendation that
the current deterministic identities be formalized by a closed versioned
codec while preserving recognized legacy representations.

The exact recommended acceptance token is
`ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`. Option A's reviewed split is:
recognized deterministic composite V2 forms are the only new-write forms;
UUIDv7 IDs remain read/replay-only; existing rows and references remain
byte-identical with no normalization/backfill; and unknown encodings fail
closed. The exact composite grammar remains an owner-landing obligation.

The review initially found and the draft corrected two citation issues: the
overflow contract is DID v1.23 OVS-1…OVS-7 / §9.11A and migration 0020, not
DID §3.6; and the public ConversationStreamEvent / strict BlockedActionRef
codec consequences needed explicit replay coverage. Both were corrected and
reviewed again. Current text correctly distinguishes those observable and
persisted ID uses from the accepted P1 pre-intent proof, which remains an
internal structural tuple outside command serialization and the semantic
request fingerprint.

No `docs/design/**`, implementation, migration, database row, receipt, or
provider behavior was changed by the review. This proposal and review grant no
implementation authorization and do not resolve the accepted P10/P1 reader
blocker.
