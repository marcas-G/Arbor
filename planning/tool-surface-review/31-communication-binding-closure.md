# Communication Binding Semantic Closure

**Date:** 2026-09-27
**Status:** Semantic closure for canonical communication; no v2 schema,
production code, Prompt, or frozen source contract changed

## Decision

The canonical communication boundary is:

```text
Agent semantic intent
  { kind, authored body, discretionary target / exact Reply target }
        ↓
Communication Runtime binding
  { sender, MessageId, CommandId, bodyRef, correlation, causation }
        ↓
P4 BlobStorePort.put(UTF-8 body bytes)
        ↓
P6 SendMessage command with resolvable bodyRef
        ↓
one control-DB transaction:
  MessageStore + MessageSent + Inbox admission + promotion
```

The model supplies message meaning and text content. It does not supply a
durable content reference, sender identity, generated message/command IDs, or
Runtime-owned correlation metadata.

For a message body, `bodyRef: ContentRef` resolves to the P4
content-addressed `BlobRef`. It is not an `ArtifactId`; the durable Message
stores the Blob reference and `BlobStorePort` resolves its bytes. This uses the
existing P4 `BlobRef` contract without adding an Artifact metadata record for
every short communication body.

## G-C1 — Body and reference

P6 freezes `OutboundMessage.bodyRef` as a `ContentRef` whose body is stored in
Artifact/Blob and whose model context uses a bounded view
(`docs/design/implementation/P6/02-communication-protocol.md` §2). P4 assigns
content bytes to `BlobStorePort`, defines `BlobRef` as content-addressed, and
exposes `put(bytes) → BlobRef` / `get(ref)` (`docs/design/implementation/P4/07-blob-artifact.md`
§§1–2). P14 independently uses a `ContentRef` for human-authored body bytes
stored in Blob (`docs/design/implementation/P14/01-human-message.md` §§1, 4).

Therefore:

- Model output is bounded authored body text, encoded as UTF-8 by Runtime.
- No structured body shape is frozen for Query, Reply, Report, or
  DecisionRequest; kind and routing carry the structured semantics.
- The model must not invent or echo a `bodyRef`.
- Communication Runtime calls `BlobStorePort.put` and receives the
  authoritative content-addressed `BlobRef`.
- Successful `put` is the durability point: a subsequent `get(ref)` must
  resolve the exact bytes, including after process restart.
- Runtime verifies the returned reference is resolvable before submitting the
  durable Message. A Message may not be committed with an absent, unresolved,
  or wrong-content reference.
- P6's sender upload/body bound still applies. This review does not invent a
  new limit.

## Authoritative persistence point and failure boundary

The P4 BlobStore is authoritative for body bytes and the content reference.
The P6 `SendMessage` command boundary is authoritative for the durable
communication record.

The two stores do not share a transaction. The required order is:

1. Persist the exact body bytes through `BlobStorePort.put`.
2. Receive and verify the `BlobRef`.
3. Construct `OutboundMessage` with that reference and Runtime-bound fields.
4. Submit `SendMessage`.
5. P1 CommandGateway atomically commits the MessageStore append, `MessageSent`,
   recipient Inbox admission, and deterministic promotion in one
  control-database transaction (P6 `02` §§3–5; P1 `03` §§1, 3.1).

Failure behavior:

- Blob write or reference verification failure: do not submit `SendMessage`;
  therefore no `MessageSent`, Message row, Inbox entry, or correlation effect
  exists.
- Crash after Blob write but before the SendMessage transaction: an unreferenced
  content-addressed blob may remain. It is harmless and can be collected only
  while unreachable.
- SendMessage rejection: no Message or Inbox admission is committed; the body
  Blob is an orphan and must not be treated as a sent message.
- Successful SendMessage: `bodyRef` is already resolvable before the
  transaction begins and remains a reachability root for the Blob. Any future
  garbage collection must retain content referenced by a durable Message.
- A committed Message with an unresolvable `bodyRef` is forbidden.

The control transaction does not atomically include the Blob write. Ordering,
content addressing, exact-command replay, and reference reachability provide
the required no-dangling guarantee without claiming cross-store atomicity.

## Retry and idempotency

P1 defines `commandId` plus the semantic request fingerprint as the durable
idempotency identity: same command ID and fingerprint returns the prior
receipt; a changed fingerprint under the same ID is `IdempotencyConflict`
(`docs/design/implementation/P1/01-command-contracts.md` §§3, 8 and
`03-transaction-model.md` §§3.1–3.4). P6 requires caller-preallocated
`messageId` and `commandId`, and Inbox admission is upsert-by-messageId
(`P6/02` §§3–4).

