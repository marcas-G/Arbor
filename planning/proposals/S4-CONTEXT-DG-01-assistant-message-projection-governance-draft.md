# S4-CONTEXT-DG-01 — Workspace AssistantMessage Projection (Governance Draft)

Status: **draft for manual governance; not accepted and grants no implementation authority**
Recommended token: `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`
Fixed owner baseline: Problem & Goals v1.3, Scenarios v1.6, System Design v1.21, DID v1.58.
Integrated diagnostic test: `a290b3ac4795beb726b6a5c4297f4bdd591108b2`; independent diagnostic review: `6633698d6a933b7b28eef5f68e5bcbff6bea94eb`; source candidate: `4de305bb6e81f98688f40d98e817d5b4d7da19b4`.
Fixed package manifest: `planning/proposals/S4-CONTEXT-DG-01-assistant-message-projection-package.sha256`.
Supersedes prior draft proposal SHA-256 `7CDADAAA8DDE1E1BF16B85FE1E757CBBE752A68915B0CFC0CC047BA95AB342B6` and prior package-manifest raw SHA-256 `7BD4ACF767D94FF662A40CA2034CD6E505D46CF8AB6E782342CC2933AF866A14`; those identities are retired.

This proposal requests one narrow semantic decision: project an already accepted, exactly sourced `AssistantMessage` from the same Responsibility-bound Workspace Session into later Provider context as a role=`assistant`, DataOnly C3 message. It changes no `docs/design/**`, production code, storage schema, permission, or provider boundary.

## 1. Evidence and gap

The model-light diagnostic in `planning/results/s4-work-assistant-message-context-diagnostic.result.md` supplies hand-built `SessionEntryRecord[]` frontiers to the existing Session projector and portable request compiler. Appending a typed, sourced `AssistantMessage` shaped like the P3 output item advances the supplied frontier, but leaves projected `inputItems`, `contextRefs`, `PortableModelRequest`, and `compiledRequestHash` unchanged. Appending a sourced ToolCall plus ControlResult or ToolResult changes the request input and hash. This confirms that the current projector omits the assistant item before request compilation; it is not a `SessionRepository.listActiveFrontier`, `readExecutionTimeline`, or `ModelContext.prepareTurn` integration test. The earlier HTTP capture hash covers `request.messages` only; the model-light equality of the compiled provider-neutral request is the direct evidence that this projector path emits no changed message content. Neither this diagnostic nor the S4-B run proves that the omission alone caused the model not to select `shell`.

The diagnostic has an independent read-only review with Blocking = 0 for its narrow claim at `planning/results/s4-work-assistant-message-context-diagnostic-independent-review-20261024.result.md`. That review explicitly retains the supplied-frontier/integration limitation and does not authorize production or design changes.

The diagnostic also exercises `completeAgentLoopStep`: a successful WorkspaceWork ProviderTurn with `finishReason=Stop`, non-empty text, and zero ToolInvocations returns Continue and creates the next logical step under the same Execution. The no-action path is bounded: `MAX_TURNS=24`; the last step creates no successor and the driver exits `Failed("max turns reached")`. This is repeated unchanged projected input with bounded advancement, not an infinite loop or process hang.

Frozen owners provide partial but incomplete direction:

- DID §9.8 / v1.50 AH19 names `AssistantMessage` in the SessionItem set.
- P2 `02` selects a bounded Session frontier but explicitly leaves projection and coverage to P3.
- P3 `02` names `AssistantMessage` in the selected-row eligible union, while its current projection conditions omit it and say types without an existing branch remain unprojected.
- The existing C3 history layer already supports `Message(role="assistant")`, classifying it as `AuthenticatedAgent`, C3, and DataOnly.

The remaining question is whether the omission is intentional. The accompanying open gap is `planning/gaps/S4-CONTEXT-DG-01-assistant-message-work-context.md`.

## 2. Recommended fixed semantics — Option A

### Same-Session projection

For every subsequent Provider context that reads the same Responsibility-bound Workspace Session, an accepted and exactly sourced typed `AssistantMessage` is projected, in Session sequence order, as:

```ts
{ readonly _tag: "Message"; readonly role: "assistant"; readonly text: string }
```

It is a C3 historical message with `AuthenticatedAgent` provenance and `instructionCapability="DataOnly"`. It is not an InstructionFragment, canonical Work fact, permission/authority fact, tool call, effect, plan state, CompletionClaim, or proof of progress. The provider may use its text as context, but the text does not acquire control authority by being projected.

Projection requires the existing closed typed `AssistantMessage` payload and exact runtime source binding. For provider turn `T`, require `entryKind=ModelOutput`, payload tag `AssistantMessage`, a valid exact `providerTurnId=T`, `contentRef="provider:T:assistant"`, source kind `ProviderTurn`, source ref `T:assistant`, string text and finish reason, and the source content hash produced by the accepted-output writer for the exact `{text, finishReason}` pair. The context reference remains the exact Session source reference. Any malformed, unbound, wrong-source, mismatched-content, or unsupported legacy representation contributes no message; implementation must not infer identity or content from adjacent rows, free text, a request capture, or an AgentLoopStep number.

