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
successful caller, and final durable P4 `Success`. Keep two failure records
distinct:

| Evidence | Fixture and observed failure | What it establishes |
|---|---|---|
| Earlier reproduction at `6073ed9ad53816b8bca7444ca070f0ee924478d5`; `planning/results/AH7-P4-concurrent-settlement-owner-gap.result.md` | A deterministic **unleased** direct P4 re-entry held caller A after its effect and before settlement, then let caller B re-enter the same invocation. Runtime returned `A=Success`, `B=OutcomeUnknown`; one effect marker existed; durable settlement was `OutcomeUnknown`, not the expected owner `Success`. | An unleased P4 re-entry can terminalize Unknown before the effect owner commits its known Success. The accompanying production-path review did not establish P2 dispatch reachability. |
| Two central full-gate attempts on v19 baseline `0f277366f15ef7f10e36dee6b6c536c5785d4c13` | The current full-fence/two-process case failed at the strict success-count assertion with `Success filtered=[]`; Provider group was green. The full-gate output did not capture raw child results or the final invocation row. | The same-holder test is intermittently red under the full loaded gate. This does not establish durable `OutcomeUnknown` or identify either child's exact result. |

A prior complete P36 run reported a green suite; that pass does not erase the
later full-gate failures.

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
diagnostic did not fire. These focused passes do not explain or cancel the
two v19 full-gate reds.

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

The exact clone-holder fixture does not acquire two P2 leases; it copies one
lease tuple into two OS processes. That makes it unsuitable as evidence for
two independently authorized workers. It does **not**, by itself, decide
whether the P4 port supports concurrent calls with a same-generation context
inside one Worker process or through multiple ToolRuntime clients. The P4/P2
owners must explicitly decide that supported-call boundary before changing
the default test or implementation.

## Fixed owner decisions requested

### 1. Same-holder concurrent `invoke` support

Choose one:

- **Supported.** P4 guarantees one invocation-level executor owner for an
  exact `(executionId, invocationId)` even when same-holder calls overlap.
  A loser must wait or return a specified nonterminal result; it cannot write
  terminal `OutcomeUnknown` while an authorized owner can still commit its
  known result. Specify durable owner identity, cancellation, owner failure,
  and transfer after P2 lease expiry. With the current table fields, the same
  full fence does not distinguish two P4 callers. If persistent owner/attempt
  evidence is required, land the contract and obtain implementation
  authorization before migration or runtime code.
- **Unsupported.** Only the single P2-authorized Worker/serial AgentLoop path
  may invoke an exact pinned action at a time. Define same-process overlapping
  direct P4 calls and cross-process cloned-holder calls as outside the
  supported route. This boundary must be accepted by the P4/P2 owners; it is
  not inferred from the fact that the current test bypasses `runExecution`.

### 2. Keep three evidence claims separate

Option C is a **component-test scope only**:

1. `recordIntent` competition proves there is one exact `ToolInvocationId`
   row with matching intent.
2. `NotAdmitted → MayHaveStarted` CAS competition proves only that one
   admission transition is committed. `admitEffect` returns `Admitted`; that
   marker is not a durable invocation-owner token. This store-level case
   cannot prove how many callers invoke `Executor` and cannot be reported as a
   single-Executor result.
3. Exactly one Executor call can be claimed only in a single authorized
   production ToolRuntime invocation path, with the AgentLoop's serial action
   dispatch. This does not prove same-holder concurrent-call support.
4. A real two-worker qualification must use P2 `LeaseService` acquisition.
   It covers generation fencing and recovery, not same-holder arbitration.

### 3. Real P2 generation-takeover qualification

When a valid two-generation process case is scheduled, use the public
production daemon path and test-only process-local probes; do not write lease,
intent or settlement rows directly. Generation 0 persists intent and
`MayHaveStarted`, performs exactly one NonIdempotent marker effect, then
pauses before settlement. Prevent its lease renewal with the existing test
seam, allow real expiry, and let generation 1 acquire through `LeaseService`.
Generation 1 must not invoke the Executor again; it follows the existing
P4/P9 disposition for ambiguous NonIdempotent reality (durable `OutcomeUnknown`
or the already specified Active/reconciling path). After takeover, release
generation 0 and require its terminal write to fail `LeaseFencingRejected`
without overwriting generation 1's state. Assert one effect, exact holder
tuples, P4 settlement/reconciliation, and the existing ToolResult/Observation
consequences. This qualifies stale-generation fencing only.

### 4. Default-suite disposition remains pending

Keep the current same-holder test in its default location with the strict
`one Success + one effect + durable Success` oracle until the owners decide
whether that supported behavior is required. If they choose Unsupported, the
test may then move to a clearly labeled pending/unsupported diagnostic; retain
the complete strict oracle and full-gate RED history, and count it as zero
passing cases. If they choose Supported, keep it default and implement/qualify
Option A. Do not skip, demote, or weaken it in advance of this owner decision.

This proposal does not claim overall AH7 closure.

## Alternatives the owner must explicitly accept or reject

| Option | Result | Required owner decision |
|---|---|---|
| A. Support concurrent same-holder invokes | Define an invocation-level owner/wait protocol; a contending same-holder call cannot persist terminal `OutcomeUnknown` before the active owner settles. | Decide owner identity, contender behavior, owner death, lease-expiry takeover and NonIdempotent recovery. If durable owner evidence is needed, land the contract and implementation authorization first. Keep the exact Success oracle default. |
| B. Exercise valid P2 generations | Generation 0's stale settlement is rejected; generation 1 does not replay and follows P4/P9 ambiguity disposition. | Uses actual LeaseService/production runtime. This is separate evidence and does not decide same-holder support. |
| C. Separate component store CAS from Executor ownership | The store test asserts exact intent uniqueness and one `NotAdmitted → MayHaveStarted` transition only. A separate single authorized production path asserts one Executor call. | No Executor-count claim from the CAS test. P4/P2 still must decide same-holder support; C alone neither supports nor rejects it. |

## Acceptance criteria if the owners accept Option C as a component-test boundary

- The exact cloned-holder test and strict Success oracle remain unchanged until
  the same-holder support decision. If Unsupported is accepted, its pending
  classification is explicit and it contributes zero passing cases; if
  Supported is accepted, it remains default and needs Option A.
- Default P4 component qualification proves one exact intent and one
  `NotAdmitted → MayHaveStarted` transition. It asserts no Executor count.
- A separate single authorized production ToolRuntime call path proves one
  Executor call for one admitted invocation.
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

This proposal does **not** decide whether same-holder overlap is supported. It
is **not accepted** and authorizes no production change, schema change, test
promotion/removal, or claim that AH7 is closed. Keep the current default case
and its strict oracle unchanged pending P4/P2 owner decision. If same-holder
support is required, land the invocation-owner/recovery contract through
manual governance before implementation.

