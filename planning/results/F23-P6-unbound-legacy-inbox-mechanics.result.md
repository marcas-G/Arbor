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

The supplemental proposal recommends a stable `RetryVerificationUnboundLegacy`
entry keyed by CommandId, routed to the current P8 governance Workspace,
queried only with current human authorization, read-only/non-consuming, and
rebuildable from the immutable P1 disposition row. It includes no Agent
promotion, new action, P10 Attention source, receipt disclosure, or replay
authority. It is a recommendation only; no design file currently records those
specific mechanics as accepted.

The proposed exact token is
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`. Its acceptance
would authorize only fixed P6/P8/P1 design-document landing and consistency
review. Production implementation, DDL, migration registration/execution,
tests, and online upgrade require separate authorization.

No code, test, schema, production behavior, or `docs/design/**` was changed
for this supplemental proposal. Raw SHA-256 of the proposal is recorded after
the text is finalized: `784D1F32383998C7FDFE2DA25095C0E91EAC33281305A7BE8E1AFA31D6C7CAB6`.