The closure requires P6 Communication Runtime to persist an outgoing-intent
binding once per logical model-action occurrence, before body upload or command
submission. Its idempotency key is the already persisted `ProviderTurnId` plus
the canonical output position within that turn. The binding retains the
semantic-intent digest, caller-preallocated `messageId` and `commandId`, and,
once available, the `bodyRef` and correlation metadata.

On replay of the same occurrence, Communication Runtime loads that binding
and reuses the same IDs, content, reference, and semantic fingerprint. The
successful SendMessage transaction also records the outgoing intent as
committed; a crash after command commit but before the caller observes success
is reconciled from the existing CommandReceipt. A different semantic intent
gets a new occurrence key and IDs.

Consequences:

- Repeating `BlobStorePort.put` with identical bytes yields the same
  content-addressed `BlobRef`; it does not create another body identity.
- Retrying SendMessage with the same IDs and fingerprint returns the original
  receipt, so it cannot append a second Message or duplicate Inbox admission.
- Retrying body persistence before Message commit resolves to the same
  content-addressed reference; the outgoing-intent binding prevents a retry
  from silently substituting different content under the same message identity.
- A crash after body persistence but before command submission may leave an
  orphan Blob, but not a duplicate durable Message.
- A crash after command commit but before observing its result replays the same
  command and receives the committed receipt.
- If body or kind/target changes, it is a new semantic intent and cannot reuse
  the old command ID/fingerprint.

## G-C2 — Reply target binding

The exact target selector is the existing `MessageId` of the Query being
answered. It is not a new semantic handle and is not a correlation ID invented
by the model.

- One eligible pending Query: Runtime binds it uniquely; the model need not
  repeat its opaque ID.
- Multiple eligible pending Queries: the model must select the exact
  `queryMessageId` presented with each pending Query in its context.
- Runtime resolves that Query record and derives its correlation ID and
  original sender/recipient relation. The model does not supply the
  correlation ID or recipient.
- Closed, missing, non-Query, wrong-recipient, or otherwise stale target:
  reject the Reply with the existing fail-closed `AuthorityDenied` semantics.
  Never select another Query as fallback.
- No eligible pending Query: Reply is rejected. No uncorrelated Reply is
  admitted.

P6 already requires Reply correlation and closes that correlation on successful
Reply promotion (`P6/02` §§2, 4); the source Query `messageId` provides the
unambiguous selection key when there is more than one open interaction.

## Canonical invariant

For an intent `(kind, selected target, body)`:

- Runtime may add only generated identity, sender/authority facts, timestamp,
  `bodyRef`, and correlation/causation that P6 assigns to Runtime.
- Runtime must preserve the selected kind, body bytes, discretionary Query
  recipient, selected Reply Query, and Deliverable reference.
- Every committed body reference and Reply correlation must resolve.
- Any missing, stale, or ambiguous required binding fails closed; Runtime must
  not infer a body, change a kind, choose a discretionary recipient, or redirect
  a Reply.

## Evidence anchors

- P6 Message kinds, ContentRef, SendMessage, Inbox, and correlation:
  `docs/design/implementation/P6/02-communication-protocol.md` §§1–5.
- P4 content-addressed Blob lifecycle:
  `docs/design/implementation/P4/07-blob-artifact.md` §§1–5.
- P1 command identity/replay:
  `docs/design/implementation/P1/01-command-contracts.md` §§3, 8 and
  `03-transaction-model.md` §§1, 3.
- P7 Deliver → SendMessage and parent derivation:
  `docs/design/implementation/P7/02-deliver-primitive.md` §§3–8.
- Implementation corroboration only: `packages/application/src/commands/send-message.ts`
  validates Reply correlation and performs Message append, event, Inbox
  admission, and promotion in one gateway transaction. No production code was
  changed by this review.

## Closure result

```ini
body_reference_owner = P4_BLOBSTORE
message_commit_owner = P6_SENDMESSAGE_COMMAND
reply_target_identity = EXISTING_QUERY_MESSAGE_ID
retry_identity = PERSISTED_LOGICAL_ACTION_BINDING + P1_COMMAND_ID_FINGERPRINT
communication_semantic_gaps = 0
```
