# AH7 Same-holder Owner Boundary — Design Landing Package (Draft)

Date: 2026-10-12  
Status: **Draft exact landing package; not accepted; no `docs/design/**` edits made.**  
Decision record: `planning/results/AH7-same-holder-owner-decision.record.md`  
Selected behavior: user-selected Option C/B from proposal SHA-256
`FBCBAB1D2A3EE245A8561C683C460EF8F7329DC72A47D3AAC92B18C564ADBB76`.

## Decision this package lands

Production execution uses one current P2 lease-authorized Worker driver per
Execution and the P3 AgentLoop advances one action at a time. Copying the same
holder tuple into two concurrent `ToolRuntimePort.invoke` callers is outside
the supported production call path. P4 does not acquire a new invocation-level
owner/wait record for that unsupported call shape. Sequential recovery of a
previously `MayHaveStarted` NonIdempotent invocation keeps its current frozen
P4/P9 behavior: do not replay; retain or settle `OutcomeUnknown` as the
existing recovery path specifies.

The accepted decision does **not** change P2 lease CAS, the P4 side-effect
state machine, or any persistence/API schema. A real generation takeover is a
separate supported process path: G1 obtains its lease through `LeaseService`,
does not replay G0's admitted effect, and a late G0 write is rejected by the
existing fence.

## Exact owner-file landing table

The following are the only proposed `docs/design/**` changes. The listed
baseline SHA-256 values are calculated at audit HEAD
`3c957d8125ee9951aaa1f29f263fadb43cea2940`; the implementation-contract files
have no independent version field. Top-level System Design and DID versions
are not changed by this package.

| Owning file / current section | Baseline SHA-256 | Proposed insertion | Semantic revision |
|---|---|---|---|
| `docs/design/implementation/P2/02-port-contracts.md` §5, after the `ExecutionDriverPort` bullets | `8A6DA2491CD83ACD8F70817824286B4F3E7A78425C631E1A95901DEDA1A469A6` | `Single-flight driver use:` paragraph below | Make lease acquisition the only supported entry to a production drive and clarify that wake dispatch does not authorize copying another driver's context. |
| `docs/design/implementation/P2/03-lease-fencing-model.md` §2, after the P12 TR-9 lease-holder identity note | `4F4CFA2F1FFC2860A7BE7F0C3DBD2EAFF2C59CC9D3B8CCF04593525604D2A485` | `ExecutionOrigin provenance:` paragraph below | Clarify that the holder tuple used for a production drive is the result of its own successful lease acquisition; a manually copied tuple is not a second acquisition/Worker owner. |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` §7, after the `nextActionIndex` bullet | `736015FF9D4C001B95E61B834ADE086495DE504F6CC73957667460E6F594B6F2` | `Serial action dispatch:` paragraph below | Freeze the existing production single-action-in-flight order for one AgentLoopStep. |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` §2, after the `ToolRuntimePort.invoke` signature | `CBE1B98F8817236070A9655D558061B04E2C92E37FEBC281F99206B6E98C3161` | `Caller concurrency boundary:` paragraph below | State that P4 is not a same-holder concurrent invocation lock; the production caller is P3's serialized current action. Leave sequential recovery and `MayHaveStarted` disposition unchanged. |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` §4, after the AH7 matrix row | `01D76830AA39F8935A0AF031E94DC46F11E806FF722079CDAD6E5D27750F68DF` | `AH7 lease-owner qualification:` paragraph below | Distinguish same-holder cloned-context diagnostic evidence from P2-valid G0/G1 process recovery qualification. |

No table/schema/ADT/port method, migration, new failure tag, Attention source,
or provider/tool side-effect semantic is added.

## Proposed exact landing text

### P2 `02` — §5 ExecutionDriverPort

```md
**Single-flight driver use.** Dispatch is only a wake intent. The production
P2 `runExecution` path invokes `ExecutionDriverPort.drive` only after its own
successful `LeaseService.acquire` for that Execution. A live-lease acquisition
rejection does not call the driver or reuse another run's `ExecutionOrigin`.
The lease tuple is not an application-level token for starting a parallel
driver.
```

### P2 `03` — §2 Lease record

