# P12-DG-01 Revision 2 — D2/D4 Shared Progress and Semantic Fingerprint Implementation Plan

Status: **CONDITIONAL PLAN ONLY — governance acceptance and implementation authorization are not established**

## Authority and prerequisites

- Base candidate: `366b83045aa59338c8c416179c55de66334b9b9e`.
- Proposed owner package: `planning/proposals/P12/P12-DG-01-d4-progress-signal-fixed-package.md`, revision 2, SHA-256 `8E737E2F0E4C423D7A4AAD05B3F44CAA3E9C618DA1E451F3AB7F5C8F60AA5E71`.
- Proposed decision token: `ACCEPT_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE`.
- Current package manifest status: `PROPOSED_NOT_ACCEPTED`.
- The proposal's independent review is `PASS — Blocking = 0 for governance consideration`; it is not acceptance or implementation authorization.

This plan is a conditional implementation breakdown only. It neither exercises
the decision token nor authorizes implementation. Before source changes, the
manual P12 owner/governor must accept revision 2 (or issue a replacement
package) and separately authorize implementation. P2's existing gate/port
shape, D2/D4 algorithms, restart reset semantics, thresholds, P9 recovery
contract, and `MAX_TURNS=24` stay unchanged unless that accepted package says
otherwise. No `docs/design/**`, migration, durable counter, command, event, or
public port change is in scope.

## Current call-site and codec inventory

| Concern | Current source | Plan consequence |
|---|---|---|
| Shared gate effects | `packages/execution-runtime/src/runtime-safety.ts` | One `durableProgress=true` currently clears D2 fingerprints and resets D4; all producer changes must be tested against both effects. Keep this coupling and the counters/thresholds unchanged. |
| Provider D2 identity | `packages/agent-runtime/src/agent-loop-driver.ts` | Current fingerprint is `turn-${turn}` and admission happens before request preparation. Replace only after semantic request compilation and before the request can reach a provider adapter. |
| Existing compiled request fingerprint | `packages/model-context/src/compiler.ts`; replay validation in `packages/agent-runtime/src/agent-loop-step-recovery.ts` | `PreparedModelTurn.manifest.compiledRequestHash` is available before `ProviderRuntime.runTurn`; inference uses the existing FNV-1a encoding over `JSON.stringify({ request, toolRoutes })`. Reuse it as the opaque D2 request identity only after tests prove turn-ordinal/ProviderTurnId independence and semantic request sensitivity. Do not call it SHA-256 or change its persisted manifest meaning. |
| Provider request dispatch | `packages/agent-runtime/src/model-decision.ts` | Ordinary inference compiles before the existing direct `ProviderRuntime.runTurn`; place the gate at that compile/dispatch seam, not at a guessed loop ordinal. P9 settled-result replay must not dispatch a new request or be reported as progress. |
| Other provider dispatch sites | `packages/agent-runtime/src/compaction-coordinator.ts`, `packages/agent-runtime/src/conversation-checkpoint-compaction.ts` | These build Summary/Native requests separately. Each new Summary/Native, Conversation checkpoint, P20 overflow compaction/replacement ProviderTurn receives its own compile→gate→network boundary, with its existing operation-specific fingerprint source. |
| AgentAction D2 identity | `packages/agent-runtime/src/agent-loop-actions.ts` | Current fingerprint is `tool:${toolName}:${callRef}`. Replace callRef-based identity with a semantic envelope containing resolved route kind, action/tool name, and canonical semantic arguments; callRef/ProviderTurnId/step ordinal are correlation identities, not action semantics. |
| Progress producers | `packages/agent-runtime/src/agent-loop-actions.ts` | Several invalid-argument, authorization-denied, handler-rejected/model-usable, and persistence-fallback branches currently set `durableProgress=true` unconditionally. Inventory every assignment and make the signal depend on committed qualifying evidence. |
| Progress aggregation | `packages/agent-runtime/src/agent-loop-driver.ts` | `progressedSinceBoundary` aggregates action progression and is reported at ProviderTurn admission. Keep one boolean shared by D2/D4; do not infer it from Session text, Provider success, step revisions, or P9 handoff. |
| P9 recovery ordering | `packages/agent-runtime/src/model-decision.ts`, `packages/agent-runtime/src/agent-loop-step-recovery.ts`, `packages/agent-runtime/src/agent-loop-actions.ts` | Existing settled-result replay and reconciliation paths remain authoritative. A replay/handoff alone is false progress; `ReconciliationPending`/unknown external effects retain their existing gate precedence. |

