# AH10/P10 Attention Materialization — Superseded Design-Gap Evidence

Status: **SUPERSEDED; not an accepted Design Gap and not a governance blocker**

Date: 2026-10-10

## Disposition update

An independent P10 review confirmed that P10 `02` §2, P10 `04` §1–§2, and P10
`07` Story I sufficiently authorize an Attention business-row materialization,
same-transaction row/checkpoint application, and project-scoped rebuild as
implementation details. No governance change is required. The initial RED
below is invalid as AH10/P10 gap evidence because it used the P1 generic marker
store with a synthetic event and did not seed the matching immutable P9
fact/event or exercise a P10 consumer. Preserve it as historical diagnostic
evidence only; it does not establish a design contradiction or authorize a
governance proposal.

The accepted P10 implementation is now in place; this file remains only as a
historical disposition record, not an open gap.

## Reproduction

The initial isolated pending RED version:
`tests/functional/pending/ah10-p10-attention-materialization.functional.test.ts`.

Command:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-p10-attention-materialization.functional.test.ts
```

The first run failed with two tests, but it was an invalid design-gap
reproduction: it used a synthetic event and P1 `projection_state` only; it did
not create the matching P9 fact/event or exercise P10's accepted materialized
consumer. An independent P10 review found the existing P10 contracts sufficient
and directed implementation under those contracts. Do not cite this first RED
as a Design Gap.

## Corrected RED and implementation

The pending test was then corrected to seed project, owning Workspace,
Execution, and Committed Command rows, create the immutable P9 fact/event
through `RecoveryAttentionFactStore.recordAssignWorkBindingFailure`, and query
the P34 P10 projection store. Before the project-bound P10 adapter was wired,
the existing P1 generic consumer advanced its test offset to `1` but left the
P10 Attention rows empty. The rebuild case replayed the generic marker and
still left zero Attention rows. This RED identified the missing implementation
path under accepted P10, not a contract conflict.

The implementation added migration 0034 and a project-bound P10
`ProjectionStoreService` adapter. Existing `pollOnce` and `rebuildProjection`
now apply/reset P10 rows while advancing the Attention checkpoint in their
existing transaction. The reset closure deletes rows for only its project and
leaves the shared P1 `projection_state` intact. The production daemon registers
the P10 consumer for configured and dynamically discovered projects. The
Attention query replaces the on-read AssignWork row with the materialized row;
the public DTO remains `summaryRef` and does not add `failure_code`.

The real daemon process case starts with Project B already holding one
materialized row, Attention offset 1, and a P1 marker for event 1. A second
matching P9 fact/event is then appended to B but left pending. The daemon child
is configured only for Project A:

1. Gen0 discovers configured Project A, writes its P10 row inside the
transaction, then pauses before commit. After SIGKILL, A has neither the row
nor an advanced Attention offset. B's pending event is still untouched.
2. Gen1 starts with the same Project A configuration. Its open-project scan
discovers B, consumes B's pending event (B offset 1 → 2; row count 1 → 2), and
commits A's row/checkpoint. The child is killed after polling returns.
3. Gen2 restarts and polls without duplicating either project's rows. Rebuild
of A replays the retained source event; production Attention and Tree views
match their pre-rebuild values, A's Parent subtree `ActionRequired` count is
one, and B's two rows and P1 markers remain unchanged by the rebuild.

Corrected RED-to-GREEN qualification: four event-envelope mutation cases
(`aggregate_ref`, `correlation_ref`, `caused_by_command_id`, and `occurred_at`)
first passed incorrectly through the consumer; after exact envelope validation,
all fail closed with no projected row and offset unchanged. The full pending
Attention suite is **9/9 PASS**, including real P9 fact/event materialization,
dedup on offset-regressed replay, row+offset rollback, project-isolated rebuild,
database close/reopen, and real daemon process qualification. Migration 0034
tests are **2/2 PASS** (P33 upgrade and fresh install). Targeted P10
architecture, Attention read-model, and rebuild regressions are **23/23 PASS**.
Real `ProductionDaemonService.start` migration wiring and the `CURRENT_MIGRATIONS`
composition qualification are **2/2 PASS** and both observe migration version
34 with `attention_projection_rows` present. Test TypeScript compilation,
selected package builds, Biome, and whitespace checks pass.

Static contract audit confirmed:

- `adapters/persistence-sqlite/src/consumer.ts` creates generic
  `projection_state(project_id, sequence, event_type)` only.
- DID v1.33 migration 0033 defines `assign_work_target_bindings` and
  `assign_work_binding_attention_facts`, but no P10 Attention projection
  storage schema.
- P10 `02` requires loading the P9 fact and writing its Attention row with the
  offset in one transaction; P10 `04` assigns project-scoped business
  projection rebuild; P10 `07` Story I requires deduplication, subtree count,
  rebuild and restart parity. Independent review confirmed these contracts
  authorize the implementation details above.
- The P10 row stores `source_event_id`, P9 `source_fact_id`, severity, target,
  typed `failure_code`, safe summary, and event time under `(project_id,
  dedup_key)`. The target is resolved from `executions.workspace_id` and
  checked against the P9 fact. No opaque selector or authority data enters the
  projected row.

## Disposition

The implementation disposition is recorded in
`planning/proposals/AH10-P10-attention-materialization-governance-draft.md`;
its former governance-choice language is superseded. The accepted P10 contract
and independent review were sufficient authority for this implementation.
No Design Gap remains open in this slice. The process claim is limited to the
isolated real-daemon SIGKILL/restart case described above; it is not a broader
AH10 process-qualification claim.

## Final integrated validation

The P10 materialization/rebuild/restart suite remains **9/9 PASS**. The final
combined P34 migration, real-daemon, P5, P10 read-model/architecture and
application qualification batch passed **27/27**. Independent P10 consumer
review: **Blocking = 0**. These scoped results do not claim broad AH10 closure.

The final frozen-tree `pnpm check` passed (Biome 978 files with one existing
non-blocking warning; typecheck and test typecheck; architecture 31 files /
158 tests; core 324 files / 1760 passed / 3 skipped; Web typecheck/build and
31 files / 223 tests). The P12 restore-drill generated timestamp/hash were
restored to the exact HEAD values after checking the diff; P12 result and
storage-assessment hashes also match HEAD.

The first integrated functional run before the AH12 test-oracle correction
finished Vitest at 30/31 files with 122/123 tests passing. The only failure
was `tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts:534`:
`waitForPublic` returned a snapshot before its matching
`verification_executions` binding row was present. The test-only correction
waits for that exact same-snapshot binding, preserves the 45-second timeout and
final assertion, and passes the AH12 target at 3/3 with independent review
Blocking = 0. No production change was made for this observation.

After the correction and promotion of both green process suites to the default
functional include, the final integrated `pnpm check` and one full
`pnpm test:functional` passed: Vitest 33/33 files / 144/144 tests and
Playwright 3/3. The 21 promoted AH10/P10 cases are included in those default
totals. F20's clean-checkout smoke exercised repository `HEAD` only and does
not qualify the modified uncommitted tree. The earlier pre-correction failure
is retained here as test-oracle history; an even earlier startup interruption
is not qualification evidence.
