# F23 P6 UnboundLegacy Inbox Mechanics — Supplemental Proposal Record

状态：**Supplemental P6 design proposal pending; no P6 mechanics accepted or landed**

This document accompanies
`planning/proposals/F23-P6-unbound-legacy-inbox-mechanics-draft.md`. It
separates the accepted P8 origin package's high-level human-only/queryable
`UnboundLegacy` Inbox requirement from the previously unaccepted P6 mechanics.

## Scope

The accepted P8 package fixes permanent origin fields, current-authorized P8
replay, evidence-gated legacy backfill, preserving old receipts, a durable
`UnboundLegacy` disposition, and a human-only queryable P6 Governance Inbox
item. It did **not** fix that item's key, recipient mapping, query visibility,
consumption/acknowledgement, or projection rebuild. The `c4f558ec` landing
initially wrote those P6 details as fixed (`retry-verification-unbound:` key,
Root/direct-Parent recipient, read-not-consume and rebuild from disposition)
without separate P6 acceptance. The subsequent B1 correction restores those
details to owner-gated/TBD in P6 `02`, P1 `04`, P8 `01`, DID v1.46 and the P8
landing decision/review records.

## Recommended package and verification

The B2 proposal now includes source WorkId/VerificationId in the durable
UnboundLegacy disposition so Inbox rebuild never depends on or decodes the
permanent receipt. It recommends a stable
`RetryVerificationUnboundLegacy` key by CommandId, with a recipient dynamically
derived from current canonical Work/Workspace and P8 governance facts rather
than stored as an immutable snapshot. Route changes move the same key; the old
recipient loses visibility as soon as current authorization changes, and the
new recipient sees the item after same-transaction route update or durable
required reconciliation. It also fixes timestamp/revision behavior,
read-only/no-consume semantics, and current-route rebuild/upsert. These are
recommendations only; no design file records these mechanics as accepted.

The proposed exact token is
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`. Its acceptance
would authorize only fixed P6/P8/P1 design-document landing and consistency
review. Production implementation, DDL, migration registration/execution,
tests, and online upgrade require separate authorization.

No code, test, schema, production behavior, or `docs/design/**` was changed
for this supplemental proposal. Raw SHA-256 of the proposal is recorded after
the text is finalized: `61372B11E729245A3C972190AD1C4FC8E3B967475FC42FC56A5B6437C7C09235`.
