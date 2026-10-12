# P38 → P39 Executable Approval Receipt Handoff Dependency

**Status:** Proposed owner/governance clarification; no new semantics accepted
**Source baseline:** `ed5fba00ee60e169cadf0df12395179862abd1e8`
**Related accepted records (per P39 closure audit):** AH7-DG-02 D0A
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` and
P39 physical supplement D2FF
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P39 implementation, migration, tests, and release remain separately gated.

## Evidence

1. P38's existing port declares
   `ExecutableApprovalConsumptionReceipt` in
   `packages/ports/src/executable-approval.ts`. The immutable result contains
   `approvalId`, `preConsumeRevision`, `consumedRevision`, `approvalDigest`,
   exact `binding`, `expiresAt`, and `consumedBy`.
2. SQLite `consumeApproved` returns that receipt inside the caller's existing
   `TransactionScope` in `adapters/persistence-sqlite/src/executable-approval.ts`.
3. The P4 Runtime calls `consumeApproved` inside the same fenced transaction as
   ToolInvocation intent admission in `packages/tool-runtime/src/runtime.ts`,
   but reduces the successful value to `Claimed`. The receipt is not passed to
   the P4 invocation/recovery store or persisted for later exact replay.
4. The P39 closure plan records that accepted RecoveryBinding V1 is an
   immutable canonical JSON + SHA binding and that P39 implementation is
   separately gated. Its existing implementation checkpoint expects a V2
   visibility-scope value which is absent from accepted V1; that V2 scope
   proposal remains unaccepted. This proposal does not treat the V2 work as
   authorized.

## Gap / dependency

The P38 runtime already commits the approval consumption and ToolInvocation
intent atomically, and it computes an exact receipt, but no current durable
record ties that committed approval proof to post-crash RecoveryBinding replay.
P4's frozen approval text fixes intent/approval claim atomicity and
single-consumption, while the current P39 implementation checkpoint is not
authorized to add or infer receipt fields. The owner boundary and serialization
of the P38 receipt inside accepted RecoveryBinding V1 therefore need to be
confirmed before the P38/P39 joint recovery seam can be implemented or claimed
closed.

This is an implementation-contract dependency, not authority to edit
`docs/design/**`, add a RecoveryBinding V2 field, or create an auxiliary ledger.
No code change is requested by this note.

## Exact decision requested

Confirm one of the following against the accepted D2FF owner text:

1. **V1 includes the existing P38 receipt.** Name the canonical binding field
   and its exact serialization/validation rule, then issue the separate P39
   implementation authorization. P39 can then atomically persist the exact
   receipt with the existing RecoveryBinding V1 row in the P4 claim
   transaction; receipt mismatch or write failure rolls back both consumption
   and claim. Replay verifies the stored same-invocation receipt without
   re-consuming or re-authorizing.
2. **V1 does not include the receipt.** Identify the owning document and
   propose the smallest fixed contract landing that authorizes the required
   receipt handoff. Keep P38's existing consume receipt and atomic claim intact
   while that manual decision is pending.

In either case, do not implement the unaccepted visibility-scope V2 proposal or
alias a target-resource digest to query visibility scope. P38 process tests may
qualify P38's own pre-effect and post-effect crash behavior, but must mark the
durable RecoveryBinding receipt assertion BLOCKED until this dependency is
resolved and P39 implementation is authorized.
