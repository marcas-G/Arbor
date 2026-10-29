# P12-DG-01 — D2/D4 Progress-Signal Convergence Fixed Package

Status: **REVISION 2 — PROPOSED FOR P12 OWNER / MANUAL GOVERNOR DECISION; NOT ACCEPTED**
Decision token proposed: `ACCEPT_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE`
Base: `852ed5728faae3fb365a828804b85bc7940cf72a`  
Prepared: 2026-10-24

This revision retires the earlier fixed-package draft and its decision token;
only the token shown above is proposed for consideration.

## 1. Decision requested

Resolve the conflict between P12 `08` §3/§5/§7 and the DID v1.20 successor
note in P12 `00` with one shared progress contract:

> The single `durableProgress` observation is the shared D2/D4 progress
> signal: it is true only if, since the preceding ProviderTurn boundary, at
> least one AgentAction (control or executable) reached a successfully terminal
> sourced outcome that has been durably committed, or an attributable
> authoritative application/canonical mutation was committed. The same true
> signal clears D2's repeated-fingerprint history and resets D4's consecutive
> no-progress-turn counter. Typed Failed/Denied/Rejected outcomes remain
> durably sourced and available in model context but do not count as safety
> progress. Provider-result journaling, AssistantMessage/ModelOutput-only
> commits, AgentLoopStep state progression, and P9 recovery/handoff bookkeeping
> do not count on their own.

This deliberately governs the coupled D2/D4 reset effect: narrowing the signal
also narrows when D2 fingerprints clear. P2 continues to own the gate and both
dimension counters at `ExecutionDriverPort`; P3 reports the boolean at the
next ProviderTurn boundary. D2's count/threshold algorithm, `MAX_TURNS`,
restart reset behavior, stop/settlement behavior, and Work lifecycle remain
unchanged; D2's reset trigger changes to the shared qualified signal.

## 2. Why this interpretation

The shared D2/D4 signal distinguishes model progress through successful,
durably settled actions or authoritative effects from repeated requests and
repeated unsuccessful action loops. Counting every monotone AgentLoopStep or
Provider-result journal transition would clear D2 and reset D4 on output-only
or no-action sampling, defeating that distinction. Excluding those records
from the safety signal does not weaken P9 recovery: they remain durable
recovery evidence and continue to drive the existing resume/handoff state
machine.

An `AgentAction` is the common boundary for executable and control work. A
Failed/Denied/Rejected terminal sourced result is still persisted and supplied
to the model as corrective context, but does not clear either safety history;
the model may correct within the configured D2/D4 thresholds, and repeated
failures remain bounded by D2, D4, and the unchanged `MAX_TURNS` final loop
bound. An unresolved/unknown side effect is not successful progress; existing
reconciliation authority remains in force.

## 3. Current implementation evidence at the base

Inspected source at the stated base; no production/provider process was run.