```md
**ExecutionOrigin provenance.** A production Worker drive receives its
`ExecutionOrigin` from the `LeaseRecord` returned by that drive's successful
`LeaseService.acquire`. Dispatch/wake, a stored lease row, or a tuple copied
from another caller does not create a second lease owner. A second driver may
start only after its own successful acquisition; live-lease rejection leaves
the current driver as the sole authorized writer, while expiry/takeover uses
the existing monotonic generation rule.
```

### P3 `08` — §7 Action ledger

```md
**Serial action dispatch.** For one `AgentLoopStep`, the production AgentLoop
invokes only the action at `nextActionIndex`. It waits for that P4 invocation
to return, then commits the action disposition, sourced Observation and cursor
advance before it invokes the next action. It does not issue overlapping P4
invocations for one pinned action. Recovery resumes the same pinned action
sequentially under the currently acquired `ExecutionOrigin`.
```

### P4 `02` — §2 ToolRuntimePort.invoke

```md
**Caller concurrency boundary.** `ToolRuntimePort.invoke` is called by the
single current P3 AgentLoop action under its current `ExecutionOrigin`. P4 does
not provide invocation-level arbitration or a wait/owner protocol for
overlapping calls carrying a copied same-holder tuple; such calls are outside
the supported production path. This boundary does not change sequential
recovery: after `MayHaveStarted`, a NonIdempotent ambiguity follows §5 and P4
`06`—no automatic replay, and the existing `OutcomeUnknown`/reconciliation
disposition remains authoritative.
```

### P9 `07` — §4 AH7 crash-injection matrix

```md
**AH7 lease-owner qualification.** A P9 AH7 cross-generation process case uses
the production P2 execution path: G0 obtains generation 0, commits P4 effect
admission, and the external effect occurs before settlement; G1 obtains its
own later generation through `LeaseService`, does not re-execute the
NonIdempotent effect, and follows the existing P4/P9 unknown/reconciliation
disposition; any late G0 terminal write is rejected by the existing full
fence. Two processes that were merely given the same copied holder tuple are
not two P2 lease generations and do not qualify as the real takeover case.
```

## Qualification evidence and gate sequence

The required G0/G1 replacement oracle is already represented in the current
tree by:

- `tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`
  and `planning/results/P4-AH7-tool-settlement-lease-fence.result.md`: actual
  production daemon G0/G1, effect after admission, no G1 executor replay,
  G0 late settlement fence rejection, one effect marker and final
  `OutcomeUnknown` without successful ToolResult/Observation. The test uses a
  test-only SQL expiry fast-forward in the isolated DB, then obtains G1 through
  the real `LeaseService`; it does not wait for natural TTL passage.
- `tests/functional/process/p4-ah7-live-lease-acquisition.functional.test.ts`:
  two production daemons; while G0's lease remains live, G1's production
  acquisition is rejected before any new P4 invocation.

Both tests are under `vitest.functional.config.ts`'s default process include;
their scoped successful results are already recorded. This package does not
expand those results into AH7 closure.

The static census found four same-holder concurrent P4 Runtime oracle groups
in the default root Vitest include:

| Current source | Concurrent shape / oracle | Accepted classification after landing |
|---|---|---|
| `packages/tool-runtime/test/p4-ah7-concurrent-invocation.test.ts` | Two overlapping `ToolRuntimePort.invoke` calls share the same `ToolExecutionContext`/fence; mock store; asserts one Executor effect, one durable Success, and one `IntentJournal` error. | Move unchanged strict assertions to `.diagnostic.ts`; exclude from default core. |
| `adapters/persistence-sqlite/test/p4-ah7-concurrent-invocation.test.ts` | Two overlapping `invoke` calls share one Execution/invocation/fence and SQLite `:memory:` state; asserts one effect and durable Success. | Move unchanged strict assertions to `.diagnostic.ts`; exclude from default core. |
| `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`, case `runs both independent ToolRuntime connections…` | Two Runtime layers/connections invoke concurrently with the same context and seeded holder tuple; asserts one effect/Success. | Move unchanged runtime case to `.diagnostic.ts`; exclude from default core. |
| `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`, cases `releases two OS processes…` and currently `it.skip` `pending diagnostic: direct unleased P4 reentry…` | Two OS processes receive the same seeded holder tuple and invoke/re-enter the same P4 call. The skipped case also receives the full `executionFence` in the current test child despite its historical “unleased” title; it asserts A=Success/B=OutcomeUnknown and final durable Success. | Move both cases unchanged to `.diagnostic.ts`; make the historical strict case runnable only in the diagnostic config. Neither is a valid G0/G1 qualification. |

