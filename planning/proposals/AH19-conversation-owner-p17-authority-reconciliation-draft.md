# AH19 Conversation owner × P17 authority reconciliation — governance draft

**Status:** Draft for manual governance; not accepted. Implementation is
stopped at the identified Design Gap. No `docs/design/**` file is changed by
this proposal.

**Recommended token:** `RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY`

## Decision requested

Resolve the conflict between the accepted AH19 v1.50 Conversation checkpoint
wording and the already-frozen P17 ownership of Conversation response state.
The recommended single resolution is to treat P17 as authoritative: a
`HumanMessage` is an immutable submitted-user fact, while `ConversationResponseJob`
and `ConversationAttempt` own response state, answer body, active execution and
attempt truth. AH19 coverage and current-input authority should be derived from
those facts without reading or writing the legacy HumanMessage lifecycle
columns.

This proposal changes no retry policy, episode identity, FIFO ordering, model
behavior, or Work Session ownership. It does not authorize code changes or
migration execution until manual acceptance, landing review and a refreshed
fixed implementation authorization.

## Failure evidence

The frozen P17 dogfood qualification records a successful response with this
canonical persisted state (`planning/results/P17.result.md`):

```text
HumanMessage:
  state = Pending
  claimed_by_execution_id = NULL
  response_body = NULL
  attempt_no = 0
ResponseJob:
  state = Answered
  revision = 2
  active_execution_id = NULL
  next_attempt_no = 1
ConversationAttempt:
  attempt_no = 0
  settlementKind = Completed
Provider calls:
  one successful request for the prior HumanMessage
```

The P17 result names HumanMessage
`msg_01a0f816-bc04-725e-8883-f45bae99303f` and Execution
`exe_dde1ebfc-e912-7d4a-8867-e3e703419917`; it explicitly concludes that the
legacy HumanMessage remained Pending/null and is not runtime/scheduler truth.
This is positive frozen-contract evidence, not an error.

Separately, the in-progress AH19 test with the newly added legacy claim CAS
observed a Running ResponseJob become Answered/revision 2 while HumanMessage
stayed Claimed/null. It timed out because the test incorrectly waited for a
legacy `Answered` field. That result demonstrates that the unaccepted claim
CAS is not a valid P17 truth source and is recommended for withdrawal; it must
not be presented as the P17 baseline.

Source evidence:

- `docs/design/implementation/P14/02-conversation-execution.md` §4.1 retains a
  historical `Claimed → Answered` HumanMessage sweep/writeback description.
- The later P14 §4.5 says the P17 trigger consumes only `Queued` or eligible
  `RetryScheduled` ResponseJobs, not HumanMessage `Pending`/`Claimed` state.
- P17 `05-commands-projections.md`'s AH19 addendum currently says that both
  the authoritative HumanMessage and ResponseJob reach `Answered`. That
  addendum is part of the AH19 landing scope and must be clarified; leaving it
  unchanged would preserve the same conflict inside P17.
- `docs/design/implementation/P14/01-human-message.md` §9 records P17
  supersession: HumanMessage is the immutable submitted-user fact; legacy
  `state`, `claimedByExecutionId`, `attemptNo`, settlement and response columns
  are migration/read-only compatibility, and response/attention/cancel state
  belongs to the Job.
- `docs/design/implementation/P17-conversation-delivery-runtime/01-domain-storage.md`
  §1 repeats that HumanMessage boundary; §§2–4 assign `Answered` and bounded
  `responseBody` to ResponseJob and attempt settlement to ConversationAttempt.
- `docs/design/implementation/P17-conversation-delivery-runtime/05-commands-projections.md`
  §AH19 currently conflicts with P17 §1 by saying both HumanMessage and
  ResponseJob reach Answered; the AH19 landing record explicitly includes this
  file in landing scope, so this one addendum must be clarified.
- `planning/results/P17.result.md` is the completed end-to-end P17 evidence for
  the Pending/null HumanMessage plus Answered Job / Completed Attempt state.