| Source path | Current behavior | Relationship to proposed rule |
|---|---|---|
| `packages/agent-runtime/src/agent-loop-driver.ts` | `progressedSinceBoundary` is reported to `admitActivity` for `ProviderTurn`, then cleared; after action execution it is ORed with `actionProgression.durableProgress`. | Correct boundary/reset shape. |
| `packages/execution-runtime/src/runtime-safety.ts` | The same `observation.durableProgress === true` clears `state.fingerprints` for D2 on activity admission and resets `state.noProgressTurns` for D4 at ProviderTurn. | **Coupled behavior confirmed:** changing the progress producer intentionally changes both D2 and D4 reset timing. This proposal explicitly governs that convergence; it does not claim independent reset semantics. |
| ProviderTurn activity construction in `agent-loop-driver.ts` | Uses `fingerprint: \`turn-${turn}\``. | **D2 producer mismatch:** loop ordinal is not a semantic request identity. Replace with a compiled-request semantic hash, made available to the gate after local request compilation but before any provider network call. |
| ToolInvocation activity construction in `agent-loop-actions.ts` | Uses `tool:${invocation.toolName}:${invocation.callRef}`. | **D2 producer mismatch:** callRef is an identity, not action payload; two equivalent action payloads with different callRefs evade D2. Replace with a fingerprint over route/tool name and canonical semantic arguments, excluding callRef. |
| Existing request-manifest validation in `model-decision.ts` / P3 recovery | `compiledRequestHash` is persisted/validated against serialized compiled request data. | Useful existing semantic-hash precedent, but this audit did not establish that the value is available at the current gate callsite before provider dispatch. Pre-network availability and exact hash equivalence are implementation/qualification requirements, not claimed existing wiring. |
| `recordAcceptedModelOutput` and `completeAgentLoopStep` calls in the driver | They do not directly set `progressedSinceBoundary`. | Assistant/model-output and step completion alone are already excluded. |
| `packages/agent-runtime/src/agent-loop-actions.ts`, `persistActionObservation` | Persists typed `ToolResult` or `ControlResult` (typed-timeline path), or sourced Observation (legacy path), and transitions the current Pending AgentAction plus action cursor in a fenced transaction; returns true after that transaction. | Supplies terminal action settlement signal. The caller sets progress only after persistence returns. |
| `persistActionObservation` precondition failure | Returns false when action/step/fence is absent or the step is not `ActionsInProgress`; callers append only an in-memory observation in that case. Several callers nevertheless set `durableProgress = true` unconditionally after the persistence attempt. | **Concrete producer mismatch:** a model-usable error/denial/rejection may be counted despite no persisted terminal sourced result. The implementation wave must set the shared signal true only if qualifying persistence succeeded or separate attributable authoritative mutation evidence exists. |
| `agent-loop-actions.ts` invalid-arguments, authorization-denied, and model-usable-rejection paths | Persist sourced typed results with Failed/Denied status and then set `durableProgress = true`. | **Semantic mismatch:** those outcomes remain persisted and model-visible, but must not clear D2 or reset D4; repeated failure remains safety-bounded. |
| `agent-loop-actions.ts` successful executable/control paths | After handler completion, persist sourced result and set progress; outcomes carrying `durableActionCommit` set progress after applying its returned loop-step value. | Consistent where a first terminal sourced result or attributable authoritative mutation committed. Qualification must assert source durability, not merely an in-memory outcome. |
| `packages/agent-runtime/src/agent-loop-policy.ts` | `MAX_TURNS = 24`. | Must not change in this package. |
| `tests/p12-runtime-safety.test.ts` | Exercises the gate's true-reset/false-increment/absent-as-false behavior, not the full producer signal classification. | Existing gate evidence stays; producer and boundary qualification is added in implementation. |
| `docs/design/implementation/P12/08-runtime-safety-completion.md` §5 vs §7; P12 `00` DID v1.20 successor note | §5 includes AgentLoopStep/sourced Session or Observation commits; §7 narrows the driver's signal; successor note explicitly says AgentLoopStep progression counts. | This textual inconsistency is the open governance gap; the accepted landing must reconcile all three statements. |

The proposal does not claim the current source is fully qualified: existing
tests do not prove all signal categories, replay boundaries, or that P9-only
recovery transitions cannot set the shared signal true. The false-return
branch above is an identified signal-source defect, not merely a missing test.

## 4. Owner landing targets (after explicit acceptance only)

1. **P12 `08-runtime-safety-completion.md` §3 D2/D4 rows and §5**: specify the
   coupled D2/D4 reset trigger from §1, successful terminal outcomes and
   attributable authoritative mutations only; Failed/Denied/Rejected remain
   model-visible but do not clear either safety history.
2. **P12 `08` §7 D2/D4 rows and D4 rule**: state that the same observation
   boolean drives both reset effects, while preserving D2's count/threshold
   algorithm and D4's next-ProviderTurn boundary.
3. **P12 `08` §7A / §7B / §10**: preserve P2 ownership and in-process reset,
   remove any implication that P9 handoff bookkeeping is D4 progress, and add
   producer/fingerprint qualification below. D5/D6, lease fencing and P9
   recovery semantics do not change.
4. **P12 `00-contract-index.md` DID v1.20 successor note**: remove the sentence
   that monotone AgentLoopStep progression counts as D4 evidence; state that
   those transitions remain P9 recovery evidence but do not independently
   raise the shared D2/D4 progress signal.
5. **P12 `14-acceptance.md`**: add producer-side shared-signal and semantic
   fingerprint qualification to acceptance mapping, retaining existing gate
   tests and adding focused P3 producer tests. No P12 closure until all
   pre-existing blockers are evidenced.
6. **P3 `03-agent-loop-driver.md` and `08-agent-loop-step-handoff.md`**: define
   the producer boundary, pre-network request identity, terminal settlement
   qualification and P9 distinction. P3 Agent Runtime owns wiring in
   `agent-loop-driver.ts`, model-decision's compile/dispatch seam and
   action-settlement signal flow.
7. **P2 `02-port-contracts.md` §5**: preserve gate ownership and the existing
   observation port; clarify its existing `durableProgress` field is the
   shared D2/D4 reset signal. P2 owns unchanged D2/D4 count/threshold
   algorithms. P12 owns the new shared reset semantics and acceptance. No
   port widening.

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
- The single shared progress observation clears both D2 fingerprints and
  D4's no-progress count. This is an intentional D2 reset-trigger change;
  D2's threshold/count algorithm remains unchanged. `MAX_TURNS` remains 24.
  Execution safety-stop settlement and Work state do not change.