### Fingerprint and canonicalization boundary

No new provider-facing, persisted, or public codec is required by revision 2.
Provider fingerprints are operation-kind namespaced and reuse each existing
path's stable opaque hash; this plan does not claim a unified hash algorithm or
authority hash. Inference uses the existing `compiledRequestHash` FNV-1a value
over `{ request, toolRoutes }`; Summary/Native compaction paths use their
existing SHA-256 of the compiled request. Conversation checkpoint and P20
overflow/replacement turns use the existing producer's hash for their
underlying operation kind. Keep these hashes as opaque D2 inputs and bind them
to the corresponding `operationKind`; do not alter persisted manifests or
recompute them with a new canonical wire codec.

Action D2 requires an internal candidate semantic-argument fingerprint:
canonicalize the parsed JSON argument value, include route kind and tool/action
name, exclude callRef and other ephemeral identities, then digest with the
existing SHA-256 utility. The implementation may use the existing sorted-key
canonicalization pattern, but the exact AgentAction codec qualification remains
**PENDING** until tests prove recursively reordered object keys equal and
materially different arguments/route/name distinct. Do not reuse the P39
closed-schema or AH14 safe-integer canonicalizer, and do not claim Action D2
qualified while the pending property matrix is incomplete. Invalid/unparseable
argument JSON must use a stable domain-tagged invalid-input key without
throwing before D2 admission; that path never counts as progress.

Existing canonicalization code is precedent, not a directly reusable general
codec: `provider-extension.ts` has a private sorted-key helper but does not
validate non-finite values, `canonicalizeRecoveryBindingV1` is a closed P39
schema, and `canonicalizeLegacyAdoptionEvidenceV1` permits only safe integers
and applies AH14-specific NFC rules. Do not couple AgentAction D2 to either
closed evidence schema. If implementation requires equivalence beyond the
revision-2 observable rules (for example schema-default expansion, Unicode
normalization, or argument coercion), stop and seek owner clarification rather
than inventing it.

## P41-constrained implementation boundary

Apply one D2/D4 admission to every **new ProviderTurn** after its own request
has been fully compiled and immediately before its `ProviderRuntime.runTurn`
call. This includes Inference, Summary, Native, Conversation checkpoint
Summary/Native, and P20 overflow compaction/replacement turns. Namespace the D2
fingerprint by the request `operationKind` and reuse that path's existing
stable opaque hash as described above. Each such new ProviderTurn is one D4
boundary; it consumes the current shared `progressedSinceBoundary` value once
and affects both D2 and D4 exactly as revision 2 specifies. Clear that
accumulator immediately after each new-boundary admission; any qualifying
action/effect committed afterward begins the value for the next new
ProviderTurn. This deliberately does not count internal ProviderAttempt
retries as new ProviderTurn admissions: the existing D1 retry observation
and D5 end bracket reuse the admitted activity and do not increment D2/D4.

A P9 settled-result replay is not a new ProviderTurn boundary: validate and
consume the pinned result without another D2/D4 admission or ProviderRuntime
call. Replayed ProviderResult/ModelOutput, old action result rows, Step/cursor
transitions, and P9 handoff records alone remain false progress. If replay
processing actually commits a **new** qualifying successful terminal action
outcome or attributable authoritative mutation, accumulate that evidence in
the existing `progressedSinceBoundary` boolean for the next new ProviderTurn;
otherwise the next new turn receives false. ReconciliationPending/unknown
effects remain ahead of any safety-stop settlement.

