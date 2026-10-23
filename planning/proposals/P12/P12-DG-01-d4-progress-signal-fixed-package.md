# P12-DG-01 — D4 Durable-Progress Signal Fixed Package

Status: **PROPOSED FOR P12 OWNER / MANUAL GOVERNOR DECISION; NOT ACCEPTED**  
Decision token proposed: `ACCEPT_P12_DG_01_AGENT_ACTION_TERMINAL_D4_PROGRESS`  
Base: `852ed5728faae3fb365a828804b85bc7940cf72a`  
Prepared: 2026-10-24

## 1. Decision requested

Resolve the conflict between P12 `08` §5, §7 and the DID v1.20 successor note
in P12 `00` with the following one-sentence semantic rule:

> At each next `ProviderTurn` boundary, D4 `durableProgress` is true iff, since
> the preceding `ProviderTurn` boundary, at least one `AgentAction` (control or
> executable) reached a durable terminal sourced `Observation`,
> `ControlResult`, or `ToolResult`, or an attributable authoritative
> application/canonical mutation was committed. A first durable terminal
> outcome counts even when its typed status is Failed, Denied, Rejected, or
> otherwise unsuccessful, because the model can use that sourced outcome.
> Provider-result journaling, AssistantMessage/ModelOutput-only commits,
> AgentLoopStep state progression, and P9 recovery/handoff bookkeeping do not
> count on their own.

This is a signal-source definition only. P2 continues to own and implement the
D4 counter at `ExecutionDriverPort`; P3 reports the boolean at the next
ProviderTurn boundary. D2 repeated-action fingerprint handling, `MAX_TURNS`,
restart reset behavior, stop/settlement behavior, and Work lifecycle remain
unchanged.

## 2. Why this interpretation

The D4 safety purpose is to distinguish a model making progress through
durable, model-usable action outcomes or authoritative effects from repeated
sampling that produces no action. Counting every monotone AgentLoopStep or
Provider-result journal transition would let output-only/no-action resampling
reset D4 and therefore defeat that distinction. Excluding those records from
D4 does not weaken P9 recovery: they remain durable recovery evidence and
continue to drive the existing resume/handoff state machine.

An `AgentAction` is the common boundary for executable and control work. Its
first terminal sourced result is meaningful even when it reports a typed
failure, denial, or rejection; treating only successful effects as progress
would fail to acknowledge durable feedback that lets the model correct its
next action. Repeated fingerprints remain separately bounded by D2, and the
unchanged `MAX_TURNS` remains the final loop bound.

## 3. Current implementation evidence at the base

Inspected source at the stated base; no production/provider process was run.

| Source path | Current behavior | Relationship to proposed rule |
|---|---|---|
| `packages/agent-runtime/src/agent-loop-driver.ts` | `progressedSinceBoundary` is reported to `admitActivity` for `ProviderTurn`, then cleared; after action execution it is ORed with `actionProgression.durableProgress`. | Correct boundary/reset shape. |
| `recordAcceptedModelOutput` and `completeAgentLoopStep` calls in the driver | They do not directly set `progressedSinceBoundary`. | Assistant/model-output and step completion alone are already excluded. |
| `packages/agent-runtime/src/agent-loop-actions.ts`, `persistActionObservation` | Persists typed `ToolResult` or `ControlResult` (typed-timeline path), or sourced Observation (legacy path), and transitions the current Pending AgentAction plus action cursor in a fenced transaction; returns true after that transaction. | Supplies terminal action settlement signal. The caller sets progress only after persistence returns. |
| `persistActionObservation` precondition failure | Returns false when action/step/fence is absent or the step is not `ActionsInProgress`; callers append only an in-memory observation in that case. Several callers nevertheless set `durableProgress = true` unconditionally after the persistence attempt. | **Concrete producer mismatch:** a model-usable error/denial/rejection may be counted despite no persisted terminal sourced result. The implementation wave must set D4 true only if persistence succeeded or separate attributable authoritative mutation evidence exists. |
| `agent-loop-actions.ts` invalid-arguments, authorization-denied, and model-usable-rejection paths | Persist sourced typed results with Failed/Denied status and then set `durableProgress = true`. | Consistent with counting first durable typed terminal feedback regardless of success status. |
| `agent-loop-actions.ts` successful executable/control paths | After handler completion, persist sourced result and set progress; outcomes carrying `durableActionCommit` set progress after applying its returned loop-step value. | Consistent where a first terminal sourced result or attributable authoritative mutation committed. Qualification must assert source durability, not merely an in-memory outcome. |
| `packages/agent-runtime/src/agent-loop-policy.ts` | `MAX_TURNS = 24`. | Must not change in this package. |
| `tests/p12-runtime-safety.test.ts` | Exercises the gate's true-reset/false-increment/absent-as-false behavior, not the full producer signal classification. | Existing gate evidence stays; producer and boundary qualification is added in implementation. |
| `docs/design/implementation/P12/08-runtime-safety-completion.md` §5 vs §7; P12 `00` DID v1.20 successor note | §5 includes AgentLoopStep/sourced Session or Observation commits; §7 narrows the driver's signal; successor note explicitly says AgentLoopStep progression counts. | This textual inconsistency is the open governance gap; the accepted landing must reconcile all three statements. |

The proposal does not claim the current source is fully qualified: existing
tests do not prove all signal categories, replay boundaries, or that P9-only
recovery transitions cannot set D4 true. The false-return branch above is an
identified signal-source defect, not merely a missing test.

## 4. Owner landing targets (after explicit acceptance only)

