# Findings and Open Questions

## Severity scale

- **BLOCKING:** prevents a reliable or safe next implementation step.
- **HIGH:** material architecture/capability mismatch requiring owner decision.
- **MEDIUM:** meaningful correctness, fidelity, or evidence gap.
- **LOW:** quality or maintainability concern.
- **OBSERVATION:** recorded fact without a current defect claim.

## Findings

### F-TS-01 — project tool visible without production executor

- **Severity:** HIGH.
- **Category:** `TOOL_WITHOUT_CAPABILITY` / `WRONG_EXECUTION_EXPOSURE`.
- **Evidence:** catalog union exposes committed project definitions (`packages/tool-runtime/src/catalog.ts:223-270`); composition supplies builtin-only `ToolDefinitionStoreLive` and `ToolRuntimeLive(BUILTIN_EXECUTORS)` (`apps/single-workspace/src/composition.ts:353-368`); runtime first denies an unresolvable definition as `unknown tool`, and no project executor is wired (`packages/tool-runtime/src/runtime.ts:103-116`).
- **Call path:** RegisterProjectTool → ProjectToolRegistry → ToolCatalogPortLive → ModelContext → model call → ToolRuntimePort.
- **Status:** `DESIGNED yes / IMPLEMENTED visibility yes, execution no / TESTED registry and denial paths / BEHAVIORALLY VERIFIED no`.
- **Owner:** implementation plus product decision on whether registration implies execution readiness.

### F-TS-02 — runtime-owned identity is represented as model payload in some directive branches

- **Severity:** HIGH.
- **Category:** model/runtime binding ambiguity.
- **Evidence:** `InvokeTool.callRef` drives invocation-id derivation; completion claim includes work revision; child/specialist payload schemas are empty while handlers bind identities.
- **Call path:** decodeTurn → driver → directive handler → runtime/gateway.
- **Status:** `DESIGNED mixed / IMPLEMENTED mixed / TESTED partial / BEHAVIORALLY VERIFIED no`.
- **Owner:** Governance/Design for semantic ownership; implementation after decision.

### F-TS-03 — canonical directive branches do not have uniform handler coverage

- **Severity:** MEDIUM.
- **Category:** capability coverage.
- **Evidence:** handler registry plus driver direct settlement; unsupported branches become `DirectiveUnsupported` (`driver.ts:962-1037`).
- **Status:** `DESIGNED ten branches / IMPLEMENTED partial / TESTED scripted / BEHAVIORALLY VERIFIED no`.
- **Owner:** implementation only after branch authorization is clear.

### F-TS-04 — monolithic directive representation is incompatible at tested complexity boundary

- **Severity:** HIGH.
- **Category:** `MODEL_FACING_DIRECTIVE_REPRESENTATION_GAP`.
- **Evidence:** accepted L1/L2/L5/MT replication artifacts; `compileTurn` emits one canonical union.
- **Status:** `DESIGNED canonical semantics yes / IMPLEMENTED single representation yes / TESTED real controlled replication / BEHAVIORALLY VERIFIED narrow probe only`.
- **Owner:** Design/Governance for representation boundary; implementation not authorized in this audit.

### F-TS-05 — canonical branch payloads are under-specified

- **Severity:** MEDIUM.
- **Category:** schema semantic gap.
- **Evidence:** four branch payload schemas are `{}` in `decode.ts:153-167`.
- **Status:** `DESIGNED branch names / IMPLEMENTED placeholders / TESTED shape only / BEHAVIORALLY VERIFIED no`.
- **Owner:** Governance/Design.

### F-TS-06 — builtin input schemas have inconsistent strictness

- **Severity:** MEDIUM.
- **Category:** schema quality.
- **Evidence:** explicit `oneOf` for read/list versus weak path/cwd objects for patch/shell.
- **Status:** `IMPLEMENTED yes / TESTED projection / BEHAVIORALLY VERIFIED no`.
- **Owner:** implementation after schema policy decision.

### F-TS-07 — generic catalog overexposes tools across execution purposes

- **Severity:** HIGH.
- **Category:** `OVEREXPOSED_TOOL_SURFACE` / `WRONG_EXECUTION_EXPOSURE`.
- **Evidence:** `prepareTurn` resolves all visible refs; driver has only conversation-specific suppression.
- **Status:** `DESIGNED purpose distinctions / IMPLEMENTED generic surface / TESTED generic Work only / BEHAVIORALLY VERIFIED no purpose comparison`.
- **Owner:** Governance/Design for allowed surfaces; implementation for filters.