- Unresolved/reconcilable side effects continue to follow the existing P3/P4/P9
  reconciliation gate; a D4 signal must not make an unknown effect appear
  safely settled.

## 6. Implementation waves (authorization required separately)

1. **Signal inventory and test-first**: add P3 producer and P2 gate tests for
   the shared D2/D4 boolean. Keep the persisted P2 port shape and counter
   algorithms unchanged.
2. **Narrow source classification**: expose/derive true only from a
   successfully terminal sourced AgentAction outcome after durable commit, or
   separately attributable authoritative mutation. Failed/Denied/Rejected and
   unresolved/unknown outcomes remain model-visible as applicable but do not
   set progress. Do not infer progress from AgentLoopStep revisions,
   provider-result records, sourced Session text alone, or P9 recovery state.
3. **Provider request fingerprint and pre-network gate**: replace `turn-N` with
   the semantic compiled-request hash (existing manifest field is a candidate).
   Refactor the compile/dispatch seam so the gate receives the hash after
   request compilation and before any provider network invocation; a Stop must
   be proven to make zero provider calls. The present source audit does not
   establish this ordering or hash availability at the current driver callsite.
4. **AgentAction fingerprint**: replace `toolName + callRef` with a stable
   digest of action route/tool name and canonicalized semantic argument payload;
   exclude callRef so regenerated identities do not evade D2. Test reordered
   object keys as equal and materially different arguments as distinct. The
   input arguments are present as `argumentsJson`, but current D2 code has no
   semantic-action codec; if the approved canonicalization cannot be applied
   without adding a new contract, keep that codec as a separately reviewed
   pending item and do not claim Action D2 qualification.
5. **Boundary wiring and qualification**: aggregate only qualifying commits
   since the previous ProviderTurn boundary and deliver the same signal to the
   D2 clear and D4 reset effects. Ensure replay/recovery cannot turn old facts
   into new progress. Run focused P3 producer/P2 gate tests, affected typecheck
   and lint; no real Provider or daemon is required for unit qualification.

## 7. Required qualification matrix

| Case | Shared progress signal | Required assertion |
|---|---:|---|
| AssistantMessage / ModelOutput committed, no AgentAction and no authoritative mutation | false | D2 fingerprints remain; D4 increments. |
| Provider success result journaled; AgentLoopStep moves monotonically with no action/effect | false | P9 recovery evidence does not clear D2 or reset D4. |
| Identical compiled semantic Provider request repeated with different loop ordinals | same fingerprint | D2 recognizes the same request; gate runs after local compile and before provider network call. |
| Tool/action payload repeated with a new callRef | same semantic fingerprint | D2 recognizes semantic repeat; callRef is excluded. |
| Same action payload with changed material argument | distinct fingerprint | D2 does not conflate different semantic actions. |
| Successful executable ToolInvocation reaches a durable sourced ToolResult | true | Same true signal clears D2 history and resets D4 after committed settlement. |
| Successful control action reaches durable sourced ControlResult/Observation | true | Same signal effect for control and executable actions. |
| Terminal sourced Failed, Denied, Rejected, or equivalent unsuccessful model-usable outcome | false | Result remains in model context; D2 history stays and D4 increments. |
| Attributable authoritative application/canonical mutation commits | true | Same signal clears D2 and resets D4; requires commit evidence and action attribution. |
| Unresolved/unknown effect, or mere P9 action/cursor/step recovery bookkeeping | false | No safety reset without success or authoritative commit. |
| One qualifying true followed by unsuccessful/false turn | clear/reset then retain/increment | D2/D4 observe the same persisted boolean; repeated failure remains bounded. |
| Repeated identical semantic fingerprint | D2 unchanged count/threshold | D2 counts until shared qualifying progress clears its history. |
| Turn loop reaches `MAX_TURNS` | unchanged | `MAX_TURNS = 24` remains final loop bound. |
| RuntimeSafetyGate reconstructed after restart | counter resets | Existing in-process restart behavior remains unchanged. |

## 8. Acceptance and review

The landing review must verify that §3 D2/D4 rows, §5, §7, §7A/§7B, §10, P12
`00`'s DID successor note, and P12 `14` say the same thing; that P2 count and
threshold algorithms, `MAX_TURNS`, and restart behavior did not drift; and
that every matrix row maps to a named focused test. It must specifically
review the D2 reset-trigger change, semantic request/action fingerprints, and
pre-network admission ordering. If semantic action canonicalization cannot be
shown from the accepted contracts, mark that sub-scope pending rather than
claiming it qualified. Governance acceptance is not implementation
authorization and does not claim P12 closure. This revision is the fixed
package for the token above; any material semantic change requires a new
governance decision.