1. **P12 `08-runtime-safety-completion.md` §5**: replace the current definition
   and its AgentLoopStep-progress sentence with the rule in §1; explicitly
   identify sourced terminal AgentAction results (including typed unsuccessful
   results) and attributable authoritative mutation as the only positive D4
   evidence. Clarify that a merely sourced AssistantMessage/ModelOutput or
   monotone step transition is insufficient.
2. **P12 `08` §7 D4 row**: make the row use exactly the same definition as §5,
   and preserve the next-ProviderTurn observation boundary.
3. **P12 `08` §7A / §7B / §10**: preserve P2's boolean-counter ownership and
   in-process reset, but remove any implication that P9 handoff bookkeeping is
   D4 progress; add the qualification obligations below. No change to P2
   counter algorithm, D2, D5/D6, lease fencing, or P9 recovery semantics.
4. **P12 `00-contract-index.md` DID v1.20 successor note**: remove the sentence
   that says monotone AgentLoopStep progression counts as D4 evidence; replace
   it with a cross-phase clarification that those transitions remain P9
   recovery evidence but do not independently count toward D4.
5. **P12 `14-acceptance.md`**: add producer-side D4 signal classification to
   the acceptance mapping, retaining existing gate tests and adding a focused
   P3 producer test target. Do not claim P12 closure until every pre-existing
   completion blocker is evidenced.
6. **Implementation owners**: P3 Agent Runtime owns production of the boolean
   (`packages/agent-runtime/src/agent-loop-driver.ts` and action-settlement
   signal flow); P3 `03-agent-loop-driver.md` owns the producer boundary and
   P3 `08-agent-loop-step-handoff.md` must retain the distinction between D4
   progress and P9 recovery evidence. P2 `02-port-contracts.md` retains
   gate/counter ownership; P12 owns the semantic definition and acceptance.
   No P2 port widening is requested.

No other frozen design document is reopened. No migration, event schema,
receipt, provider protocol, or durable counter is introduced.

## 5. Compatibility and safety

- Existing persisted Session entries, Provider-turn records, AgentLoopStep
  records, and P9 recovery evidence remain readable and retain their original
  recovery meanings. They are not rewritten or deleted.
- The D4 counter remains process-local and resets on daemon restart exactly as
  currently frozen by P12 `08` §3 / RG-11. This package does not make counters
  durable.
- No public command, event, port shape, database table, migration, or
  user-visible status is added.
- D2 fingerprint accounting and its reset semantics remain independent and
  unchanged. `MAX_TURNS` remains 24. This package does not alter execution
  safety-stop settlement or Work state.
- Unresolved/reconcilable side effects continue to follow the existing P3/P4/P9
  reconciliation gate; a D4 signal must not make an unknown effect appear
  safely settled.

## 6. Implementation waves (authorization required separately)

1. **Signal inventory and test-first**: add focused producer tests at the P3
   driver/action seam for the matrix below. Keep existing P2 gate tests.
2. **Narrow source classification**: expose/derive progress only from a
   committed terminal sourced AgentAction outcome or attributable
   authoritative mutation. Do not infer progress from AgentLoopStep revisions,
   provider-result records, sourced Session text alone, or P9 recovery state.
3. **Boundary wiring**: aggregate qualifying evidence only since the previous
   ProviderTurn boundary; report it once at the next boundary and reset the
   in-memory accumulator exactly as today. Ensure interrupted/recovery paths
   cannot accidentally convert bookkeeping into D4 evidence.
4. **Qualification**: run targeted P3 producer tests, P2 D4 gate tests,
   affected typecheck/lint, and acceptance mapping. No real Provider or daemon
   is necessary for semantic unit qualification; any later process qualification
   must be separately authorized and reported at its actual scope.

## 7. Required qualification matrix

| Case | D4 signal at next boundary | Required assertion |
|---|---:|---|
| AssistantMessage / ModelOutput committed, no AgentAction and no authoritative mutation | false | Output-only turn increments D4; does not reset it. |
| Provider success result journaled; AgentLoopStep moves monotonically with no action/effect | false | Recovery/handoff evidence does not reset D4. |
| First executable ToolInvocation reaches a durable sourced ToolResult, success | true | D4 resets after durable terminal action settlement. |
| First control action reaches a durable sourced ControlResult/Observation | true | D4 resets for control and executable action families alike. |
| First terminal sourced result is typed Failed, Denied, Rejected, or equivalent model-usable outcome | true | Typed feedback counts even without a successful mutation. |
| Authoritative application/canonical mutation commits and is attributable to the current AgentAction, even if its result uses a distinct settlement path | true | Progress requires commit evidence and exact action attribution. |
| Mere P9 action/cursor/step recovery bookkeeping, with no new terminal sourced action outcome or authoritative mutation | false | No reset from recovery bookkeeping alone. |
| P2 D4 `durableProgress:true` followed by a false turn | reset then increment | Existing counter semantics remain unchanged. |
| Repeated identical action fingerprint | independent of D4 | Existing D2 stop/count behavior remains unchanged. |
| Turn loop reaches `MAX_TURNS` | unchanged | `MAX_TURNS = 24` remains final loop bound. |
| RuntimeSafetyGate reconstructed after restart | counter resets | Existing in-process restart behavior remains unchanged. |

## 8. Acceptance and review

The landing review must verify that §5, §7, §7A/§7B, §10, P12 `00`'s DID
successor note, and P12 `14` say the same thing; that P2/D2/MAX_TURNS/restart
contracts did not drift; and that every matrix row maps to a named focused
test. Governance acceptance is not implementation authorization and does not
claim P12 closure. The proposal is a fixed package for the token above; any
material semantic change requires a new governance decision.
