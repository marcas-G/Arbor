# P7 — 02 Deliver Primitive

**Authority:** DID v1.10 §1.8 (Deliver primitive), §4.2, §5.3 (MessageSent), §8.15, §8.18; v1.10 G2; SD v1.3 §7.2, §7.5; P6 `02` (D2 continuation; kind-set expansion authorized by v1.10 G2), P6 `01` §3 (same-boundary wake precedent); `01` §3/§4 (ProduceDeliverable / SatisfyDependency), `04` §1 (coordinator); domain `communication.ts` / `scheduler.ts` (frozen shapes, extended at P7 implementation).
**Status:** DRAFT baseline from the P7 phase-scoped contract review; v1.10 G2 remains the base Deliver semantic owner. The AH10 DeliverMessage/1 Gateway, receipt and replay subsection below is an accepted DID v1.37 amendment; other unclosed P7 draft material is unchanged.

**Accepted owner amendment (DID v1.36 → v1.37): AH10 Deliver fence and
replay.** The accepted contract maps Deliver to a dedicated DeliverMessage/1
CommandGateway route without changing ordinary SendMessage/1. It adds no
Deliverable mutation, MessageSent event type/version, or Inbox kind. Accepted
proposal SHA-256:
`75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
The decision and owner landing audit are recorded in
`planning/results/AH10-deliver-generation-fence-governance.decision.md` and
`planning/results/AH10-deliver-generation-fence-design-landing.md`.

## 1. Primitive definition (G2 frozen)

```text
ProduceDeliverable  creates the Deliverable (result fact, source Work revision bound)   — `01` §3
Deliver             delivers an existing Deliverable, child → parent (formal handover)  — this doc
SatisfyDependency   changes Dependency state (matcher always authoritative)             — `01` §4
```

- `Deliver` is an independent communication/orchestration primitive — a **Message kind** — not a command that creates or changes a Deliverable. The accepted AH10 route uses a `DeliverMessage` CommandGateway envelope solely for generation fencing, immutable receipt and atomic Message/Event/Inbox commit; the envelope does not turn the Message into a Work/Deliverable canonical entity or add a Deliverable mutation.
- D2 continuation: **`Report` ≠ `Deliverable` is maintained** (P6 `02` §1). Report stays cognitive upward exposure and can never satisfy a Dependency; Deliver adds the formal handover channel Report deliberately lacks.
- Deliver is delivery, not matching: a Deliver message never satisfies a Dependency by itself (§7).

## 2. Message kind set: four → five

```text
Query | Reply | Report | DecisionRequest | Deliver      (P7 onwards; v1.10 G2)
```

- Domain `MESSAGE_KINDS` (`communication.ts`) is extended with `"Deliver"` at P7 implementation — the v1.10 authorization for evolving the P6 D2 frozen set.
- Semantics, correlation/causation rules, and urgency discipline of the existing four kinds are unchanged (P6 `02` §2); this is enumeration growth only.
- `InboxEntry.kind` is **not** extended (§5).

## 3. Deliver message payload

```ts
// OutboundMessage (P6 `02` §2) gains one discriminated field:
{
  readonly kind: "Deliver";
  readonly recipientWorkspaceId: WorkspaceId;   // must be the sender's direct parent (§4)
  readonly deliverableId: DeliverableId;        // required iff kind = "Deliver"; references an existing Deliverable
  readonly bodyRef: string;                     // bounded delivery summary — NOT the deliverable content
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly urgency: "Normal";
}
```

- `deliverableId` **references, never creates**: there is no "Deliver-and-create" combined shortcut; creation belongs solely to `ProduceDeliverable` (`01` §3, G2 division of labor).
- `bodyRef` is a bounded view of the handover (P6 `02` §2 discipline; DID §8.14); artifact content stays referenced through the Deliverable's artifact list (`01` §3), never inlined into the message.

## 4. `DeliverMessage` CommandGateway contract

P7 defines a distinct CommandType `DeliverMessage`, Handler `schemaVersion="1"`. It reuses the existing P1 CommandGateway fence/receipt pipeline and `SendMessageAuthority`; ordinary `SendMessage` v1 payload, handler, result decoder and receipts are unchanged. `DeliverMessage` has no External-origin route. The strict internal payload is:

```ts
{
  readonly messageId: MessageId;                 // stable across generations; caller-preallocated
  readonly senderWorkspaceId: WorkspaceId;       // exact executing Workspace; SendMessageAuthority-bound
  readonly deliverableId: DeliverableId;         // existing result reference, never created here
  readonly bodyRef: string;                      // bounded summary
  readonly correlationId?: string;               // v1 control route leaves absent/null
  readonly causationId?: string;                 // v1 control route leaves absent/null
}
```

`recipientWorkspaceId` is Runtime-derived from the sender's current direct-parent binding, never model-supplied. The handler sets `urgency="Normal"`. Closed fields/IDs and bodyRef length 1..4096 are strict-validated. All inherited P6 `02` §3 conditions apply to the derived Message (recipient exists, same Project, recipient Active, sender bound by `SendMessageAuthority`, bounded body). Added conditions:

| Condition | Rejection |
|---|---|
| `deliverableId` absent (structural) | decode / output-contract rejection (P3 `03` §3) |
| deliverable not found | `CommandRejection.DeliverableNotFound` (P7 frozen new enum, `01` §4) |
| sender Workspace ≠ Workspace owning `deliverable.sourceWorkId` | `DomainError.AuthorityDenied` |
| recipient ≠ sender's direct parent | `DomainError.AuthorityDenied` |

- **Direction (frozen definition)**: delivery is child → parent. The sender must be the Workspace owning the Work that produced the deliverable (`deliverable.sourceWorkId` → owning Workspace, resolved canonically, never model-asserted); the recipient must be that Workspace's direct parent. No grandparent, sibling, cross-subtree, or cross-Project delivery exists (same rule shape as Report/DecisionRequest in P6 `02` §3).

`DeliverMessageAuthority` is the existing trusted `SendMessageAuthority` fact projected for the exact `senderWorkspaceId`; it binds CommandId, semantic fingerprint and project in the usual Application command contract. P7 does not add a new authority hierarchy or grant External submission.

### Result and receipt

The strict Committed result is `{messageId, deliverableId, senderWorkspaceId, recipientWorkspaceId, admitted:true}`. Its v1 receipt decoder is registered under the exact `(DeliverMessage,"1")` pair. P1 `07` owns the Deliver AgentAction→DeliverMessage/1 route, generation-scoped CommandIds and receipt-first recovery. The P7 handler does not write a parallel effect receipt.

Message, MessageSent(v1), Inbox admission and the Committed `DeliverMessage` receipt commit in the same Gateway transaction. No `commands`, Message, or MessageSent schema change is introduced. Migration 0034 adds only the P9 DeliverReplay failure-fact table; historical direct-write Deliver facts without a receipt use P1/P9's one strict read-only adoption exception below and never receive a fabricated receipt.

### Events

```text
MessageSent(v1) {
  messageId, kind: "Deliver", sender, recipient, deliverableId,
  correlationId, causationId
}
```

For `DeliverMessage`, the event envelope uses the same `projectId`,
`aggregateRef=messageId`, `eventVersion=1`, `causedByCommandId=commandId`,
and `occurredAt=message.sentAt` as the committed command transaction. Generic
MessageSent variants remain unchanged. MessageSent is the sole durable
ChildDelivered wake source.

## 5. Inbox admission: kind "Message" (no InboxEntry expansion)

- Deliver lands in the existing `InboxEntry.kind = "Message"` member of the frozen set `"SpecialistSettled" | "Message" | "HumanInput" | "Governance"` (P6 InboxEntry). Admission stays upsert-by-key with `messageEntryKey(messageId)` (D3-generalized rule; at-least-once redelivery is a no-op).
- The **summary is exactly** `Deliver <deliverableId> from <senderWorkspaceId>`; it is projection text for cognitive triage, not canonical semantics.
- No new InboxEntry enum value is introduced; a Deliver entry stays distinguishable through its referenced message (kind + deliverableId).

## 6. Wake: `ChildDelivered` from the MessageSent consumer

```text
DeliverMessage transaction:
  MessageStore append + MessageSent(v1) + recipient Inbox admission
  + Committed DeliverMessage receipt
