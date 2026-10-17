# AH19 Conversation owner × P17 authority Design Gap

Status: **Resolved at the design layer by accepted reconciliation; production
implementation remains paused pending post-landing review and refreshed
authorization. No implementation or qualification closure is claimed.**

## Provenance and authorization

- Worktree baseline HEAD: `9d83fbefcd2cf86cf9461116128666f969a90182`.
- Governing accepted AH19 package: DID v1.50 / System Design v1.18 and
  `planning/results/AH19-conversation-checkpoint-owner-acceptance-and-landing.record.md`.
- Accepted AH19 design token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- User implementation authorization token received in the current task:
  `AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`.
- Authorized fixed plan raw SHA-256:
  `C642BB4F5F9F61F5A4FEF51107213CE6FD3331C7BF39B7AFE884BF0DBC1BE681`.
- Reconciliation proposal:
  `planning/proposals/AH19-conversation-owner-p17-authority-reconciliation-draft.md`.
- Proposal raw-byte SHA-256 at this result checkpoint:
  `92EF668AFFBE3A5D1C651107C33006C7CB987E7021FFFC02037B3603FD276B75`.
- Independent proposal review: final read-only **PASS**, no B1 remains after
  corrections.
- Acceptance/landing record:
  `planning/results/AH19-conversation-owner-p17-authority-reconciliation-acceptance-and-landing.record.md`.
- Manual acceptance token:
  `RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY`, accepted
  2026-10-18.
- Independent post-landing review: pending.

The implementation authorization is scoped to the fixed plan hash above. The
accepted reconciliation supersedes its legacy HumanMessage-state assumptions,
so that authorization does not cover the revised source model. No code was
committed in the governance landing; only accepted design hunks and the
acceptance/landing record were added.

## Concrete failure evidence

The P17 closure evidence at `planning/results/P17.result.md` records a
successful production Dogfood response with the legacy HumanMessage still
`Pending` and `response_body=NULL`, while ResponseJob is `Answered` at revision
2 and Attempt 0 is `Completed`. The P17 sweep obtains the bounded assistant
response from settled Execution ModelOutput and writes the answer to the Job.
`HumanMessage` lifecycle columns are explicitly legacy compatibility and not
runtime/scheduler truth in P14 `01` §9 and P17 `01` §1–§4.

The attempted AH19 process fixture showed the same authority split after the
new, uncommitted claim-CAS experiment: HumanMessage remained `Claimed` with
`response_body=NULL`, while its ResponseJob was `Answered` at revision 2, with
`active_execution_id=NULL` and `next_attempt_no=1`. The provider was called
once. The test timed out only because it incorrectly waited for the legacy
HumanMessage state to become Answered. This is evidence against using those
legacy columns, not an authorized new lifecycle.

Frozen P14/02 §4.1 contains the older `Claimed → Answered` writeback text, while
P14/01 §9/P17/01 §1 supersede HumanMessage state and response ownership to
ResponseJob. The already-landed AH19 addendum in P17/05 also currently requires
both HumanMessage and ResponseJob to reach Answered. The AH19 implementation
plan additionally requires both. These documents do not presently yield one
implementable answer.

## Work performed and verification

Before the conflict was identified, uncommitted schema-48 migration/store and
Conversation projection work was explored under the original plan. The
following focused gates passed on that branch state:

- P48 migration tests: 2/2.
- P48 owner store plus exact claim-CAS experiment: 3/3.
- AH19 history/projection unit tests: 10/10.
- Existing P14 real-provider Conversation tests: 2/2; these assert ResponseJob
  answer and projection, not legacy HumanMessage writeback.
- `pnpm typecheck`, `pnpm build`, and the @arbor/web build: exit 0.
- Test runner inventory validation after registering the two untracked
  functional tests: 51 Vitest files / 6 UI files, PASS.

The real-process owner checkpoint test has **not passed**. Its first run failed
at daemon startup because `apps/web/dist/index.html` was absent; after building
Web, the process reached P17 and exposed the HumanMessage/ResponseJob mismatch
described above, before the AH19 owner checkpoint boundary. Therefore no
owner compaction, crash boundary, or restart qualification is claimed.

No full test suite, CLI 48 qualification, final Biome/diff gate, independent
implementation review, or implementation commit was performed. All current
production/test/migration edits are uncommitted and must be handled only after
the Design Gap is accepted. The newly added `HumanMessageStore.claimForExecution`
legacy CAS, its P17 trigger wiring and claim-specific test are specifically
proposed for withdrawal; no legacy claim/answer write may be treated as valid
implementation evidence.

## Recommended governance resolution

The proposal recommends P17 as authority: HumanMessage contributes immutable
identity/order/body; ResponseJob + ConversationAttempt + exact
ConversationResponseEpisode Execution prove Answered history and current
Running input. It explicitly covers non-current Running jobs, binds
Episode-at-admission revision separately from later Job revisions, preserves
the paired Answered Job response in Summary sources, and requires migration
tests to prove legacy HumanMessage fields and unowned Session checkpoints are
unchanged. P17/05's AH19 addendum is included in the exact landing scope; P17
retry/lifecycle semantics otherwise remain unchanged.

The design gap is resolved by the accepted landing record. Production changes
remain paused until the independent post-landing review, a refreshed fixed
implementation plan/review and a new exact implementation authorization are
complete. See the accepted proposal for the reconciled contract and test delta.