The revision-2 proposal remains `PROPOSED_NOT_ACCEPTED`; its acceptance token
and a separate implementation authorization are still required before source
changes. The boundary above records the implementation requirements from the
P41-constrained owner direction and removes the former operation-scope/replay
owner blockers; it does not manufacture governance acceptance or runtime
authorization.

## Conditional TDD work DAG

### Wave 0 — freeze evidence and red tests

- Verify the accepted revision-2 proposal SHA/token and implementation
  authorization; stop if either is absent.
- Record current gate behavior and every `ProviderRuntime.runTurn` call site
  (Inference, Summary/Native compaction, Conversation checkpoint compaction,
  and P20 overflow/replacement). Inventory every `durableProgress` assignment and categorize it as
  successful action settlement, attributable authoritative mutation,
  unsuccessful model-visible outcome, persistence failure, P9 replay, or
  bookkeeping.
- Add focused failing tests before production edits. Keep existing direct P2
  gate tests and assert D2/D4 reset coupling, count/threshold boundaries,
  `durableProgress` absent/false behavior, and RG-11 restart reset.

### Wave 1 — semantic fingerprint helpers

- Provider fingerprint: after each operation-specific request is compiled,
  form a D2 key from its `operationKind` and that path's existing stable
  manifest hash. Test identical Inference request/tool routes across different
  logical-step/ProviderTurn IDs yield the same FNV-based key; identical
  Summary/Native request bytes yield the same existing SHA-based key; changed
  input items, instructions, tool definitions/routes, output contract, or
  operationKind yield a different namespaced key. Verify the request was
  compiled before admission and admission completes before the network call.
- AgentAction fingerprint: implement the internal canonical-argument envelope
  from the owner-approved rules. Test recursively reordered object keys as
  equal; changed values, action kind, route kind, array order, or JSON type as
  distinct; changing only callRef/ProviderTurnId/step ordinal as equal. Test
  malformed and non-finite input handling and prove no argument text is logged
  or persisted as a fingerprint.
- Keep fingerprints in-memory only. Do not rewrite `AgentLoopStep.inputHash`,
  P4 recovery-binding hashes, P1 semantic fingerprints, or provider manifests.

### Wave 2 — per-new-ProviderTurn compile → gate → network ordering

- Refactor each P3 dispatch seam so request/manifest construction and the
  operation-specific existing fingerprint are complete before the ProviderTurn
  gate; each corresponding `ProviderRuntime.runTurn` must be the next
  provider-boundary effect after Continue, with no transport/network work
  beforehand. Cover Inference (`model-decision.ts`), Summary/Native
  compaction (`compaction-coordinator.ts`), Conversation checkpoint
  compaction (`conversation-checkpoint-compaction.ts`), and P20
  overflow/replacement paths. Use one shared admission helper so all callsites
  apply the same operation-kind namespace, D4 signal, and D5 bracket.
- Assert the ordered seam for every operation family:

  ```text
  build PortableModelRequest + exact manifest/source binding
  → obtain that path's existing stable opaque hash
  → construct ProviderTurn fingerprint = operationKind namespace + hash
  → admitActivity(ProviderTurn, retryCount=0, durableProgress,
      inFlight=begin, leaseGeneration, observedAt)
  → on Continue only, call ProviderRuntime.runTurn
  → admitActivity(same activity, real retryCount, inFlight=end, ...)
  ```

  The start admission must precede the first ProviderRuntime/adapter/network
  effect, and the end bracket must run once when that new ProviderTurn call
  finishes (including failure); it does not create another D2/D4 admission.
- Ensure a Stop returns through the existing `RuntimeSafetyStop`/settlement
  path with **zero ProviderRuntime calls**, zero new ProviderAttempt/network
  requests, and no fabricated Provider result. P9 reconciliation/unknown
  side-effect guards continue to take precedence as today.
