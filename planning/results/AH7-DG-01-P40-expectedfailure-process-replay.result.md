# AH7-DG-01 — Schema 44 P40 ExpectedFailure crash/replay qualification

Date: 2026-10-16
Candidate: `d06ace6b72b9955c163fcf5cac2c425dd579550e`
Status: **targeted ExpectedFailure process boundary PASS; AH7 remains PARTIAL / OPEN**

## Production-daemon process boundary

`tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`
now includes a schema-44 production-daemon scenario at the existing
`AH7AfterToolSettlementCommit` seam. The P4 invocation is a deterministic
ReadOnly `ExpectedFailure`; the production `ToolObservationEvidenceStoreLive`
commits its P40 envelope in the same P4 settlement transaction. The daemon is
SIGKILLed after that commit and before the P3 ToolResult/Action/cursor commit.

At the crash snapshot, the test proves `PRAGMA user_version = 44`, one settled
`ExpectedFailure` invocation, null `result_ref`, zero Artifact rows and no
ToolResult while the action remains Pending. It verifies the exact v1 P40
Observation (`text`, `truncated=false`), the version string, and the
domain-separated SHA-256 over `version + LF + observation_json`.

Before restart, the test creates the previously missing read target with
different content. Thus an accidental executor re-entry would change the
outcome to Success. Instead, restart preserves the same P4 settlement,
version, hash and exact Observation bytes, writes one failed P3 ToolResult,
applies the original action, advances its cursor once, and does not invoke a
second provider tool decision. No Artifact is created.

The crash snapshot contains exactly one matching `(execution_id,
logical_step_no)` AgentLoopStep at `next_action_index=0`. After recovery the
same execution/logical step is unique at `next_action_index=1`; its exact
ProviderTurn is unchanged. There is exactly one Action for that same step and
callRef, plus exactly one ToolResult whose source ref equals the Action's
Observation source. This is the evidence behind the “cursor advances once”
claim; ToolResult rows themselves expose source identity rather than direct
Execution/step columns.

Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts -t "replays the committed P40 ExpectedFailure observation after process crash" --testTimeout 180000
```

Result after cursor-uniqueness assertions: **1 passed / 7 filtered out**,
48.942 seconds test time. This is one
real daemon crash/restart qualification, not a full AH7 matrix or full
functional run.

The first observable run reached recovery and passed the P4/P40 evidence and
P3 projection checks, then failed only because the new test oracle expected a
second Provider call. A later run showed the normal AgentLoop may issue one
completion Provider request after P3 projection. The final oracle counts
exactly one `read` ToolCall decision, permits at most one completion request,
and requires that request—if present—to contain the original ExpectedFailure.
The cursor-uniqueness rerun above passed; these were test-oracle corrections,
not runtime failures.

## Schema-44 adapter fail-closed boundaries

`adapters/persistence-sqlite/test/p40-observation-schema44-fail-closed.test.ts`
uses the current schema-44 fixture and production SQLite
`ToolObservationEvidenceStoreLive`. After writing a valid P40 ExpectedFailure,
the isolated fixture simulates missing evidence and a wrong evidence hash; the
adapter returns typed `ToolObservationReplayEvidenceFailure` with `Missing`
and `HashMismatch` respectively. The fixture temporarily removes the P40
immutability trigger only to represent damaged historical storage; no
production database or trigger is changed.

Result: **2/2 passed**. This is adapter-level evidence, not a process
qualification. Existing P40 codec/store-gate/P3 module selection also passed
**3 files / 16 tests**, including the codec's missing/unsupported/corrupt/
mismatched evidence fail-closed cases.

The first adapter-fixture attempt failed before the read assertions because
the new invocation fixture omitted the required exact P39 RecoveryBinding.
After the fixture bound the invocation before effect admission, both damaged
evidence cases reached the P40 reader and passed; no production code changed.

The old pending fake-runtime fixture now explicitly verifies that a runtime
without a P40 evidence store fails closed as `OutcomeUnknown`; it no longer
claims to reconstruct an observation absent from its fixture. Result:
**1/1 passed**. This fake-runtime case is compatibility/fail-closed evidence,
not production replay qualification.

## Validation and limits

- `pnpm typecheck`: PASS.
- Targeted Biome on the three changed TypeScript test files: PASS.
- `git diff --check`: PASS.
- No production semantics or `docs/design/**` files changed; no full suite ran.
- This closes the scoped ExpectedFailure P4-commit → P3-projection process
  boundary for this profile only. AH7 remains PARTIAL / OPEN: positive
  Reconcilable profile runtime qualification and other crash/concurrency
  permutations remain open.
