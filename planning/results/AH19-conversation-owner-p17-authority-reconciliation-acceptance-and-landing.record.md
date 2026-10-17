# AH19 Conversation owner × P17 authority reconciliation — acceptance and landing

Status: **Accepted design reconciliation landed. Revised production
implementation is not authorized.**

## Decision and provenance

- Acceptance token:
  `RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY`.
- Accepted proposal:
  `planning/proposals/AH19-conversation-owner-p17-authority-reconciliation-draft.md`.
- Accepted proposal raw-byte SHA-256:
  `92EF668AFFBE3A5D1C651107C33006C7CB987E7021FFFC02037B3603FD276B75`.
- Accepted and landed: 2026-10-18.
- Landing baseline: `d348c541488d31acbabffd7e661a41e2e3080c4c`.
- Original implementation token:
  `AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`, issued
  2026-10-17 for the pre-reconciliation fixed plan
  `C642BB4F5F9F61F5A4FEF51107213CE6FD3331C7BF39B7AFE884BF0DBC1BE681`.
  This token is not extended to the reconciled authority model.
- Independent post-landing review: **pending**; no production implementation
  may resume before that review is complete.

## Accepted reconciliation

P17 is authoritative for Conversation lifecycle and answer state. HumanMessage
is the immutable submitted-user source identity, owner, FIFO order and body;
its legacy lifecycle/claim/attempt/settlement/response columns are not
scheduler, Answered-prefix or current-input truth. A covered turn is the exact
immutable HumanMessage paired with its Answered ResponseJob and bounded Job
response, unique ConversationAttempt and terminal
ConversationResponseEpisode Execution proving the same
`(messageId, attemptNo, executionId)` successful response. The P14 current
input is the immutable HumanMessage body pinned once only for the exact Running
Job, active Attempt/Execution and current lease. A non-Answered, malformed or
other-episode Running record blocks later coverage. Portable Summary preserves
the ordered Human/Assistant pair; ProviderNative compatibility, owner epoch,
inclusive FIFO frontier, Work Session isolation, retention and crash/restart
semantics are otherwise unchanged. P17 retry/lifecycle semantics do not change.

## Owning-document landing

| Owner | Landed reconciliation |
|---|---|
| `docs/design/02-system-design.md` | v1.19; AH19 owner semantics and current-input/Answered source now use immutable HumanMessage identity plus exact Job/Attempt/Execution authority. |
| `docs/design/03-detailed-implementation-design.md` | v1.51; AH19 governance summary, Context Manifest source identity and P14 implementation summary reconciled; DID now depends on System Design v1.19. |
| `docs/design/implementation/P14/02-conversation-execution.md` | Exact-once response writeback targets ResponseJob; HumanMessage remains immutable; AH19 frontier and current pin are Job/Attempt/Execution based. |
| `docs/design/implementation/P17-conversation-delivery-runtime/05-commands-projections.md` | Its AH19 addendum now uses immutable HumanMessage source facts and Answered Job/Attempt/Execution facts, removing the prior “both HumanMessage and Job Answered” contradiction without changing P17 lifecycle or retry behavior. |

The already accepted P14/P17 and AH19 Work contracts remain unchanged. Physical
owner state and migration are still implementation-layer decisions. This
landing does not authorize a schema upgrade or any production/test change.

## Authorization boundary and implementation disposition

The old authorized AH19 implementation plan assumed legacy HumanMessage
`Answered`/`Claimed` fields. It is superseded by this accepted semantic
reconciliation and cannot be used as authority for code implementing the new
source model. A refreshed fixed implementation plan, independent plan review,
and a new exact implementation authorization token are required.

The uncommitted `HumanMessageStore.claimForExecution` experiment, P17 trigger
wiring and claim-specific test are withdrawn from the intended implementation;
they remain uncommitted audit WIP and must be removed before revised production
implementation resumes. The uncommitted P48 migration/store/projection and
process-test work is likewise paused and must be reviewed against the refreshed
plan. No live or preserved database was read or changed by this landing.