after commit:
  WorkflowSignalConsumer reads MessageSent + canonical Message
  → wakeSink(recipientWorkspaceId = parent, reason = ChildDelivered)
```

- "Successful Inbox delivery" = the DeliverMessage transaction committed with the Inbox admission persisted (P6 `02` §5 same-commitment shape; invariant-36 pattern).
- `ChildDelivered` already exists in the frozen `WakeReason` vocabulary (`scheduler.ts`; DID §8.18: "ChildDelivered is triggered by a successful Deliver Inbox delivery — v1.10 G2; P7 wires it").
- The unique committed `MessageSent` event is the only durable wake source. The command transaction writes no separate wake row or second wake payload. The existing WorkflowSignalConsumer reads this event after commit and reconstructs `ChildDelivered` from the canonical Message; the existing wake sink is idempotent under replay. P2 still owns durable WorkWait/timer mechanics; P7 owns the MessageSent→ChildDelivered source mapping.

## 7. Promotion: none — Deliver never satisfies

- The deterministic promotion set for Deliver is **empty**: no canonical Dependency consequence, no correlation closure (`promoteInboxArrival` grows a Deliver branch returning zero effects; the ChildDelivered wake is produced at the delivery boundary, §6, not by promotion).
- G2: Deliver is delivery, not matching. Satisfaction happens only through `SatisfyDependency` (`01` §4) with the structural matcher authoritative — requested either by the consumer-side agent or by the event-driven P7 coordinator (`04` §1), which reacts to `DeliverableProduced`, **not** to the Deliver message.
- The two channels are orthogonal and may land in any order: parent cognition (Inbox entry + `ChildDelivered` wake) and structural satisfaction (coordinator → SatisfyDependency) proceed independently. "Is the result sufficient for the parent's Work" is cognition (SD §7.5) expressed as new Work / Dependency / Steer (DID §8.16), never a promotion.

## 8. `Deliver` directive spec (§8.15)

```ts
interface DeliverDirectiveSpec {
  readonly deliverableId: DeliverableId;   // existing Deliverable, typically produced via ProduceDeliverable in the same Execution
  readonly bodyRef: string;                // bounded delivery summary
  readonly correlationId?: string;
  readonly causationId?: string;
}
```

- **Recipient is derived, never model-chosen**: the direct parent of the executing (sender) Workspace — deterministic structural computation.
- Directive handler validates deliverable ownership (source Work belongs to the executing Workspace), builds the `DeliverMessage` CommandGateway request (caller-preallocated stable messageId and generation-scoped commandId) with the existing `SendMessageAuthority` (P6 `02` §3), and returns `DeliverableDelivered(deliverableId, recipientWorkspaceId)`. The receipt stores exact result `messageId`, `deliverableId`, sender, recipient and `admitted=true`.
- Typical sequence: `ProduceDeliverable` (`01` §3) → `Deliver` (this doc) → coordinator / agent satisfaction path (`01` §4) — three steps, three separate facts (G2 division of labor).
- A Deliver rejection (deliverable not found, recipient terminal, …) is a directive execution result / model-visible observation, not an Execution failure (DID §8.15 result vocabulary).

## 9. Deliver vs Report

| Aspect | Report (P6 `02`) | Deliver (this doc) |
|---|---|---|
| Channel | Message kind (cognitive upward exposure) | Message kind (formal handover) |
| Direction | Child → Parent | Child → Parent |
| Payload core | bodyRef (cognitive content) | deliverableId reference + bodyRef summary |
| Canonical entity referenced | none (Report ≠ Deliverable, D2) | existing Deliverable (`01` §3) |
| Can satisfy a Dependency | No (D2, maintained) | No (G2: delivery ≠ matching; only SatisfyDependency + matcher, `01` §4) |
| Promotion canonical effect | none | none |
| Wake | ordinary Inbox arrival wake (InputArrived channel) | `wake(reason = ChildDelivered)` (§8.18; §6) |
| InboxEntry kind | "Message" | "Message" (no expansion, §5) |

## 10. Must Not Decide

- No command creates or changes a Deliverable (G2: Deliver references an existing result; `DeliverMessage` commits only its Message handover and delivery facts).
- No InboxEntry kind enumeration expansion (Deliver lands in "Message").
- No satisfaction semantics (matcher / SatisfyDependency owned by `01`; a Deliver message never changes Dependency state — §7).
- No modification of the existing four kinds' semantics / correlation / causation / urgency rules (P6 `02`; only the G2-authorized kind-set expansion).
- No Verification / quality judgment in the delivery path (P8).
- No cross-Project, sibling, grandparent, or cross-subtree delivery (direction frozen: child → direct parent).
- No wake mechanism / scheduler decision-table changes (P2 owns; this contract only produces the ChildDelivered signal at the delivery boundary).
- No artifact content / storage semantics beyond reference (bodyRef bounded view; Blob/Artifact separation, DID §7.8).
- No coupling of the Deliver message channel to the coordinator satisfaction channel (G5 event-driven; independent by construction, §7).
