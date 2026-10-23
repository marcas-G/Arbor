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
| Other provider dispatch sites | `packages/agent-runtime/src/compaction-coordinator.ts`, `packages/agent-runtime/src/conversation-checkpoint-compaction.ts` | These build Summary/Native requests separately. The owner must decide whether P12 D2/D4 activity boundaries include each such ProviderTurn or only the outer AgentLoop inference boundary; see the blocking clarification below. Do not silently change D4 turn counts. |
| AgentAction D2 identity | `packages/agent-runtime/src/agent-loop-actions.ts` | Current fingerprint is `tool:${toolName}:${callRef}`. Replace callRef-based identity with a semantic envelope containing resolved route kind, action/tool name, and canonical semantic arguments; callRef/ProviderTurnId/step ordinal are correlation identities, not action semantics. |
| Progress producers | `packages/agent-runtime/src/agent-loop-actions.ts` | Several invalid-argument, authorization-denied, handler-rejected/model-usable, and persistence-fallback branches currently set `durableProgress=true` unconditionally. Inventory every assignment and make the signal depend on committed qualifying evidence. |
| Progress aggregation | `packages/agent-runtime/src/agent-loop-driver.ts` | `progressedSinceBoundary` aggregates action progression and is reported at ProviderTurn admission. Keep one boolean shared by D2/D4; do not infer it from Session text, Provider success, step revisions, or P9 handoff. |
| P9 recovery ordering | `packages/agent-runtime/src/model-decision.ts`, `packages/agent-runtime/src/agent-loop-step-recovery.ts`, `packages/agent-runtime/src/agent-loop-actions.ts` | Existing settled-result replay and reconciliation paths remain authoritative. A replay/handoff alone is false progress; `ReconciliationPending`/unknown external effects retain their existing gate precedence. |

### Canonicalization decision

No new provider-facing, persisted, or public codec is required by revision 2.
For ProviderTurn, use the existing compiled-request identity field after
proving its exact availability at the gate boundary. For AgentAction, add a
small agent-runtime-internal pure canonicalizer for the parsed JSON argument
value and hash a versioned envelope with the existing `sha256Hex` utility. The
canonical rules should be: sort object keys recursively; preserve array order;
preserve JSON primitive types; reject non-finite numbers and non-JSON values;
include route kind and tool/action name; exclude callRef and other ephemeral
identities. Invalid/unparseable argument JSON must produce a stable,
domain-tagged invalid-input fingerprint rather than throw before D2 admission;
it never counts as progress.

Existing canonicalization code is precedent, not a directly reusable general
codec: `provider-extension.ts` has a private sorted-key helper but does not
validate non-finite values, `canonicalizeRecoveryBindingV1` is a closed P39
schema, and `canonicalizeLegacyAdoptionEvidenceV1` permits only safe integers
and applies AH14-specific NFC rules. Do not couple AgentAction D2 to either
closed evidence schema. If implementation requires equivalence beyond the
revision-2 observable rules (for example schema-default expansion, Unicode
normalization, or argument coercion), stop and seek owner clarification rather
than inventing it.

## Blocking owner clarification before implementation

Revision 2 does not identify whether a D2 `ProviderTurn` activity means:

1. only the outer AgentLoop inference decision; or
2. every network-backed ProviderTurn, including Summary/Native compaction,
   Conversation checkpoint compaction, and overflow replacement.

The code has separate `ProviderRuntime.runTurn` call sites for these
operations. Counting each one also makes each a D4 boundary and can change the
no-progress count relative to the current outer-loop admission, despite
preserving thresholds. Conversely, skipping an operation-kind is a narrower
fingerprint scope. The owner package must choose the scope (or name the exact
existing boundary to preserve) before implementation; the implementation must
not guess. Recommended default for owner consideration: fingerprint each
explicit ProviderTurn using its own compiled semantic request, but preserve
the P12 logical turn boundary count if compaction is an internal continuation
within that same logical turn. This may require separating D2 identity from
D4 boundary semantics, which revision 2 currently describes as one shared
ProviderTurn gate observation; no implementation may introduce a second
progress boolean or new P2 port field without owner approval.

