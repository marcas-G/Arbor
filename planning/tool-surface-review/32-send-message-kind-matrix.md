# SendMessage Kind Binding Matrix

**Date:** 2026-09-27
**Status:** Canonical communication semantics; no schema or implementation

This matrix covers P6's four cognitive Message kinds. P7 `Deliver` is listed
separately because it remains a distinct canonical Agent Action even though its
downstream durable record uses `SendMessage(kind=Deliver)`.

| Kind | Model-decided fields | Runtime-bound fields | Target rule | Correlation rule | Body persistence rule | Downstream effect | Failure semantics |
|---|---|---|---|---|---|---|---|
| `Query` | Authored body; discretionary recipient among the frozen authorized query set | Sender/principal/project; MessageId/CommandId; bodyRef; new correlation ID; causation when uniquely available; timestamps | Model selects an allowed Workspace. Runtime validates same Project, existence/lifecycle, and P6 query authorization. | Runtime creates a fresh correlation for this Query; it must not be model-generated. | Runtime stores body bytes through BlobStore before SendMessage and uses the returned content-addressed BlobRef. | MessageSent + Inbox admission + ordinary arrival wake; no canonical promotion. | Unauthorized or unavailable recipient rejects. Blob failure means no Message. Never substitute another recipient. |
| `Reply` | Authored body; exact Query target only when more than one eligible pending Query exists | Sender/project; target when uniquely derivable; recipient from target Query sender; MessageId/CommandId; bodyRef; correlation copied from selected Query; timestamps | One eligible Query → Runtime uniquely binds. Several → model selects exact existing Query `messageId`. Recipient is derived from that Query, not separately chosen. | Runtime resolves and copies the exact Query correlation. Successful Reply closes only that correlation. Missing/closed/stale target rejects; no redirect. | Same body-to-BlobRef flow. | MessageSent + Inbox admission + exact correlation closure; no other Query is changed. | No eligible Query or unresolved ambiguity fails closed. Closed/missing/wrong-target uses `AuthorityDenied`; operational lookup/storage failure is surfaced without sending. |
| `Report` | Authored body and report meaning | Sender/principal/project; direct-parent recipient; MessageId/CommandId; bodyRef; optional correlation/causation only when Runtime has a unique relation; timestamps | Always direct Parent. Model does not select another Workspace. | No correlation by default. Runtime binds an existing causal relation only when unique; otherwise omits it. | Same body-to-BlobRef flow. | MessageSent + parent Inbox admission + ordinary arrival wake; no canonical promotion and never Dependency satisfaction. | Missing/inactive Parent, body failure, or authority mismatch rejects. No recipient fallback. |
| `DecisionRequest` | Authored bounded question/request content | Sender/principal/project; direct-parent recipient; MessageId/CommandId; bodyRef; optional unique correlation/causation; timestamps | Always direct Parent under P6. Model selects the question, not the governance destination. | Optional only when Runtime can bind an exact existing decision conversation. Runtime does not fabricate a model-selected correlation. | Same body-to-BlobRef flow. | MessageSent + parent Inbox admission + parent runnable reevaluation. It does not grant authority or record a decision. | Missing/inactive Parent or invalid body rejects; no auto-approval, recipient fallback, or permission expansion. |

## P7 `Deliver` binding crosswalk

| Agent Action | Model-decided fields | Runtime-bound fields | Durable Message form | Effect |
|---|---|---|---|---|
| `Deliver` | Existing `deliverableId`; authored bounded handover summary | Source Workspace from current execution; direct Parent recipient; MessageId/CommandId; bodyRef; timestamp; correlation/causation only when uniquely bound | `SendMessage(kind=Deliver, deliverableId, bodyRef, recipient=directParent)` | MessageSent + Parent Inbox admission + `ChildDelivered` wake. It does not satisfy a Dependency. |

The authored summary is body content, not a reference. Communication Runtime
persists it to BlobStore first. The model selects an existing Deliverable; it
does not choose the recipient, producer Workspace identity, target Dependency,
IDs, or satisfaction outcome.

## Frozen-source mapping

- P6 `Query`, `Reply`, `Report`, and `DecisionRequest` kinds and base rules:
  `docs/design/implementation/P6/02-communication-protocol.md` §§1–5.
- P7 `Deliver` is a fifth Message kind, references an existing Deliverable,
  derives the direct Parent, and does not satisfy a Dependency:
  `docs/design/implementation/P7/02-deliver-primitive.md` §§2–9.
- The ConsumerExecution `SatisfyDependency` request is a separate action path;
  it is never implied by `Deliver` (`P7/01` §4; `P7/04` §5).
