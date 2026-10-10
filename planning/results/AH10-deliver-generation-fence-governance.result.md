# AH10 Deliver generation fence — proposal preparation result

Date: 2026-10-10

Status: **fixed governance draft prepared; awaiting manual decision; implementation not authorized**

Base: `6fcbc17e27b694f201792aedd6c2ec368508b542`

Proposal: `planning/proposals/AH10-deliver-generation-fence-governance-draft.md`

SHA-256: `E25A5FC6B14EB9F46A9A2381E70678E878577F9FFD54BA47B7D9D6409BA33AC4`

Suggested acceptance marker: `ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

## Work performed

The proposal compares three fixed routes: existing SendMessage CommandGateway/P1 takeover; a separate Runtime transaction fence and receipt; and allowing stale generations to deliver. It recommends reusing the existing `SendMessage(kind=Deliver)` command and P1 receipt-first mechanism. The fixed package retains P7's Message handover semantics and no-new-Deliverable-Command constraint, and specifies stable MessageId, generation-scoped CommandId, receipt ownership, Action Observation ownership, old-generation rejection, new-generation takeover, pre/post-commit crash cases, and pre-Gateway legacy evidence handling.

The recommendation is based on P7 `02` §6/§8, which already places Message, MessageSent, Inbox admission and ChildDelivered wake at one delivery boundary and specifies a SendMessage command with existing SendMessageAuthority; P1 `07` §1–§3 supplies cross-generation identities and receipt-first recovery. The frozen DID stale-Worker fence (concretized by P2 `03`) makes the late-communication route inconsistent absent a reopened owner contract. P9 owns resumable Action/Observation recovery. P17 owns HumanMessage ResponseJob delivery and is unchanged.

## Evidence and limits

The source result `planning/results/AH10-deliver-generation-fence.review.md` records the existing isolated pending test's prior run: one expected stale-generation failure and one same-MessageId replay failure. The stale gen0 handler successfully wrote one Message, one MessageSent and one Inbox row after gen1 acquired the lease. The second attempt failed on the Message primary key; this is not replay success. That test did not run the WorkflowSignalConsumer, so it did not establish actual wake scheduling.

This worktree is based on the requested candidate. No test, build, lint or full gate was run in this task; the existing pending RED was read only. No production file or `docs/design/**` file was changed. The prepared proposal is neither accepted governance nor implementation authorization. A separate post-landing consistency review and explicit implementation authorization remain required before implementation.

The current-generation stale-write defect does not block normal single-daemon local preview, but it blocks claiming safe generation takeover. A pre-existing direct Deliver that committed its facts before the Action Observation and lacks a Gateway receipt is a distinct historical recovery case, explicitly bounded in the proposal.