The owner decision must also state the P9 replay boundary: a previously
settled, exactly bound ProviderResult is consumed without another Provider
request; recovery bookkeeping must not set progress. The plan below assumes a
replay is evaluated once at the existing logical turn admission using its
validated pinned manifest's semantic request identity, with
`durableProgress=false`, and does not call the network. If the owner instead
defines D2 only for newly dispatched network requests, D4 boundary behavior on
a no-network P9 replay must be explicitly retained without accidentally
double-counting D2 or D5.

## Conditional TDD work DAG

### Wave 0 — freeze evidence and red tests

- Verify the accepted revision-2 proposal SHA/token and implementation
  authorization; stop if either is absent.
- Record current gate behavior and all four `ProviderRuntime.runTurn` call
  sites. Inventory every `durableProgress` assignment and categorize it as
  successful action settlement, attributable authoritative mutation,
  unsuccessful model-visible outcome, persistence failure, P9 replay, or
  bookkeeping.
- Add focused failing tests before production edits. Keep existing direct P2
  gate tests and assert D2/D4 reset coupling, count/threshold boundaries,
  `durableProgress` absent/false behavior, and RG-11 restart reset.

### Wave 1 — semantic fingerprint helpers

- Provider fingerprint: use the compiled request hash from the exact prepared
  turn and tag it by the accepted operation scope. Test that identical compiled
  request + tool routes across different logical-step/ProviderTurn IDs yield
  the same D2 key; changed input items, instructions, tool definitions/routes,
  output contract, or operation kind yield a different key.
- AgentAction fingerprint: implement the internal canonical-argument envelope
  from the owner-approved rules. Test recursively reordered object keys as
  equal; changed values, action kind, route kind, array order, or JSON type as
  distinct; changing only callRef/ProviderTurnId/step ordinal as equal. Test
  malformed and non-finite input handling and prove no argument text is logged
  or persisted as a fingerprint.
- Keep fingerprints in-memory only. Do not rewrite `AgentLoopStep.inputHash`,
  P4 recovery-binding hashes, P1 semantic fingerprints, or provider manifests.

### Wave 2 — compile → gate → network ordering

- Refactor P3's inference dispatch seam so request preparation, tool-route
  resolution and compiled-request identity complete before the ProviderTurn
  gate; `ProviderRuntime.runTurn` must be the next effect after a Continue
  decision, with no transport/network work before that decision.
- Ensure a Stop returns through the existing `RuntimeSafetyStop`/settlement
  path with **zero ProviderRuntime calls**, zero new ProviderAttempt/network
  requests, and no fabricated Provider result. P9 reconciliation/unknown
  side-effect guards continue to take precedence as today.
- Preserve D1 retry ordinal and D5 begin/end brackets; `inFlight=end` remains
  excluded from D2/D4 as existing gate code specifies. Do not count internal
  transport retries as separate semantic Provider requests. Apply the owner
  decision from the blocker above to compaction/checkpoint/overflow sites.
- P9 replay must validate the exact persisted manifest/result binding, consume
  the already settled result once, issue no new Provider request, and report
  `durableProgress=false` unless a new qualifying action/effect commits.

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
- At the next accepted ProviderTurn boundary, the one boolean resets both D2
  and D4 only if true. D4 otherwise increments exactly once at the
  owner-defined boundary; D2 fingerprints remain until that same true signal
  or a genuinely new semantic fingerprint according to the existing gate.

### Wave 4 — focused integration and process qualification

- Use a deterministic local fake Provider and disposable database only. No
  real Provider is needed for this safety contract.
- Exercise the production ModelContext/AgentLoop composition far enough to
  prove: prepared request hash is supplied before the stub Provider call;
  D2 Stop yields zero stub calls; a callRef-only change repeats the action
  fingerprint; a semantic argument change does not; and gate stop preserves
  source/action identity and existing settlement behavior.
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
- **Provider operation scope gate:** no implementation if inference vs
  compaction/checkpoint/overflow D2/D4 boundary scope remains unspecified.
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