The first case in `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`, `converges exact same-invocation intent claims to one durable row across connections`, is Store-only and makes no ToolRuntime/Executor claim; preserve it in default core as `adapters/persistence-sqlite/test/p4-ah7-intent-claim-concurrency.test.ts`.

Before moving any Runtime case, add a default Store-level effect-admission CAS
case at `adapters/persistence-sqlite/test/p4-ah7-effect-admission-cas-concurrency.test.ts`:
two independent SQLite connections compete to admit the same exact, already
persisted invocation. Assert one successful `NotAdmitted → MayHaveStarted`
update, one canonical row and the losing store call's existing typed
`PersistenceCorruption<"ToolInvocationStore">` compare-and-set no-apply result.
The case has **no Executor** and must not claim a single-Executor guarantee. The
existing single authorized production invocation path and the real P2 G0/G1
process tests remain the evidence for actual Executor count and lease takeover.

After the owner-document package is accepted and the recorded P4 G0/G1 evidence
is accepted as satisfying the qualification prerequisite, the proposed
separate implementation change is:

- preserve the Store-only intent-claim case in default core;
- add/run the Store-only effect-admission CAS case in default core;
- keep `tests/functional/process/p4-ah7-live-lease-acquisition.functional.test.ts`
  and `p4-ah7-tool-settlement-lease-fencing.functional.test.ts` in the default
  functional process suite;
- move the four same-holder Runtime groups above into runnable diagnostic
  files, preserving every strict oracle and retaining the v19 full-gate reds.

Use these exact diagnostic paths and root config:

```text
packages/tool-runtime/test/p4-ah7-concurrent-invocation.diagnostic.ts
adapters/persistence-sqlite/test/p4-ah7-concurrent-invocation.diagnostic.ts
adapters/persistence-sqlite/test/p4-ah7-same-holder-runtime-concurrency.diagnostic.ts
vitest.ah7-same-holder-diagnostic.config.ts
```

The diagnostic config explicitly includes only those three `.diagnostic.ts`
files and runs them with `pnpm exec vitest run --config
vitest.ah7-same-holder-diagnostic.config.ts`. Their filenames do not match the
root `**/test/**/*.test.ts` include, so they contribute zero pass/fail cases to
default core and remain manually runnable. No `it.skip` is used for the moved
strict same-holder diagnostics. No oracle is weakened or deleted.

## Cross-owner consistency review checklist

An independent landing review must confirm before the user is asked to accept
this package:

1. P2 `02`/`03` provenance text matches `LeaseService.acquire` and
   `runExecution`; wake delivery remains distinct from lease authority.
2. P3 `08` serial text matches the current `model-output-journal` action loop
   and does not block ordered result/cursor recovery.
3. P4 `02` caller boundary is consistent with P4 `06`'s current-fence checks
   and `MayHaveStarted → OutcomeUnknown` rules; no invocation-owner field or
   new replay path is implied.
4. P9 `07` uses the existing AH7-AP8/T4 outcome and does not treat the
   same-holder cloned-context test as a G0/G1 recovery pass.
5. The two P4 process qualifications satisfy the selected replacement oracle;
   the SQL expiry fast-forward caveat is explicit and does not overclaim
   natural TTL qualification.
6. The default test classification change occurs only after package acceptance
   and the existing real takeover qualification is revalidated on the accepted
   base. All five same-holder Runtime test functions listed in this package
   move to runnable diagnostics with their oracles unchanged; the store-only
   intent CAS, effect-admission CAS, live-lease rejection and G0/G1 post-effect
   takeover remain default qualification.
7. The full-gate reds remain in audit history and strict same-holder diagnostics
   remain runnable, but neither is counted as a default pass.
8. No SD/DID top-level change, SQL/port/failure-tag change, CAPA/P38 approval
   scope change, or AH7-DG-01/DG-02/InvocationApproval closure is introduced.

## User confirmation required

The user already chose the high-level behavior against proposal SHA-256
`FBCBAB1D2A3EE245A8561C683C460EF8F7329DC72A47D3AAC92B18C564ADBB76`. This
package fixes the exact owner text and default-gate prerequisite that were not
included in that proposal. It is a new fixed landing package and therefore
requires independent review followed by explicit user confirmation of this
package's own SHA-256. Until then, no `docs/design/**` edit or default-test
classification change is authorized.

