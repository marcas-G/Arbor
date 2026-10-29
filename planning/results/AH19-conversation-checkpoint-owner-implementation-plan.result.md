# AH19 Conversation Checkpoint Owner — Implementation Plan Result

Status: **Original implementation token received; its plan is superseded by accepted design reconciliation. Implementation remains stopped pending independent post-landing review, refreshed plan and a new exact authorization.**

## Provenance

- Preparation baseline HEAD: `58aae35b08738019749ba5bba17a26f564f0cd57`.
- Governing design at plan preparation: System Design v1.18 / DID v1.50;
  superseded for the AH19 Conversation authority model by SD v1.19 / DID v1.51
  on 2026-10-18.
- Accepted governance token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- Accepted proposal raw SHA-256:
  `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
- Independent post-landing review: Blocking = 0.
- Fixed plan: `planning/proposals/AH19-conversation-checkpoint-owner-implementation-plan.md`.
- Fixed plan raw SHA-256:
  `C642BB4F5F9F61F5A4FEF51107213CE6FD3331C7BF39B7AFE884BF0DBC1BE681`.
- Implementation token originally requested at plan preparation:
  `AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`.

## 2026-10-17 authorization and 2026-10-18 Design Gap reconciliation

The user explicitly authorized
`AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION` in the current
task. During the first implementation layer, production evidence exposed a
semantic conflict between accepted AH19 v1.50's legacy-HumanMessage `Answered`/
`Claimed` wording and the later frozen P17 ownership contract. The existing
token applies to the fixed plan raw SHA above and does not authorize silently
changing that plan to resolve the gap.

The implementation is paused. No implementation commit or migration/runtime
qualification is claimed. The exact reconciliation request is
`planning/proposals/AH19-conversation-owner-p17-authority-reconciliation-draft.md`;
its raw-byte SHA-256 is
`92EF668AFFBE3A5D1C651107C33006C7CB987E7021FFFC02037B3603FD276B75`. It was
accepted under `RECONCILE_AH19_CONVERSATION_OWNER_WITH_P17_JOB_AUTHORITY` on
2026-10-18 and landed as System Design v1.19 / DID v1.51 plus the exact P14/P17
owning hunks. See
`planning/results/AH19-conversation-owner-p17-authority-reconciliation-acceptance-and-landing.record.md`.
Independent proposal review passed with no B1; independent post-landing review
is pending. A refreshed fixed implementation package/token is required before
implementation resumes.

P17 source/result evidence is `docs/design/implementation/P14/01-human-message.md`
§9, `docs/design/implementation/P17-conversation-delivery-runtime/01-domain-storage.md`
§1–§4, P17 `05-commands-projections.md` §AH19, and `planning/results/P17.result.md`:
the canonical success example leaves the legacy HumanMessage Pending/null while
ResponseJob is Answered revision 2 and Attempt 0 is Completed. The current
attempt also produced a real process observation in which HumanMessage was
Claimed/null while the ResponseJob was Answered; that Claim came from the
uncommitted claim-CAS experiment and is specifically recommended for withdrawal,
not evidence that legacy fields are authoritative.

## Fixed storage and qualification scope

The plan selects a dedicated RootWorkspaceId-keyed Conversation owner table and
P14 port, with the existing `(created_at, message_id)` total order, empty owner
state on migration, and no inference/backfill from Work Session checkpoints.
Checkpoint metadata, exact contiguous Answered frontier, source manifest,
producer identity, epoch, and kind/ref are installed in one lease-fenced
expected-epoch/frontier CAS. Summary content uses the existing immutable Blob
store; ProviderNative refs require full binding identity. HumanMessage rows and
live referenced checkpoint evidence are retained.

Migration 0048 is additive and has `requiresUserVersion: 47`. Its global
prerequisite order is `45 F23/P6 → 46 VCS → 47 AH14 → 48 AH19 Conversation`.
The current checkout reports ordinary current schema 44, so this plan records
45–47 as a prerequisite rather than claiming the migration prefix exists in
this baseline. The planned matrix covers fresh and disposable schema-47 copies,
owner/frontier creation, current-Claimed pinning, same-episode restart,
binding change, Work isolation, source retention, CAS/fence races, and crash
boundaries. The non-contiguous-prefix negative is parameterized across earlier
Pending, Claimed, RetryScheduled, Declined, NeedsAttention, missing ResponseJob,
and malformed ResponseJob states. Every parameter asserts no frontier crossing,
the exact current Claimed message pinned once and uncovered, restart preservation
of blocker/owner/current episode without replay, and no additional Provider
response or second Assistant turn from the later Answered message.

This parameterization was added during independent review; Work plan scope is
unchanged.

This fixed plan's HumanMessage `Answered`/`Claimed` predicates and corresponding
P48 qualification matrix are historical and are no longer an implementation
contract. The accepted reconciliation requires a new fixed plan using immutable
HumanMessage source identity plus exact ResponseJob/Attempt/Execution authority.

## Verification and boundary

- Whitespace-only `git diff --no-index --check -- /dev/null <plan>` reported no
  whitespace errors. Exit 1 is expected because the plan is new; Git emitted
  only the LF-to-CRLF normalization advisory.
- No tests, builds, migrations, or database operations were run.
- No design, production, test, or migration file was changed while preparing
  the original plan. Its later design landing is documented separately.
- The original token did not authorize the reconciled source model. Migration 0048
  work is limited to fresh/disposable database copies and offline CLI; live or
  preserved database upgrades, deployment, and release remain excluded.
