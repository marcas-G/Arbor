# P36 P4 Concurrent Intent / Settlement-Fence Fixture Triage

Status: **TARGETED QUALIFICATION PASS; NO PRODUCTION REGRESSION FOUND**

Baseline: `629b562df4ddd4e7ace10f0b9883cd349ee70d34` in the dedicated managed
worktree `C:\Users\ThinkPad\.codex\worktrees\p36-p4-concurrency-races\Arbor`.
This triage is limited to the two P4 failures from the first P36 candidate
check. It does not modify the main/integration tree or the AH7 source tree.

## Finding A — duplicate intent label was a test-helper error

The focused RED was `p4-ah7-cross-connection-concurrency.test.ts` asserting one
success and one rejection for two independent connections recording the same
`ToolInvocationId`. The helper discarded the `recordIntent` return value and
mapped every successful transaction to `{ _tag: "Inserted" }`, so two correct
`"Recorded"` outcomes looked like two inserts.

P4's accepted same-invocation replay behavior is idempotent: inside the
`BEGIN IMMEDIATE` transaction, the first caller inserts the row; after SQLite
serializes the competing connection, the second reads the existing row,
validates exact same intent plus `NotAdmitted`/unsettled state, and returns
`"Recorded"`. The primary key remains unique and the durable row count is one.
Rejecting the second exact claim would contradict same-invocation replay
semantics; changing production CAS or weakening effect admission was not
needed.

The helper now preserves the store result, and the store-level case expects two
`Recorded` acknowledgements but asserts the primary-key constraint and exactly
one durable row. The same test file also runs independent ToolRuntime
connections and two real OS child processes against the P36 schema. It checks
two distinct process PIDs, one external marker, one settled Success row, and a
non-success loser; no second external effect is admitted.

## Finding B — settlement timeout was an obsolete schema fixture

The focused RED in `p4-tool-settlement-fence-expiry.test.ts` timed out at 30s
waiting for `AH7BeforeToolSettlementTransaction`. Its fixture ran
`P12_MIGRATIONS`, which stops at `user_version=13` and has the pre-AH7
`tool_invocations` table without `effect_admission_state`. The invocation
therefore returned before the settlement probe; the test then waited on a
Promise that could never resolve. This was not a SQLite `BEGIN IMMEDIATE`
queue delay.

Changing the fixture to P36 exposed two further fixture mismatches rather than
production defects: its `executions` INSERT still named the retired
`focus_kind/focus_work_id` columns, and its hand-authored
`InvocationAuthority.sourceRevision` did not match the current persisted
workspace-policy / active-grants / verifier snapshot. The test now migrates
with `P36_MIGRATIONS`, seeds the current `ConversationResponseEpisode` schema,
and derives the trusted source revision with
`invocationAuthoritySourceRevisionOf` from the fixture's actual revision-zero,
no-grant, no-verifier snapshot.

With the corrected fixture, the original barrier still holds an independent
`BEGIN IMMEDIATE` transaction while the P4 settlement is queued. The injected
clock advances only after the queued transaction boundary is observed and
before the holder releases. Assertions continue to require exactly one
external effect, `LeaseFencingRejected` for the now-expired worker, no
settlement COMMIT, and an unchanged canonical invocation with null settlement.
No busy timeout, test timeout, clock sampling point, lease rule or fencing
predicate was widened or changed.

## Exact verification

| Gate | Result |
|---|---|
| Initial cross-connection/process reproduction after package setup | 1 bad test expectation; the real child-process test initially could not import the unbuilt `packages/tool-runtime/dist` |
| `pnpm --filter @arbor/persistence-sqlite... build` | PASS |
| `pnpm --filter @arbor/tool-runtime build` | PASS |
| `pnpm exec vitest run adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts` | PASS — 3 passed, 1 historical skipped; includes two OS processes after build |
| `pnpm exec vitest run adapters/persistence-sqlite/test/p4-tool-settlement-fence-expiry.test.ts` | PASS — 1 passed |
| P4 store/DDL/P36 migration/runtime module regression (`p4-invocation-store`, `p4-ddl`, `p36-ah7-tool-invocation-state-migration`, `p4-ah7-concurrent-invocation`, `p4-pipeline`) | PASS — 5 files, 20 tests |
| `pnpm exec biome check` on the two changed test files | PASS |
| `git diff --check` | PASS |

No production code or migration was changed. No full check, functional,
Playwright, push, or unrelated suite was run. The unique row/effect and lease
fence assertions remain strict; only obsolete/mislabelled test fixtures were
corrected. No new contract gap was found.
