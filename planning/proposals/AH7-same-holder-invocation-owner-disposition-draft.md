# AH7 Same-holder P4 Invocation Race — Owner Disposition Proposal

Date: 2026-10-12  
Status: **DRAFT for P4/P2 owner decision; not accepted; no implementation authorization.**  
Evidence baseline: `0f277366f15ef7f10e36dee6b6c536c5785d4c13`

## Decision requested

Decide whether P4 supports two concurrent `ToolRuntimePort.invoke` callers for
the same `(ExecutionId, ToolInvocationId)` while both carry the exact same
active P2 lease-holder tuple, and fix the qualification ownership of that case.
The decision must state whether one caller may commit terminal
`OutcomeUnknown` while another caller with the same valid fence is still
executing the already-admitted non-idempotent effect.

Until a decision lands, retain both complete failure evidence and the strict
oracle. Do not turn the full-gate failure green by weakening the `Success`,
one-effect or canonical-settlement assertions, and do not declare AH7 closed.

## Observed fixture and failure evidence

The default core case is
`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`
(`releases two OS processes from the same pre-invocation barrier and commits
one NonIdempotent effect`). It manually seeds one active lease row; both child
processes pass the same complete fence:

```text
ExecutionId:             exe_018f2b3c-4d5e-7abc-8def-0123456789a1
workerId:                worker:ah7-cross-connection
workerIncarnationId:     incarnation:ah7-cross-connection
fencingGeneration:       0
```

The test does not call P2 `LeaseService.acquire`, production `runExecution`, or
the production Scheduler/AgentLoop. It blocks both independent ToolRuntime
instances in `ToolDefinitionStore.definition`, releases them against the same
exact `ToolInvocationId` and callRef, and asserts one external effect, one
successful caller, and final durable P4 `Success`. The case has failed in two
central full-gate attempts at the strict success-count assertion with
`Success filtered=[]`; Provider tests were green. A prior complete P36 run had
reported a green suite, so the earlier pass does not erase the later reds.

The production runtime's early re-entry branch sees an existing
`MayHaveStarted` NonIdempotent invocation and can write `OutcomeUnknown` using
the same valid fence. SQLite accepts the settlement when the exact lease row
is still active, including while the first caller has performed its effect but
has not yet committed `Success`. This is a statically observed race path; the
current full-gate diagnostics did not capture its exact interleaving.

After an explicit gate release, this worktree added a failure-only test
diagnostic that reports both worker outcomes/error tags/stages, the canonical
invocation and lease tuple from one joined SQLite query, and effect markers
before the unchanged assertions. Prerequisite `pnpm build`, test TypeScript
check and Biome passed. Five serial focused no-retry runs then passed 5/5; the
diagnostic did not fire. These five focused passes do not explain or cancel
the two full-gate reds.

The older deterministic test
`it.skip("pending diagnostic: direct unleased P4 reentry …")` uses a different
fixture: its ToolExecutionContext has no P2 ExecutionOrigin/lease fence. It
must not be treated as proof that production P2 dispatch permits two owners.
Keep it distinct from the current full-fence, same-holder case.

## Frozen-contract reading

- P2 `03` defines a process incarnation and a monotonic generation; a live
  Execution lease has one holder. The complete tuple and expiry are checked
  in the same transaction as worker-originated writes. `runExecution` acquires
  that lease before driving; the production AgentLoop journal processes model
  actions sequentially.
- P4 `01`/`06` binds a call to `(executionId, invocationId)`. It persists
  `NotAdmitted → MayHaveStarted` before Sandbox/Executor, forbids blind
  non-idempotent replay, and requires the complete current P2 fence on every
  P4 mutation. The durable P4 state contains no invocation-attempt owner token
  beyond the effect-admission marker and execution lease tuple.
- P9 `02` T4 and AH7-AP8 require an ambiguous non-idempotent effect to remain
  reconciling or become `OutcomeUnknown`; a stale generation must be rejected
  before its write and cannot prove that an already admitted effect did not
  occur. P9 also says SQLite concurrency alone is not process-crash evidence.

The exact clone-holder fixture does not model two independently acquired P2
leases: it gives two OS processes one copied holder identity. P2 therefore does
not establish it as a valid two-worker case. However, the APIs do not separately
specify same-process overlapping P4 calls with that same holder either. If that
is intended capability, P4 needs an explicit invocation-level ownership rule;
the current schema/runtime cannot distinguish the effect owner from a
same-fence reentrant caller. This is the decision point, not a conclusion that
the full-gate red is harmless.

## Proposed fixed disposition — supported P2 path plus explicit boundary

Adopt Option C with Option B as the default recovery qualification:

