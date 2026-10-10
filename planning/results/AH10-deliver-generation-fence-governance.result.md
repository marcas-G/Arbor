# AH10 Deliver generation fence — proposal preparation result

Date: 2026-10-10

Status: **fixed governance draft revised for second review's remaining items; awaiting re-review and manual decision; implementation not authorized**

Base: `6fcbc17e27b694f201792aedd6c2ec368508b542`

Proposal: `planning/proposals/AH10-deliver-generation-fence-governance-draft.md`

SHA-256: `1E511F11CCD4002C7DF4850DC2EC4BAFBC0DC0B2FDE1F2EB294490F5849F5269`

Suggested acceptance marker: `ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

## Work performed

The proposal compares three fixed routes: a new Deliver→DeliverMessage CommandGateway mapping with P1 takeover; a separate Runtime transaction fence and receipt; and allowing stale generations to deliver. It recommends the Gateway mapping, while explicitly stating that P7 specifies a SendMessage command but does not freeze its Gateway route. The new command only delivers an existing Deliverable as a Message; it does not create or mutate a Deliverable. Ordinary SendMessage v1 and its receipts remain unchanged.

The revision defines a DeliverMessage v1 Gateway handler and strict request/result decoders without widening the ordinary SendMessage command route. It requires `deliverableId`, canonical source Work ownership, direct-parent recipient, exact MessageSent Deliver payload, fixed Inbox summary, stable cross-generation MessageId, legacy gen0 `deliver-command` ID, and generation-scoped newer CommandIds. The existing SendMessage v1 handler/decoders/receipts remain unchanged; DeliverMessage has its own v1 receipt decoder.

The recovery priority table now checks an exact DeliverMessage receipt before considering legacy canonical facts. It defines Committed+matching effect as convergence, Committed+missing/mismatched effect as Action Required, FencingRejected+any effect as a contradiction, no receipt as the only entry to legacy proof, and operational failure as same-CommandId retry only with no effect evidence. Event proof explicitly checks project, aggregate, event type/version, complete Deliver payload and the deterministic legacy `caused_by_command_id`; a mismatch maps to `LegacyMessageBindingMismatch`. If an Inbox row remains, it must match recipient, `msg:<messageId>` key, Message kind, fixed summary, null correlation and the event timestamp; an absent row after consumption/projection cleanup is allowed.

The new P9 failure source is fully defined as `deliver_replay_attention_facts` plus `DeliverReplayEscalated` v1: fields, failure enum, stable fact identity, tuple uniqueness, event payload/refs, current-owner behavior, same-transaction fact+event atomicity and retry behavior are specified. P10 projection is fixed to ActionRequired, the Execution Workspace, `attentionFactId` deduplication, a safe summary, row+offset atomicity, source-fact rebuild and restart behavior. No code or design files were changed.

Wake language was corrected: committed `MessageSent` is the only durable source; the WorkflowSignalConsumer derives ChildDelivered and uses the existing wake sink. The command does not write a wake row.

## Evidence and limits

The source result `planning/results/AH10-deliver-generation-fence.review.md` records the existing isolated pending test's prior run: one expected stale-generation failure and one same-MessageId replay failure. The stale gen0 handler successfully wrote one Message, one MessageSent and one Inbox row after gen1 acquired the lease. The second attempt failed on the Message primary key; this is not replay success. That test did not run the WorkflowSignalConsumer, so it did not establish actual wake scheduling. The proposal corrects the prior mistaken description that P7 already froze a Gateway mapping.

This worktree is based on the requested candidate. No test, build, lint or full gate was run in this task; the existing pending RED was read only. The existing pending RED remains excluded from default tests. No production file or `docs/design/**` file was changed. The prepared proposal is neither accepted governance nor implementation authorization. A separate post-landing consistency review and explicit implementation authorization remain required before implementation.

The current-generation stale-write defect does not block normal single-daemon local preview, but it blocks claiming safe generation takeover. A pre-existing direct Deliver that committed its facts before the Action Observation and lacks a Gateway receipt is a distinct historical recovery case, explicitly bounded in the proposal.

Revision base commit: `9a3bee876150029138b62f20dd80f1342d088271`.

## Exact revision for independent review

- P7 Gateway mapping is now explicitly proposed as new governance semantics, not described as already frozen.
- DeliverMessage v1 handler/codec/schema, Deliverable ownership enforcement, event fields, Inbox summary, legacy direct-write handling, MessageId/CommandId derivation and receipt/result binding are explicit; ordinary SendMessage v1 remains unchanged.
- Legacy failure now has a complete P9 fact/event contract and P10 public Attention projection/rebuild/atomicity contract; no landing-time semantic choice remains.
- Route references use `DeliverMessage/1`. Receipt-before-proof precedence, legacy MessageSent command binding and optional-but-exact Inbox validation are explicit.
- `MessageSent` is the sole durable wake source; no wake row is part of the Command transaction.