- Apply exactly one D2/D4 admission per new ProviderTurn. Preserve D1 retry
  ordinal and D5 begin/end brackets; `inFlight=end` remains excluded from
  D2/D4 as current gate code specifies. ProviderAttempt retries reuse their
  existing admitted activity and never generate extra D2/D4 admissions.
- Maintain one shared progress accumulator across nested model-decision and
  compaction calls. Consume/clear it at each new ProviderTurn admission; a
  compaction/checkpoint/ProviderResult/Step bookkeeping commit does not set it
  again. Only a newly committed qualifying action/effect after that admission
  can set it for the next ProviderTurn boundary.
- P9 replay validates exact persisted manifest/result binding and consumes the
  settled result once without a new ProviderRuntime call or D2/D4 admission.
  Old ProviderResult, OutputAccepted, Step/cursor and recovery handoff facts
  remain false progress; only a newly committed qualifying action/effect is
  accumulated for the successor new ProviderTurn.

### Wave 2 test order matrix

Use a deterministic ProviderRuntime spy, with no network adapter, to verify the
same exact sequence for each callsite family:

| ProviderTurn family | Existing fingerprint source | Gate/network assertion |
|---|---|---|
| Inference | `compiledRequestHash` (FNV-1a over request + toolRoutes) | hash exists after `compileTurn`; gate is next; ProviderRuntime called only on Continue |
| Summary compaction | existing SHA-256 of compiled request | request/manifest built before gate; no ProviderRuntime call on Stop |
| Native compaction | existing SHA-256 of compiled request | same order; exact `CompactionNative` request hash is used |
| Conversation Summary/Native checkpoint compaction | existing per-path SHA-256 | same order, exact conversation source/owner binding retained |
| P20 OverflowCompaction | existing Summary/Native request hash | same order and P20 link/role remains exact |
| P20 OverflowReplacement | existing Inference `compiledRequestHash` | same order and overflow link/ordinal remains exact |

For each row, capture a call-order log and assert `compile < gate <
ProviderRuntime`; gate Stop asserts ProviderRuntime call count `0`. A retrying
ProviderRuntime stub asserts one D2/D4 start admission for the ProviderTurn,
then its actual attempt ordinal is reported only through the end/D1 observation.
Operation-kind namespace tests assert equal same-kind hashes compare equal,
while distinct operation kinds remain distinct even if their opaque hash text
matches.

### Wave 3 — AgentAction semantic fingerprint and shared progress producer

- Apply the canonical action fingerprint before action execution/handler
  dispatch. D2 recognizes the same route/tool/argument semantics despite new
  callRef, while materially different payloads remain distinct.
- Replace boolean fallthroughs with an internal progress-evidence result that
  can distinguish: (a) newly committed successful terminal sourced action
  result; (b) separately attributable authoritative application/canonical
  mutation committed; (c) no qualifying progress. This is an internal P3
  implementation type, not a new port/persisted field.
- Set the shared signal true only after transaction success and positive
  evidence for (a) or (b). A persisted ToolResult/ControlResult with
  Failed/Denied/Rejected/Interrupted/OutcomeUnknown status is model-visible
  but false. A missing/non-actionable step or failed result persistence that
  only appends an in-memory observation is false. A P9 replayed result, existing
  idempotent row, Provider success/ModelOutput, Session text, AgentLoopStep
  transition, recovery link/receipt, or cursor advance alone is false.
- Unknown or unresolved side effects remain false and reconciliation-blocked;
  no safety signal may downgrade `OutcomeUnknown` or skip existing P9 recovery.
- At the next new ProviderTurn boundary, the one boolean resets both D2 and D4
  only if true. D4 otherwise increments exactly once; D2 fingerprints remain
  until that same true signal or a genuinely new operation-kind-scoped
  semantic fingerprint according to the existing gate.

