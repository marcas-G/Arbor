# F23 / P8 RetryVerification Permanent Replay Authority — Design Gap Proposal

状态：**DRAFT — Design Gap evidence only; not accepted and not implementation authorization**

## Problem statement

Commit `bee70f2a58f3c42610fa245adb4d8dd9f9e06b68` corrected the external
command ordering required by DID §4.1B, P1 `01` §3 / `03` §3.1, and P12 `02`
§2 / `10` §3: external Resolver visibility precedes Gateway invocation, and
the Gateway's `BEGIN IMMEDIATE` transaction is the sole receipt lookup and
linearization point. No external receipt pre-read remains, including for
`RetryVerification`.

The correction exposes an unresolved P8 interaction. After a successful
`RetryVerification`, the old Verification is durably `Concluded(Unknown,
Orphaned)`. A same-CommandId, same-payload public retry reaches the real
production Resolver first, which currently requires that source Verification
to remain Open; it therefore returns HTTP 403 `authority/denied` before
Gateway can return the permanent original receipt. The isolated public-process
reproduction and exact output are recorded in
`planning/results/F23-retry-verification-permanent-replay.result.md`.

P8 `01` §3A and `06` Story H require exact CommandId replay to return the same
successor Verification/Execution IDs and receipt; the clauses state no replay
expiry. P1 `04` §6 says Commands are never hard-deleted, while Domain Events
may be hard-deleted after a deployment-configured retention horizon. The
current durable Verification and `verification_executions` rows have no
originating CommandId or retry-handoff binding. `domain_events.caused_by_command_id`
is the only existing causal link for `VerificationConcluded` and
`VerificationStarted`, and that evidence is retention-bounded. Thus an event-
only Resolver candidate cannot guarantee P8 replay for the permanent lifetime
of a Command receipt.

Conversely, issuing a replay-only Resolver authority merely because the old
Verification is Orphaned would admit arbitrary CommandIds to Gateway. Even if
the absent-receipt path later fails its final authority check, the Gateway
response can distinguish receipt presence and becomes an idempotency/receipt
existence probe. Do not implement that state-only shortcut.

## Gap

The frozen contracts require all four properties simultaneously:

1. Exact P8 retries replay the original receipt without a stated expiry.
2. External Resolver visibility succeeds before Gateway can inspect a receipt.
3. Gateway `BEGIN IMMEDIATE` is the only Command receipt lookup and tuple
   comparison point; mismatches are decided before JSON decode.
4. Domain-event causality is retention-bounded, but Command receipts are
   permanent; the schema has no permanent, non-receipt retry-origin binding.

No current non-receipt source proves indefinitely that a candidate CommandId
is the command that created a particular P8 orphan handoff. P8 replay therefore
cannot both preserve the permanent receipt contract and avoid granting a
receipt-existence probe. This is a design gap; no owner document is changed by
this proposal.

## Minimal candidate direction for governance

Consider an immutable P8 retry-handoff binding written atomically with the
old Orphaned conclusion, successor Verification, spawn intent, and Gateway
receipt. A possible relation keyed by `command_id` would durably bind:

- command/project/actor and exact semantic fingerprint, Handler schema
  version, and fingerprint algorithm version;
- source Work, source Verification, target Work revision, and the exact
  settled/bound verifier Execution IDs;
- successor Verification and verifier Execution IDs;
- binding version and immutable creation identity.

The Resolver would query this narrow binding store, never CommandStore. It
would re-evaluate current authentication, Work visibility, and current human
governance authority against the bound source, then issue a distinct
replay-candidate authority only for that durable originating CommandId. The
RetryVerification handler must not accept that tag. Gateway remains unchanged:
inside its transaction, exact tuple returns the original receipt, tuple
mismatch returns existing `IdempotencyConflict` without decoding either JSON
column, and an absent receipt fails final authority without invoking the
handler. The binding must be immutable and retained for at least the lifetime
of its permanent Command receipt; event pruning must not affect replay.

The proposal intentionally does not settle whether this is a new table,
extended Verification record, or a P8-owned store abstraction. It also does
not assign a migration number, register a migration, or authorize online DB
upgrade. Governance must decide migration compatibility, table constraints,
writer ownership, and current-visibility behavior before implementation.

## Required fail-closed and atomicity decisions

- Legacy P8 receipts without a provable permanent binding must not be
  reconstructed from untrusted receipt JSON, Session text, or pruned history.
  Governance must decide whether available event pairs permit a one-time
  bounded backfill and what happens to unprovable old receipts; without that
  decision, no migration/backfill is authorized.
- A missing, duplicate, malformed, conflicting, wrong-project, wrong-actor,
  wrong-source, or wrong-successor binding grants no replay authority.
- A different CommandId for the same source has no matching origin binding
  and must fail before receipt-dependent response behavior.
- The same originating CommandId with a changed tuple may pass only the
  original source's current visibility/owner check; Gateway must then return
  the existing non-disclosing tuple-mismatch receipt without decoding JSON.
  A changed target/project or unauthorized principal must not use the binding
  to cross a visibility boundary.
- The binding, source conclusion, successor creation, spawn intent, and
  receipt share the existing command transaction. Crash before commit leaves
  none; crash after commit allows exact replay. No second successor/event or
  verifier spawn is created by replay.

## Qualification required after governance

1. Store/schema tests: uniqueness, immutable exact tuple, foreign keys,
   retention-independent preservation, malformed/duplicate rows fail closed.
2. Resolver tests: exact owner-authorized historical replay passes; changed
   project/actor/source/target and arbitrary CommandId do not obtain the
   replay tag; child Work requires exact Parent-human governance; Agent grants
   never qualify.
3. Gateway tests: exact tuple returns the original receipt; corrupt/wrong-
   shape stored JSON on a mismatch is never decoded; changed tuple takes the
   existing conflict path; missing receipt with replay-only authority cannot
   invoke the handler or write a successor.
4. Real public-process P8 Story H: first retry commits; same CommandId and
   payload returns byte/equivalent receipt and IDs without additional
   Verification, execution, event, or spawn; changed payload and wrong target
   fail closed; unauthorized actor cannot observe the receipt; arbitrary new
   CommandId is denied without a receipt-existence distinction.
5. Atomicity/recovery: inject crashes before and after the transaction commit;
   prove binding + source conclusion + successor + intent + receipt are all
   absent before commit and all present after commit.
6. Retention qualification: prune the corresponding Domain Events after the
   configured horizon and still prove exact receipt replay from the durable
   binding. Do not use a retention-window-only test as proof of permanent
   replay.

## Acceptance boundary

This proposal only records the gap and a candidate design direction. It does
not modify `docs/design/**`, alter schema/runtime behavior, register a
migration, or authorize implementation. Suggested exact future token:
`AUTHORIZE_P8_RETRY_VERIFICATION_PERMANENT_REPLAY_BINDING_IMPLEMENTATION`.
