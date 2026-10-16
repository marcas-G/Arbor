# F23 P6 UnboundLegacy Inbox mechanics — independent post-landing review

Date: 2026-10-17
Landing reviewed: `438572222cdaaa8424ac9c9aea6c8603d4557394`
Accepted proposal: `planning/proposals/F23-P6-unbound-legacy-inbox-mechanics-draft.md`
Accepted token: `ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`
Accepted proposal raw SHA-256: `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`

Status: **Blocking = 0; B1 = 0; B2 = 0.** This is an independent
post-landing consistency review of the accepted design package, not
implementation authorization.

## Review findings

- The proposal SHA was recomputed over the raw Git blob at the landing's
  parent and matches the accepted token record and DID v1.47 landing record.
- P6 reuses `Governance` and the exact stable key
  `retry-verification-unbound:<commandId>`; the typed
  `RetryVerificationUnboundLegacy` subtype is derived from the immutable
  disposition and canonical source facts. No Inbox-kind enum, Message,
  approval, Agent consumer, wake, or P10 Attention source was added.
- Current recipient and query visibility are re-evaluated from the disposition
  source Work/Verification plus current canonical Work/Workspace ownership and
  current P8 human authorization. Root-local and exact direct-Parent routes
  remain distinct; the stored Inbox `workspace_id` is only a projection, not
  authority. Reads are human-only, do not consume/ack/clear, and do not inspect
  or decode Command receipts.
- Owner/Parent route changes move the same stable key in the same P1 command
  transaction as the canonical change. `created_at` is preserved; real moves
  increment revision and update `updated_at` once; no-op reconciliation does
  not mutate them. Identity mismatch is corruption, not overwrite.
- When atomic route movement is unavailable, the route uses the existing P1
  Gateway terminal-rejection receipt/attempt path. Same CommandId/tuple replay
  returns that receipt; a different CommandId independently rejects. No
  pre-Gateway receipt read/rejection or asynchronous repair fact/window was
  introduced, and the rejection commits no canonical Work/Workspace/Event/
  Inbox/disposition mutation.
- Rebuild is disposition- and current-canonical-fact-based, independent of
  receipt decoding and Domain Event retention. UnboundLegacy replay remains
  generic current Resolver denial; the new inbox entry grants no replay
  authority.
- P1 `04` explicitly leaves the missing physical Inbox `revision` /
  `updated_at` columns, initial revision seed, and migration ID/name to a
  separately authorized implementation package. The landing adds no DDL,
  migration registration/execution, production implementation, tests, or
  online upgrade. No physical choice was silently made.
- Ownership and cross-references are coherent: DID v1.47 points to the
  decision/landing record; P6 `00/02/06` owns the entry semantics and
  acceptance story; P1 `01/03/04` owns Gateway/transaction/physical boundary;
  P8 `01/06` references the accepted P6 route without changing current-auth or
  replay rules; P12 `02/10` preserves current authorization and transport
  visibility. The unique P8 Story H route addendum is not duplicated.

The previous `F23-P6-unbound-legacy-inbox-mechanics-landing.review.md` is
labelled non-independent; this file is the separate independent review. No
tests were run because this landing changes design documents only.

## Boundary

The landing is consistent with the accepted proposal and may be treated as
formally landed at the design layer. This review does not authorize or qualify
the physical schema package, code, tests, migration registration/execution,
or any database upgrade; those remain separately gated.
