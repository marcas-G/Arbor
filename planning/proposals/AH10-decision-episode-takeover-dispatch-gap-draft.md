# AH10 DecisionEpisode expired-lease takeover dispatch — Design Gap draft

Status: **DRAFT / independent review complete / awaiting manual governance / no implementation authorized**
Date: 2026-10-07
Scope: AH10 generation takeover for the frozen `DecisionEpisode` binding.

## Failure evidence

The isolated real-process test
`tests/functional/pending/ah10-select-current-work-takeover.functional.test.ts`
uses the production daemon, a fresh SQLite database, public Project/Work setup,
and the real 30-second lease. Public/model-facing steps lead the Scheduler to
persist a `WorkSelectionDecisionRequest` for two runnable Work candidates and
admit a `DecisionEpisode` at request revision 0. The provider returns one
`select_current_work`; the test-only child probe pauses exactly after that
ActionIntent is durable.

The gen0 DecisionEpisode lease expired. A second production daemon then started
against the same database, but during a bounded 45-second observation it
acquired no lease for the target or any other execution. Read-only SQLite
showed the target lease still at generation 0 and expired; the exact
DecisionRequest was Pending/revision 0; the exact Action remained Pending with
no Observation; there was no SelectCurrentWork Command receipt; and the
Workspace selection was unchanged. The only other execution was the initial
Work Episode, already settled through a durable SettleExecution command with
its Manual wait registered. B/C were the only runnable candidates; no
InboxEpisode existed. The daemon's HTTP startup succeeded and its captured
stderr was empty.

Reproduction command:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-select-current-work-takeover.functional.test.ts -t before
```

Result: **RED at gen1 lease acquisition**. It does not reach the old owner's
FencingRejected receipt boundary and is not an AH10 takeover PASS.

## Frozen-contract basis

- `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` §2
  requires receipt-first takeover; a prior FencingRejected ends the old
  CommandId but permits a new generation CommandId when the same LogicalAction
  remains Pending and eligible.
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md` AH10
  qualifies generation-scoped Command takeover and AH1–AH14 require recovery
  evidence at the relevant durable boundaries.
- `docs/design/implementation/P2/06-recovery-skeleton.md` §4 and §4A say an
  unsettled Execution without a deterministic settlement remains Active for
  Scheduler re-evaluation/re-dispatch; resumable durable AgentLoopStep progress
  is re-dispatched under a current lease.
- `docs/design/implementation/P9/02-fault-injection-matrix.md` §9 DF2 says the
  next periodic/event-triggered sweep re-evaluates and re-dispatches after a
  lost dispatch, with bounded takeover latency.
- System Design v1.9 / DID v1.31 EGP contract (`docs/design/02-system-design.md`
  §1.4; `docs/design/03-detailed-implementation-design.md` §8.18A) defines
  `DecisionEpisode` as a durable Workspace execution episode bound to the exact
  `WorkSelectionDecisionRequest`; EGP-5 says every episode uses the same Agent
  Loop.
- Problem & Goals v1.3 G7 and success criterion 6 require process/Runtime
  restart recovery from durable state.

This evidence does not decide whether the missing redelivery is a contract gap
or an implementation omission. No owner contract is revised here.

## Root-path evidence

In the current daemon tick, `apps/single-workspace/src/main.ts` calls
`consumeWorkspaceWake`; the Scheduler returns Noop while a Main Execution is
active. The following `resumeActiveWork` path returns when
`workEpisode(active.value) === null`, so it does not run `preDispatchCheck` or
`runExecution` for an active `DecisionEpisode`. The periodic/startup recovery
path in `packages/execution-runtime/src/recovery.ts` evaluates deterministic
completion, stop and reconciliation settlement conditions; it does not
redispatch the Agent Loop. This matches the observed absence of a gen1 lease
event, but governance should confirm whether those are the intended owners for
DecisionEpisode takeover.

## Human governance questions

1. Does the AH10/G7 recovery contract require expired-lease takeover for every
   exact workspace episode binding (Work, ConversationResponse, Inbox,
   Decision), or is its execution scope narrower?
2. Which frozen contract owns redispatch of an unsettled, expired-lease
   DecisionEpisode: the general execution recovery boundary or the Scheduler
   wake/active-execution boundary?
3. What invariant prevents a new owner from admitting a second episode or
   re-evaluating a stale candidate while it resumes the original Decision?
4. Is the test's expected same-execution generation takeover consistent with
   the frozen control-action/action-intent replay contract for
   SelectCurrentWork?

## Non-authoritative alternatives for review

These are boundaries for manual governance to consider, not accepted semantics:

1. Keep the broad episode contract and clarify the responsible recovery
   boundary so an expired active DecisionEpisode resumes under the same durable
   episode and LogicalAction identity.
2. Narrow the qualification scope only if the owning frozen contracts
   explicitly permit DecisionEpisode not to resume; define how its durable
   Pending DecisionRequest and active Execution are then handled without
   treating an expired lease as active authority.

Do not implement either alternative or change `docs/design/**` from this draft.
If accepted, the governance package must name the owning document, exact
semantic resolution, and post-landing consistency evidence before separate
implementation authorization.

## Closure evidence after governance

At minimum, repeat the test with real dual daemons and production TTL; prove
the old DecisionEpisode owner cannot write after takeover; observe the exact
old FencingRejected receipt commit boundary; let the new generation read the
receipt and commit one canonical SelectCurrentWork effect; and assert one
Submitted DecisionRequest, one CurrentWorkChanged transition, one Action
Observation, no new Decision Provider request, and the selected Work visible
through the public current-work view. Cover receipt commit before and after
process kill if the accepted scope retains both boundaries. Keep this
qualification separate from any broader AH10 closure claim.