1. **P2 remains the owner of cross-worker eligibility.** A real same-Execution
   second worker must obtain a fresh LeaseService acquisition after generation
   0 expires. Do not construct a second worker by copying generation 0's
   holder tuple.
2. **Qualify a genuine generation takeover.** In the public production daemon
   path, generation 0 persists intent and `MayHaveStarted`, performs exactly
   one non-idempotent marker effect, then pauses before settlement. Prevent its
   renewal through the test-only process probe; let the real lease expire and
   let generation 1 acquire through LeaseService. Generation 1 must not call
   the Executor again. It follows existing P4/P9 non-idempotent ambiguity
   disposition (`OutcomeUnknown` or the already specified active/reconciling
   gate). Releasing generation 0 after takeover must yield
   `LeaseFencingRejected`, with no stale settlement overwrite. Assert the
   single effect, both exact generation tuples, terminal/reconciling durable
   state, action/ToolResult/Observation consequences, and one Provider
   decision. No direct SQL writes to lease, intent, or settlement rows.
3. **Preserve the cloned-holder race evidence verbatim.** Keep its strict
   `one Success + one effect + durable Success` oracle and historical red
   results. If the owner confirms that a duplicated WorkerIncarnationId across
   OS processes is outside supported P2, move this case out of default
   qualification into a clearly named pending/unsupported diagnostic and
   replace default core coverage with an exact store-level intent/effect-
   admission CAS race plus the real P2 takeover above. Do not count the
   unsupported diagnostic as a pass.
4. **Do not add durable P4 owner fields in this disposition.** The runtime
   keeps the current fail-closed behavior for a new-generation recovery of an
   unsettled `MayHaveStarted` NonIdempotent invocation; a new generation may
   establish uncertainty but may not replay the effect or accept an old
   generation's result.

This disposition does not claim overall AH7 closure; it qualifies only P4
same-invocation concurrency ownership and AH7 stale-settlement behavior.

## Alternatives the owner must explicitly accept or reject

| Option | Result | Required owner decision |
|---|---|---|
| A. Support concurrent same-holder invokes as a P4 capability | Add invocation-level single-owner/wait so a competing call cannot terminalize `OutcomeUnknown` ahead of a still-active effect owner. A process-local mutex is insufficient for multiple ToolRuntime processes/connections. | Specify owner identity, when contenders wait versus return, how a crashed owner relinquishes ownership, how takeover is bounded by P2 lease expiry, and how recovery settles after owner death. If this adds persisted owner/attempt evidence or changes P4/P9 crash disposition, land the owning contract and authorization before migration/production code. Keep the strict cloned-holder Success oracle in the default suite. |
| B. Treat the two calls as real P2 generations | Old generation is fenced; current generation follows existing NonIdempotent ambiguity disposition and never replays. | Accept as the only supported cross-worker race; old generation's `Success` is not authoritative after takeover unless reconciliation proves it. |
| C. Keep P4 store atomicity and P2 ownership as separate qualification layers (**proposed**) | Store-level exact-intent/effect-admission CAS remains a focused component test; real worker takeover covers before/after generation fence and recovery. Cloned-holder execution remains pending/unsupported while strict oracle/history are retained. | Confirm that two OS processes may not share one WorkerIncarnationId as concurrent holders and that production same-holder AgentLoop dispatch remains serial. Then authorize only the scoped test promotion/demotion and real P2 process qualification. |

## Acceptance criteria if Option C is accepted

- The exact cloned-holder test remains stored with its unmodified strict oracle
  and both full-gate red references; its classification as unsupported is
  visible and it contributes zero passing cases.
- Default P4 component qualification proves one exact intent, one successful
  `NotAdmitted → MayHaveStarted` admission, and one executor call; contenders
  cannot mint another admission or terminalize the record as no-effect.
- Real daemon takeover obtains generations through P2 LeaseService, not test
  SQL. Generation 0's external effect occurs once; generation 1 does not
  re-execute; stale generation 0 settlement returns `LeaseFencingRejected`;
  the canonical settlement and AgentLoop observation match the existing P4/P9
  non-idempotent ambiguity contract.
- Both pre-existing full-gate failure records and the bounded 5/5 targeted
  pass record remain in audit history. Full `pnpm check` after the test
  disposition must be coordinated in the shared qualification window.
- No change to `docs/design/**`, no schema migration, no new P4 failure tag,
  and no AH7-wide closure claim under this package.

## Authority and status

This proposal selects the test/qualification boundary above for owner review;
it is **not accepted** and authorizes no production change, schema change, test
promotion/removal, or claim that AH7 is closed. If P4 owner rejects Option C
and selects Option A, stop and land the fixed ownership/recovery contract
through manual governance before implementation.

