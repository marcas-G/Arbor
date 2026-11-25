# Tool-capability ownership audit — prerequisite record

Date: 2026-11-25 · Read-only audit against the working tree. For each of
the seven responsibilities: the current semantic owner (implementation
may sit elsewhere), contested/ambiguous points with evidence, and the
recommended disposition.

| # | Responsibility | Current semantic owner | Contested / ambiguous | Design Gap? |
|---|---|---|---|---|
| 1 | Tool definition & registration | Model-visible set: tool-runtime `catalog.ts` (ToolCatalogPortLive union); registration writes: application command + ProjectToolRegistry; executable set: tool-runtime ToolDefinitionStore + BUILTIN_EXECUTORS | A registered project tool is model-visible (catalog.ts:360-371) but unexecutable — prepareInvocation misses in the definition store and denies with `InvocationAuthorityDenied` (runtime/invocation-setup.ts:61-70, :103-104); no component checks the two sets agree; process-execution gating enforced independently in catalog (catalog.ts:346-358) and runtime (runtime.ts:98-103, :507-526) | **YES — GAP-TOOL-01** |
| 2 | Invocation identity | Generation: composition-root helper `toolInvocationIdFor` (executable-tool-handler.ts:274-280, deterministic derivation); format: domain ids.ts:108-117; replay: tool-runtime via ToolInvocationStore | ID-scheme authority lives in an app-private helper; legacy derivation domain split across three generators | No — fold into object 3 |
| 3 | Permission decision | Control authorization: agent-runtime port + app implementation; tool authority: application pure decision + app snapshot assembly + tool-runtime revalidation; approval: executor decides necessity, application issues/human decides, tool-runtime consumes atomically in the claim transaction | No dual owner; both authority implementations live in the composition root | No — relocation item |
| 4 | Tool execution | tool-runtime pipeline and gating; FS side effects: in-process builtin executors with lexical path confinement; process side: process-runner routes to sandbox-native-posix / TrustedLocal (test-only) | The word "sandbox" has different strength on the FS path (lexical) vs the process path (OS boundary) | No — record as explicit fact |
| 5 | Result persistence | P4 invocation rows: tool-runtime claim/settlement transactions; P40 evidence: settleOrReadWinner single transaction; artifacts: tool-runtime artifact.ts; timeline: agent-runtime ledger | P3/P4 two-phase, not end-to-end atomic (deliberate; recovery bridges) | No — recheck under object 7 |
| 6 | Interruption & recovery | Invocation-level: tool-runtime (contract in ports); P39 binding: ports contract + tool-runtime construction/consumption + sqlite storage; execution-level escalation: execution-runtime; human classification: application | No competing owner found; mapping logic repeated but same-contract | No |
| 7 | Model-visible result | Truncation: tool-runtime bounded + sqlite codec hard cap; runtime-composed texts: composition-root toExecutableOutcome; wire format: provider-openai client.ts | `bounded()` has 4 unlinked copies (tool-runtime errors.ts:10, executable-tool-handler.ts:106, legacy-directive-handlers.ts:56, legacy-governance-directive-handler.ts:35); truncation/format authority spread over three layers; tool path has no summaryRef (counterparts are resultRef/observationRef) | No — priority convergence item |

## GAP-TOOL-01 (proposed, for manual governance)

A committed project tool is advertised to the model but can never
execute: the catalog unions registered definitions into the
model-visible set while the execution path consults only the builtin
definition store, and the failure surfaces as an authority denial
rather than "no executor". Whether registration-without-execution is
intended product semantics (a P12-era unclosed seam) is not for the
refactor to decide: per governance rules this is recorded as a Design
Gap for owner adjudication before any code movement touches it.

## Positive exemplars to preserve

- The P39 chain (ports contract → tool-runtime construction/consumption
  → sqlite storage) as the single-owner pattern.
- The permission layering: pure decision in application, snapshot
  binding in the composition root (to relocate), revalidation in
  tool-runtime, atomic approval consumption inside the claim
  transaction.

## Refactor inputs

- Objects 1/3/7 receive: the 16+2 hidden-required services and 76-field
  Dependencies (driver baseline audit), the two authority
  implementations living in the app root, the invocation-ID scheme
  fold-in, and the bounded() convergence to a single point.