### Wave 4 — focused integration and process qualification

- Use a deterministic local fake Provider and disposable database only. No
  real Provider is needed for this safety contract.
- Exercise the production ModelContext/AgentLoop composition far enough to
  prove: prepared request hash is supplied before the stub Provider call;
  D2 Stop yields zero stub calls; a callRef-only change repeats the action
  fingerprint; a semantic argument change does not; and gate stop preserves
  source/action identity and existing settlement behavior.
- Parameterize the compile/gate/network order over all Wave 2 operation
  families with a local fake Provider. Include an internal ProviderAttempt
  retry and assert it does not cause another D2/D4 admission. Include a
  P9-settled-result replay fixture that validates/replays without any new
  D2/D4 admission or Provider call, then starts a genuine successor ProviderTurn
  and asserts only newly committed qualifying action/effect evidence from the
  replay path is accumulated into that successor's `durableProgress` input.
- Add process-level coverage for the shared signal: repeated same semantic
  Provider request with no progress stops at the configured test threshold;
  a newly committed successful sourced action resets both D2 and D4; failed,
  denied, rejected, missing-persist, and P9-only replay paths do not reset
  either; Work remains Open on RuntimeSafetyStop; and restart still resets the
  in-process counters without mutating durable P9 evidence.
- Assert P9 `ProviderResultAvailable`/OutputAccepted/StepEffectsCommitted
  replay is never duplicated at the Provider boundary and no old/replayed
  record is promoted to progress. Assert an unresolved effect keeps its
  existing reconciliation/Attention path even if D2/D4 would otherwise Stop.

## Acceptance matrix

| Category | Cases and required oracle |
|---|---|
| Provider D2 hash | Same compiled semantic request across loop ordinals: identical key. Changed request/tool route/operation: distinct key. Stop after compilation: zero ProviderRuntime/network calls. |
| Action D2 hash | Same route/name/arguments with reordered object keys/new callRef: same key. Changed semantic values/type/array order/route/name: distinct key. |
| Successful progress | Newly committed successful sourced ToolResult/ControlResult or attributable authoritative mutation: one shared true resets both D2 and D4 on next ProviderTurn boundary. |
| No progress | AssistantMessage-only, provider-result journal, Step progression, failed/denied/rejected typed result, in-memory fallback after failed persistence, idempotent replay, P9 recovery/handoff: false; D2/D4 histories are not cleared/reset. |
| P9 safety | Exact settled-result replay makes no second Provider call; P9 reconciliation/unknown effect remains blocking and cannot become ordinary progress or safety-stop downgrade. |
| Counters | Existing `count > max` and `turns > max` boundaries unchanged; false/absent increments D4; true resets the shared D2/D4 state; process restart resets in-memory counters only; `MAX_TURNS=24` unchanged. |
| Regression | Existing P12 direct gate tests, P3 driver/action/replay tests, P9 recovery tests and package architecture rules pass; no port schema, database, manifest, receipt, or P1 fingerprint change. |

## Stop conditions and review gates

- **Governance gate:** revision 2 remains `PROPOSED_NOT_ACCEPTED`; no source
  implementation until manual acceptance and separate implementation
  authorization are evidenced.
- **Canonicalization gate:** do not claim Action D2 qualified if reordered
  object keys do not compare equal or if a new observable equivalence rule is
  needed beyond revision 2. Seek owner review instead of changing P1/P4/P9
  codecs.
- **P9 gate:** any path that retries a P9-settled request, sets shared progress
  from replay/handoff, or downgrades an unresolved external effect is a blocker
  and stops the wave.
- **Port/schema gate:** a new port field, durable counter, migration, manifest,
  receipt, provider protocol, or threshold/`MAX_TURNS` change is out of scope
  and requires explicit owner governance.

Only after all gates are closed may a result claim P12-DG-01 implementation
qualification. This plan does not claim P12 closure or run permission.