### Frontier, retention, and compaction

The new branch uses exactly the existing P2/P3 selection and retention protocol:

- Before the first typed checkpoint, consider only the latest 64 persisted SessionItem rows selected by P2. Do not refill older rows after P3 filtering.
- After a typed checkpoint, use the exact checkpoint plus the unsummarized typed frontier after it. Do not re-read rows the checkpoint covers.
- A selected valid AssistantMessage appears as a role=`assistant` input item and its source reference appears in the manifest. A row outside the selected frontier stays durable but is not injected.
- Assistant history is C3/Compressible. Existing compaction may represent it in a Summary; `retainedFrontier` may claim it only when its content was actually represented. No new checkpoint, fallback reconstruction, or expanded 64-row window is introduced.
- Context budget and `NeedsCompaction` behavior stay unchanged. If the current output cannot be represented within the existing budget/compaction protocol, preserve the existing typed unsatisfiable/fail-closed outcome rather than silently dropping it or borrowing it from an older unselected row.

### No-action continuation and safety

A successful WorkspaceWork `ModelOutput` with non-empty text, no ToolInvocations, and `finishReason=Stop` still does not itself settle or complete the Work. The same Execution may continue to another ProviderTurn under the existing P3 loop. Before that next Provider request, the exact accepted AssistantMessage must be present as the assistant-role DataOnly C3 item above (or be represented by the exact active checkpoint summary if compaction occurred first).

This proposal changes only context projection. It does not change P3's `RuntimeSafetyObservation` generation, the P2 D2/D4 counter-update algorithm, `MAX_TURNS`, settlement, rate limits, or stop/fencing rules. Context may naturally change model-selected activities and therefore later observations; this package neither chooses nor changes how those observations or D4 counter transitions are computed. Whether a monotone AgentLoopStep transition or sourced Session/Observation append counts as D4 `durableProgress` is the separate P12-DG-01 owner clarification; Assistant projection implementation does not depend on resolving it. Assistant text itself remains non-canonical: it cannot satisfy a Work/Verification condition, authorize an action, or enable completion. Existing no-progress and hard turn bounds remain in force; no new loop budget or retry authority is granted.

### Conversation isolation

This rule applies only to Provider contexts that consume the exact same Responsibility-bound Workspace Session. `ConversationResponseEpisode` continues to use the P14/P17 RootWorkspaceId-owned Conversation history/checkpoint and the exact claimed HumanMessage once. It must not read or merge Work Session AssistantMessages. Existing `InboxEpisode`/`DecisionEpisode` behavior remains under their current exact episode and Session owner contracts; this proposal does not add a second history source.

## 3. Owner landing targets

After manual acceptance, the precise owning-document landing should be:

| Owner | Landing target |
|---|---|
| P3 | `docs/design/implementation/P3/02-model-context-contracts.md`: specify the exact AssistantMessage projection, source/content validation, DataOnly C3 provenance, frontier and checkpoint behavior, and fail-closed legacy handling. |
| P3 | `docs/design/implementation/P3/03-agent-loop-driver.md`: state that WorkspaceWork text-only `Stop` is not itself a settlement and that any continued same-Execution ProviderTurn receives the accepted same-Session AssistantMessage through the P3 projection. |
| P3 | `docs/design/implementation/P3/08-agent-loop-step-handoff.md`: cross-reference the existing accepted output source/content/ProviderTurn binding and confirm replay does not duplicate or reinterpret it. No new AgentLoopStep state or payload is proposed. |
| P2 | `docs/design/implementation/P2/02-port-contracts.md` / `04-sqlite-schema.md`: no new port, column, schema, or migration; update only if governance requires a clarifying reference to the already typed AssistantMessage eligibility and exact active-frontier selection. |
| P3 | `docs/design/implementation/P3/07-behavioral-eval-harness.md`: add the model-light acceptance cases below. |

Problem & Goals, Scenarios, System Design, P12, P14, and P17 are unchanged. In particular, this does not change S4 recovery, authorization, Conversation ownership, permission, execution safety, or the terminal Work contract. P12-DG-01 is an out-of-scope follow-up; it is neither adjudicated by this package nor a prerequisite to projecting already accepted Session output. A post-landing consistency review must verify those boundaries before any implementation request.

## 4. Implementation authorization boundary and waves

Acceptance of this proposal closes the semantic decision and authorizes only the exact owning-document landing package. It does **not** authorize production implementation, schema migration, real-Provider qualification, deployment, or release claims. Those require separate implementation authorization after the landing and independent review.

If implementation is later authorized, use this bounded sequence:

1. **P3 projector:** add the strict AssistantMessage-to-PortableMessage branch and exact source/content checks; leave Session storage and P2 frontier selection unchanged.
2. **P3 request/continuity:** assert the next same-Session PortableModelRequest contains one role=`assistant` item in source order; preserve existing ToolCall/ToolResult/ControlResult order and manifest source refs.
3. **P3 loop/recovery integration:** use a deterministic model-light Provider with the actual SessionRepository/frontier and `ModelContext.prepareTurn` path to prove no-action text `Stop` continues the same Work Execution, and that the next actual portable request contains the exact accepted AssistantMessage. After restart/replay, reuse the accepted output and exact prepared ProviderTurn without duplicate append or recompilation of an already bound manifest.
4. **P3 boundaries:** qualify DataOnly/C3 history, compaction/frontier behavior, legacy rejection, and P14/P17 Conversation isolation. Run ordinary checks and only then request a separately authorized real S4 qualification.

No change is proposed to the provider protocol, `PortableModelRequest` schema/version, P1 receipt, ProviderTurn identity, output contract, Session schema, or migration set. Existing request/manifest hashes naturally bind the new input content for newly prepared turns. Already persisted ProviderTurn manifests and results remain immutable and replay exact bytes.

## 5. Required acceptance matrix

| Case | Required oracle |
|---|---|
| Accepted sourced AssistantMessage in the active Work Session frontier | Exactly one role=`assistant` PortableMessage with exact text and source ref; exact ProviderTurn/contentRef/source/contentHash tuple validated. |
| Output append followed by next same-Session turn | Compiled Provider request includes prior assistant output; its request hash changes from the pre-output request while providerTurnId/logical step advance normally. |
| Actual SessionRepository output append and selected frontier | Integration test observes the exact writer's source kind/ref/content hash and projects it through `listActiveFrontier`/the real runtime read path. |
| Wrong/missing ProviderTurn source, mismatched source ref/contentRef/content hash, malformed payload, or unsupported legacy ModelOutput | No inferred AssistantMessage input; typed integrity/fail-closed behavior follows existing P2/P3 error boundary; no free-text fallback. |
| Selected-frontier 64-row boundaries | A valid selected AssistantMessage is projected; a row outside the selected window is not fetched/refilled/projected. |
| Typed checkpoint and post-checkpoint frontier | AssistantMessage after the exact checkpoint is projected once; covered rows are not reread; compaction coverage claims only content actually represented in Summary. |
| ControlResult and ToolResult regression | Existing exact callRef chronology and output text remain projected and change request input/hash as before. |
| WorkspaceWork text-only `Stop` / no ToolInvocation | Same Execution may advance; next request contains the output; no CompletionClaim/Work completion/canonical progress is inferred from text. |
| RuntimeSafety isolation | Existing observation-generation code, D2/D4 counter-update algorithm, `MAX_TURNS`, RuntimeSafety policy, rate limit, settlement, and stop fences are not changed. Model-selected activity values may naturally differ because context differs. D4 durable-progress evidence interpretation is excluded to P12-DG-01 and does not block context projection. |
| ConversationResponseEpisode | P14/P17 history only; no Work Session AssistantMessage is read, merged, or injected. |
| Exact ProviderTurn replay/restart | Persisted successful result/AssistantMessage is reused exactly once; an already prepared ProviderTurn/manifest is not recompiled with changed context. |

## 6. Compatibility and rollback

This is additive context projection over already stored typed Session data: no DDL, migration, backfill, SessionItem rewrite, event/receipt rewrite, or cross-episode copy is permitted. Legacy or unprovable rows remain stored for audit and are not upgraded from text. Existing provider request schema and all prior ProviderTurn manifests remain strict and immutable.

If the projector change is later rolled back, durable AssistantMessage rows remain untouched and future newly prepared turns revert to the previous projection. Recovery must still replay any already prepared ProviderTurn from its persisted manifest/result; it must never silently recompile the same ProviderTurn using whichever projector version is now installed. This rollback is code-only and does not rewind canonical state or claim that a completed action was undone.

## 7. Governance request

Manual governance is asked to accept Option A: source-bound AssistantMessage projection as a DataOnly C3 assistant-role message in subsequent same-Session Responsibility-bound Provider contexts, with existing selection, checkpoint, compaction, and safety bounds preserved. The no-action WorkspaceWork turn remains nonterminal and may continue the same Execution, but the next turn must receive that accepted output. ConversationResponse remains on the independent P14/P17 owner.

The separate P12-DG-01 D4 durable-progress source conflict remains open for P12 owner clarification. This S4 proposal neither chooses its resolution nor conditions AssistantMessage projection on it.

Suggested acceptance token: `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`.

This draft itself makes no design change and grants no production or implementation authority. Until the owning-document landing and independent review are complete, the AssistantMessage projection acceptance test must remain pending/skipped and the design gap stays OPEN.
