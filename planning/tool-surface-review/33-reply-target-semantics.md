# Reply Target Semantics

**Date:** 2026-09-27
**Status:** Canonical target-selection rule; no model-facing schema

## Canonical identity

The canonical Reply target selector is the existing `MessageId` of the Query
being answered (`queryMessageId`). This is the exact source record the model
can select from its context. The Runtime resolves that Query and derives the
associated `correlationId` and recipient.

The model selects an existing identity; it never creates a MessageId or
correlationId. This preserves P6's rule that Communication Runtime allocates
and validates correlation metadata (`docs/design/implementation/P6/02-communication-protocol.md`
§2).

## Eligible Query definition

A Query is eligible when all are true:

1. the exact Query Message exists;
2. its recipient is the Workspace of the current execution;
3. its correlation is still open and has not been answered;
4. it belongs to the same Project and its sender is an authorized Reply
   recipient;
5. it is presented in the current context as an unresolved Query with its
   existing `messageId`.

Runtime presents enough bounded context to distinguish pending Queries and
includes each exact Query `messageId`. If the model-visible context omits that
identity, a multi-Query Reply is not admissible; Runtime must request a fresh
turn with the target identities or fail closed. No new durable handle is
introduced.

## Selection cases

| Situation | Binding rule |
|---|---|
| Exactly one eligible Query | Runtime binds that Query and supplies its correlation/recipient. No model selector is required. |
| More than one eligible Query | Model must select one exact `queryMessageId` from those presented. The selected Query alone determines correlation and recipient. |
| Explicit selector when only one Query exists | Accept only if it names that exact eligible Query; a mismatching selector is rejected. |
| No eligible Query | Reject Reply; uncorrelated Reply is forbidden. |
| Selector is absent with multiple Queries | Reject as ambiguous; do not choose by recency, arrival order, or semantic similarity. |

## Stale, missing, and concurrent targets

- A missing, closed, answered, wrong-recipient, wrong-project, or non-Query
  target fails closed using the existing `AuthorityDenied` failure semantics.
- Do not silently select another pending Query.
- A race in which another valid Reply closes the target before this command
  commits results in rejection against the now-closed correlation. It does not
  reopen or redirect the Reply.
- Reply validation, message append, Inbox admission, and correlation closure
  occur in the same SendMessage command transaction. The transaction's
  serialized state check ensures at most one successful Reply closes a
  correlation.
- A transport/operational failure before authoritative command resolution may
  retry with the same command identity; it is not converted into a new target.

The current `SendMessage` handler already rejects a closed correlation rather
than redirecting it (`packages/application/src/commands/send-message.ts`,
Reply branch). This closure additionally states how the model selects the
exact source Query when multiple are pending.

## Semantic preservation

```text
selected queryMessageId
  → Runtime loads that exact Query
  → Runtime derives its correlationId and original sender
  → SendMessage(kind=Reply, recipient=Query.sender, correlationId=Query.correlationId)
  → successful promotion closes that same correlation
```

No other Query may be closed or answered by that Reply.