- `packages/application/src/conversation-response-runtime.ts` settles the
  Attempt and transitions the ResponseJob in the sweep; it does not update
  HumanMessage lifecycle fields. `apps/single-workspace/src/response-body.ts`
  derives the bounded user-visible answer from the settled Execution's
  ModelOutput entries.
- The existing `apps/single-workspace/test/p14-real-provider-conversation.test.ts`
  checks the ResponseJob answer and does not assert a HumanMessage state
  writeback. It passes without such a writeback.

The accepted AH19 v1.50 language instead refers to “authoritatively Answered
HumanMessages” and a current “Claimed” HumanMessage. Its accepted implementation
plan additionally requires both HumanMessage and ResponseJob to be Answered.
These phrases cannot be implemented literally while preserving the P17
immutable-HumanMessage boundary. Neither the AH19 landing record nor fixed plan
explicitly supersedes P17's ownership rule, so implementation cannot choose a
meaning silently.

## Recommended reconciled contract

1. **HumanMessage source identity is immutable.** Use only its
   `messageId`, exact RootWorkspace/project binding, `createdAt` ordering key,
   and immutable `bodyRef`. Do not use legacy HumanMessage `state`,
   `claimed_by_execution_id`, `response_body`, `settled_at`, or `attempt_no` as
   scheduler or checkpoint truth. Do not add new writes to those columns.
2. **Answered coverage is ResponseJob/Attempt/Execution-authoritative.** A
   message is eligible for the contiguous covered prefix only when exactly
   one matching ResponseJob exists for the same message/project/root and it is
   `Answered` with bounded immutable `responseBody` and `executionId`; the
   corresponding ConversationAttempt is unique for
   `(messageId, attemptNo)`, matches that `executionId`, and has
   `settlementKind=Completed`, `settledAt` present and no failure class. The
   corresponding terminal Execution is the exact
   `ConversationResponseEpisode(messageId,responseJobRevisionAtAdmission)` for
   that Attempt and settles with the current P14
   `Completed(ConversationResponseProduced(messageId))` spelling (not the
   historical `QueryCompleted` name). The Job's Answered execution identity,
   durable response-execution identity, Attempt, and Execution settlement
   must agree. The Episode revision is the Job revision at admission; the Job
   revision advances when it becomes Running and again when Answered, so these
   revisions are related through the exact transition history, not assumed to
   be equal. The bounded response body and hash come from the ResponseJob, not
   the legacy HumanMessage row.
3. **The active current message is exact Running Job input.** Pin the immutable
   HumanMessage body once only when its matching ResponseJob is `Running`, its
   `active_execution_id`/state executionId match the current exact
   `ConversationResponseEpisode`, its active Attempt matches
   `(messageId, attemptNo, executionId)`, and the Execution/lease binding is
   current. This is the P17 semantic equivalent of the AH19 current-message
   pin; it does not claim that a legacy HumanMessage row is `Claimed`.
4. **No exact active attempt means no current input.** A `Queued`,
   `RetryScheduled`, `NeedsAttention`, `Cancelled`, missing or malformed job
   is a blocker and is never promoted to a current message by inference from
   HumanMessage fields. A `Running` job is current only for its exact Running
   Attempt/Execution; an earlier `Running` job bound to another episode is a
   blocker. Any earlier non-Answered or malformed job stops the contiguous
   prefix; later Answered jobs are not skipped across the gap.
5. **Coverage still advances only after durable Answered truth.** A checkpoint
   committed before current response settlement covers only earlier
   authoritative Answered job/attempt pairs. The current Running job remains
   raw pinned input and uncovered. Once the job is Answered, the next
   checkpoint may cover it through the normal FIFO scan.
6. **ProviderNative and Work isolation remain unchanged.** Exact complete
   binding equality is required for Native reuse; otherwise a portable Summary
   is rebuilt from immutable HumanMessage bodyRefs plus authoritative Answered
   ResponseJob response bodies. Work Session history/checkpoints remain
   excluded.

## Manifest and implementation consequences

The owner checkpoint source manifest must bind each covered tuple to at least:

```text
rootWorkspaceId
fromEpoch / toEpoch
fromFrontier / coveredThrough (inclusive createdAt + messageId)
ordered HumanMessage source identity: messageId + createdAt + bodyRef
  + body digest (legacy lifecycle columns omitted)
ordered Answered ResponseJob / Assistant turn pair: exact Job revision
  + response executionId + attemptNo + bounded Job responseBody digest
exact Episode admission revision + terminal ExecutionId/settlement binding
  + ConversationAttempt identity/settlement
producer ExecutionId + ProviderTurnId + Provider ManifestId
current exact Running message/job/attempt/execution binding (not HM claim columns)
checkpoint kind/ref + complete binding fingerprint when ProviderNative
```

The paired Assistant response is part of the existing Conversation
projection: the runtime already emits the Answered Job body after its
HumanMessage. Portable Summary must preserve this ordered user/assistant pair.
Its exact manifest encoding is therefore an implementation requirement, not
a free-form summary over user-only rows.

The P48 dedicated table and `requiresUserVersion:47` need not gain a new
physical column solely for these facts if the complete canonical source
manifest remains durable in `source_manifest_json`; the P48 adapter must
validate the joined Job/Attempt/Execution facts under the same transaction and
lease fence. The message order stays `(created_at, message_id)`.

Update the AH19 fixed implementation plan before implementation resumes:

- Replace HumanMessage `Answered`/`Claimed` state predicates with the exact
  Job/Attempt/Execution predicates above.
- Recast the seven blocker cases around missing/mismatched/Queued/Running-other
  /RetryScheduled/NeedsAttention/Cancelled/malformed ResponseJob or Attempt
  evidence. Keep missing/malformed jobs fail-closed and do not infer from
  legacy HumanMessage columns.
- Change the current-message pin assertion to exact Running
  ResponseJob+Attempt+Execution binding and one raw immutable HumanMessage
  bodyRef occurrence.
- Update the source manifest, SQLite commit validation, owner history
  projection, binding/rebuild checks and process restart evidence accordingly.
- Keep the Migration 0048 boundary additive, offline-only, and ordered after
  0047; preserve schema-47 and 44→48 ordered-prefix tests.
- Prove that arbitrary legacy HumanMessage `state`, claim owner, response body,
  and settledAt values neither create nor suppress a covered prefix when the
  immutable source identity and exact P17 Job/Attempt/Execution facts are the
  same. Verify schema upgrade leaves pre-existing HumanMessage rows and
  unowned Workspace Session checkpoints unchanged; no state/claim/response
  backfill is permitted.
- Withdraw the newly added legacy claim CAS before implementation proceeds.
  Specifically remove `HumanMessageStore.claimForExecution` and its types/SQL,
  the P17 trigger call/dependency, its production composition dependency, and
  the claim-specific P48 test. Remove P48 source validation/projection reads of
  legacy HumanMessage `state`/`claimed_by_execution_id`/`response_body`. Keep
  schema-48 fixture support and the existing P48 migration/store work only
  after it is adapted to the accepted Job-authoritative contract.

The changed owning wording is limited to the AH19 landing package's owners:
System Design v1.18's AH19 owner summary, DID v1.50 §8.19/P14 implementation
summary, P14 `02` §1/§4/§5, and the already-landed AH19 addendum in P17
`05-commands-projections.md`. The P17 edit only clarifies AH19 as “immutable
HumanMessage source identity + authoritative Answered Job/Attempt facts”; it
does not change P17 lifecycle or retry behavior. Do not edit `docs/design/**`
until this exact proposal is manually accepted and the required landing/review
procedure is authorized.

## Authorization and stop condition

Manual acceptance of
`RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY` would authorize only
the exact owning-document reconciliation package. It would not itself
authorize production edits or migration execution. The existing
`AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION` was issued against
the pre-reconciliation fixed plan; it must not be stretched to cover this
changed authority model. After landing and consistency review, a refreshed
fixed implementation package and exact implementation authorization are
required.

Until that governance sequence completes, stop AH19 owner projection/compaction
implementation. Preserve current uncommitted work for audit; do not commit it
or modify `docs/design/**`. In particular, do not retain the legacy HumanMessage
claim CAS as an implementation workaround.
