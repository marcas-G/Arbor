# AH19 Conversation checkpoint owner — independent post-landing review

Review date: 2026-10-17
Reviewed commit: `f7432a0353f607f945d2634e3c49ac107a3002bc`
Parent baseline: `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa`
Result: **PASS — Blocking = 0, B1 = 0, B2 = 0; accepted design package formally landed.**

## Provenance

- Acceptance token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- Accepted proposal: `planning/proposals/AH19-conversation-checkpoint-owner-v1-fixed-package.md`.
- Raw SHA-256 independently recomputed from the proposal blob in the reviewed commit: `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
- Landing baseline and owner revisions: DID v1.49 / SD v1.17 to DID v1.50 / SD v1.18.
- Acceptance and landing record: `planning/results/AH19-conversation-checkpoint-owner-acceptance-and-landing.record.md`.

## Owner and invariant review

- P14 assigns one v1 conversation stream to the exact `RootWorkspaceId` that owns its HumanMessages. This owner is independent of message, ResponseJob revision, Attempt, Execution, and response episode; multiple conversation threads require a separately accepted `ConversationId` contract.
- The frontier covers only the contiguous FIFO prefix of authoritatively Answered HumanMessages, using `created_at` plus `messageId` tie-break (or a separately authorized equivalent total order). A current Claimed message is pinned once for its existing episode and remains uncovered until authoritative Answered settlement. Earlier Pending/Claimed messages and a related non-Answered ResponseJob, including RetryScheduled, stop later coverage.
- ProviderNative reuse across episodes requires exact complete `ResolvedModelBinding` equality; mismatch rebuilds portable Summary from the retained owner prefix without sending the incompatible opaque reference. Restart resumes the same ResponseJob/Attempt/episode without duplicate input or replay of settled Provider/action work.
- HumanMessages and live referenced checkpoint evidence remain durable. Work Session history/checkpoints cannot read, advance, or satisfy the Conversation frontier, and old unowned Workspace Session checkpoints are not backfilled as Conversation ownership.
- P17 retains authority over the existing Answered transition and does not gain retry behavior. P3 defines projection only. P2 does not select a physical owner-state table/Session binding, port, transaction shape, or migration. P9 covers commit/restart, binding mismatch, Work isolation, and non-contiguous-prefix fail-closed cases.
- DID v1.50 and SD v1.18 carry the accepted token/hash and cross-reference both separate packages. The commit changes only the accepted design owners and their acceptance/review records; no implementation, migration, test, P4, Problem, or Scenario file is changed.

## Authorization and boundary

This is a design-only landing. The physical owner-state choice, owner port/table, ordering key, transaction shape, manifest encoding, migration ID, and qualification remain separately authorized work. No old Session checkpoint ownership is inferred, and no storage, migration, runtime, or test implementation authorization is implied.

The reviewed commit has parent `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa`. `git show --check` is clean. No tests or builds were run for this design-only review.
