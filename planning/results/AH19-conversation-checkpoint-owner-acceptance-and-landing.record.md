# AH19 Conversation checkpoint owner — acceptance and landing

Status: **Accepted design package landed; storage, migration and implementation not authorized.**

- Acceptance token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- Accepted proposal: `planning/proposals/AH19-conversation-checkpoint-owner-v1-fixed-package.md`.
- Accepted proposal raw SHA-256: `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
- Acceptance and landing date: 2026-10-17.
- Landing baseline: `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa` (DID v1.49; SD v1.17).
- Implementation authorization: **not granted**. Owner-state port/table or
  standard Session binding, physical message-order key, transaction shape,
  manifest encoding, migration ID, upgrade/rollback and qualification require
  a separate implementation package and authorization.

The exact RootWorkspaceId owns one v1 Root Workspace conversation stream,
stable across messages, ResponseJobs, Attempts, Executions and response
episodes. The checkpoint frontier covers only the contiguous FIFO prefix of
authoritatively Answered HumanMessages (existing order `created_at` then
`messageId` tie-break unless a separately authorized implementation preserves
that total order using an explicit owner-local sequence). The exact current
Claimed message is pinned once for its response episode and remains uncovered
until Answered. A non-Answered gap blocks later coverage. ProviderNative reuse
requires exact complete ResolvedModelBinding equality; otherwise portable
Summary rebuilds from retained HumanMessage sources. Restart resumes the same
episode without duplicate message projection or settled Provider/action
replay. Work Session history/checkpoints are excluded. HumanMessages and live
referenced checkpoint evidence remain durable; old unowned Session checkpoints
are not backfilled as Conversation ownership.

## Landing scope

- `docs/design/02-system-design.md` (v1.18; §3.6, §4.6, §5.5–5.6).
- `docs/design/03-detailed-implementation-design.md` (v1.50; §8.8, §8.13,
  §8.19 and P14 owner summary).
- `docs/design/implementation/P14/02-conversation-execution.md` (semantic owner,
  order, Answered prefix, current message, restart and isolation).
- P3 `02-model-context-contracts.md` and `03-agent-loop-driver.md` (projection
  and same-episode compaction behavior).
- P2 `02-port-contracts.md` / `04-sqlite-schema.md` (separate owner boundary;
  no physical storage design selected).
- P9 `02-fault-injection-matrix.md` / `07-agent-loop-step-recovery.md` (crash,
  binding, restart and non-contiguous-prefix cases).
- P17 `05-commands-projections.md` (Answered transition interaction only; retry
  policy unchanged).

The independent Conversation package review is
`planning/results/AH19-conversation-checkpoint-owner-landing.review.md`.
The Work bounded-frontier package is separately accepted and separately
reviewed; this record does not represent its acceptance.