### F-TS-08 — `arbor_directive` remains visible when executable tools are hidden

- **Severity:** MEDIUM.
- **Category:** output-surface coupling.
- **Evidence:** unconditional append in `compiler.ts:132-144`.
- **Status:** `IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Owner:** Governance/Design for conversation output allowlist.

### F-TS-09 — no dedicated query/verifier read-only tool surface

- **Severity:** HIGH.
- **Category:** capability/exposure boundary.
- **Evidence:** no distinct production filter or dedicated test found; generic non-conversation path may expose patch/shell.
- **Status:** `DESIGNED read-only intent / IMPLEMENTED not found / TESTED no / BEHAVIORALLY VERIFIED no`.
- **Owner:** Governance/Design plus implementation.

### F-TS-10 — runtime failure distinctions are compressed in observations

- **Severity:** MEDIUM.
- **Category:** observation fidelity.
- **Evidence:** `OutcomeUnknown` reconciliation refs and status tags are reduced to text in `directives.ts:71-89`.
- **Status:** `DESIGNED canonical distinctions / IMPLEMENTED lossy projection / TESTED partial / BEHAVIORALLY VERIFIED no`.
- **Owner:** Design for model-facing observation contract; implementation later.

### F-TS-11 — shell result schema promises refs that executor does not populate

- **Severity:** HIGH.
- **Category:** schema/implementation mismatch.
- **Evidence:** `SHELL_RESULT_SCHEMA` requires refs; `shellExecutor` returns empty refs and null resultRef.
- **Status:** `DESIGNED refs / IMPLEMENTED empty refs / TESTED projection only / BEHAVIORALLY VERIFIED no`.
- **Owner:** implementation after artifact semantics decision.

### F-TS-12 — bounded observation/artifact handoff lacks behavioral evidence

- **Severity:** MEDIUM.
- **Category:** evaluation gap.
- **Evidence:** bounded helper exists; no live artifact-ref continuation evidence found.
- **Status:** `IMPLEMENTED bounding / TESTED unit-level / BEHAVIORALLY VERIFIED no`.
- **Owner:** test/evaluation.

## Open questions

1. Is `ToolCatalogPort` intended to expose all catalogued tools and defer least privilege to runtime, or should each execution purpose receive a filtered catalog?
2. Which output-contract branches are legal for Root Conversation, Query, Verification, Formation, Bootstrap, Steer, Child, and Recovery turns?
3. Should the model-facing directive representation be compiled by Model Context, a model-family compiler, or the provider adapter?
4. Which capability/profile selects a representation? Model family, provider/model pair, or a richer capability profile?
5. Which canonical fields are true model choices versus runtime-generated identity/control facts?
6. What schemas replace `{}` payloads for dependency, governance, specialist, and child-workspace branches?
7. Does project-tool registration promise executable capability, or only metadata visibility?
8. What executor/provenance/approval contract is required before a project tool is exposed to a model?
9. Should shell stdout/stderr be artifact-backed, bounded inline text, or both?
10. Should model-visible failure observations preserve structured tags and reconciliation references?
11. Is `arbor_directive` allowed in conversation turns to emit organizational actions, or should conversation use a narrower output contract?
12. What real-model scenarios will verify purpose-specific exposure and tool choice after the representation boundary is implemented?

## Readiness conclusion

The current tool surface is **not ready for S01 implementation** without a separately authorized representation boundary and explicit decisions on exposure and capability ownership. The canonical contract itself remains intact. This audit does not propose or apply a fix.

## Design-gap classification

- Existing, accepted design gap: `MODEL_FACING_DIRECTIVE_REPRESENTATION_GAP` (F-TS-04).
- New governance/design inputs: purpose-specific exposure policy (F-TS-07/F-TS-09), canonical branch payload ownership (F-TS-02/F-TS-05), conversation directive allowlist (F-TS-08), and project-tool execution promise (F-TS-01).
- Implementation gaps after decisions: representation compiler/decoder, project executor binding, observation fidelity, schema tightening.

## Stop condition

No production code, Prompt, frozen contract, or Runtime behavior was changed by this audit. No S01 implementation or Wave 2 work was started.
