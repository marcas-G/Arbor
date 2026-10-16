# AH19 Conversation Checkpoint Owner — Implementation Plan Result

Status: **Fixed planning package prepared; implementation and qualification are not authorized or performed.**

## Provenance

- Preparation baseline HEAD: `58aae35b08738019749ba5bba17a26f564f0cd57`.
- Governing design: System Design v1.18 / DID v1.50.
- Accepted governance token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- Accepted proposal raw SHA-256:
  `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
- Independent post-landing review: Blocking = 0.
- Fixed plan: `planning/proposals/AH19-conversation-checkpoint-owner-implementation-plan.md`.
- Fixed plan raw SHA-256:
  `C642BB4F5F9F61F5A4FEF51107213CE6FD3331C7BF39B7AFE884BF0DBC1BE681`.
- Requested, not yet granted, implementation token:
  `AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`.

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

## Verification and boundary

- Whitespace-only `git diff --no-index --check -- /dev/null <plan>` reported no
  whitespace errors. Exit 1 is expected because the plan is new; Git emitted
  only the LF-to-CRLF normalization advisory.
- No tests, builds, migrations, or database operations were run.
- No design, production, test, or migration file was changed for this plan.
  No file was staged or committed.
- The requested token is a separate gate. If authorized later, migration 0048
  work is limited to fresh/disposable database copies and offline CLI; live or
  preserved database upgrades, deployment, and release remain excluded.
