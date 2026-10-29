# S4-CONTEXT-DG-01 — implementation plan (planning only)

Status: **NOT ACCEPTED; implementation NOT AUTHORIZED.** This plan is a
sequencing proposal only. It does not amend `docs/design/**`, grant authority to
change production code, authorize a real Provider/daemon qualification, or
close the open design gap. Implementation may begin only after manual
acceptance of the fixed governance package, its exact owner-document landing,
an independent landing consistency review with Blocking = 0, and a separate
implementation authorization.

## Fixed basis and scope

Plan basis is candidate `366b83045aa59338c8c416179c55de66334b9b9e` and the
fixed S4-CONTEXT-DG-01 proposal whose Git blob identity is
`B03BDB36C72714E6BCBBEE61364E3E0431C95F342012B6D6B99F16ABB8329A70`.
The package-manifest Git blob is `89ca6675ed277ef1d3b31646b8c591d88b71b5b6`
(`planning/proposals/S4-CONTEXT-DG-01-assistant-message-projection-package.sha256`).
These are Git committed-blob identities; on Windows, `core.autocrlf` can make
checkout-byte hashes differ and must not be used to declare this fixed package
stale. The proposal recommends
`ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`; that token has
not been accepted in this plan.

The proposal's diagnostic establishes a narrow implementation target: the
current projector omits sourced `AssistantMessage`; adding one typed Session
row leaves projected provider input/hash unchanged; ToolCall plus
ControlResult/ToolResult changes it; and a successful text-only WorkspaceWork
`Stop` may continue in the same Execution, bounded by `MAX_TURNS=24`. The
diagnostic is not production qualification: it uses hand-built Session rows
and the pure projector/compiler, not the actual repository frontier and runtime
preparation path.

If later authorized, implement only the accepted Option A contract: an
accepted, exactly sourced WorkspaceWork `AssistantMessage` becomes a
role=`assistant`, C3, DataOnly input in subsequent Provider contexts for the
same Responsibility-bound Session. It conveys no control, tool, canonical
progress, completion, or permission authority. P14/P17 ConversationResponse
history remains owned by its separate RootWorkspaceId history/checkpoint and
must not consume Work Session messages. No schema, migration, provider wire
schema, output contract, or P1 receipt change is planned.

The separate P12-DG-01 question about whether durable Session/step updates
count as D4 progress is out of scope and is not a prerequisite. Keep
`RuntimeSafetyObservation` generation, D2/D4 update rules, `MAX_TURNS`,
settlement, rate limits, and stop/fencing behavior unchanged. Context can
naturally change model-selected activities; this work does not adjudicate the
resulting P12 observations.

## Authorization-gated work sequence

### Wave 0 — governance gate (no implementation)

1. Verify manual acceptance refers to the fixed proposal Git blob above, not a
   modified checkout copy.
2. Land only the accepted owner-document changes identified by the proposal:
   primarily P3 `02-model-context-contracts.md`, `03-agent-loop-driver.md`,
   `08-agent-loop-step-handoff.md`, and `07-behavioral-eval-harness.md`; P2
   `02-port-contracts.md` / `04-sqlite-schema.md` only if needed for a
   clarifying cross-reference. No P2 port/schema/migration change is presumed.
3. Obtain the required independent consistency review. Stop if it finds a new
   semantic issue; do not resolve it in implementation.
4. Obtain a separate implementation authorization. Without all four gates,
   keep the existing candidate test skipped/pending and do not start Waves 1–5.

### Wave 1 — strict P3 projector branch

Target `packages/model-context/src/projector.ts`. Add one explicit
`AssistantMessage` branch; do not add a generic ModelOutput/text fallback.
Validate the closed payload and exact tuple before emitting any item:

- Session entry is `entryKind=ModelOutput`, payload `_tag=AssistantMessage`;
- payload `providerTurnId` is the exact non-empty ProviderTurn identity;
- `contentRef` is exactly `provider:${providerTurnId}:assistant`;
- source is `{ kind: "ProviderTurn", ref: "${providerTurnId}:assistant" }`;
- text and finish reason have the accepted writer types, and `source.contentHash`
  equals the accepted-output writer's SHA-256 over the exact
  `{ text, finishReason }` pair;
- retain the Session entry's exact source reference in `contextRefs` and emit
  exactly one assistant-role Portable message in sequence order.

Malformed, mismatched, unsupported, or unprovable legacy rows must not be
reconstructed from neighboring rows, free text, request captures, or step
numbers. Use the existing P3 integrity/error boundary; fail closed rather than
silently accepting a weaker source. Do not change the output writer unless
inspection during authorized implementation shows it does not already produce
the accepted tuple. The current relevant writer/validator targets are
`packages/agent-runtime/src/model-output-journal.ts` and
`packages/agent-runtime/src/persisted-model-output.ts`; any needed change there
must remain within the accepted contract.

Add `packages/model-context/test/s4-assistant-message-projection.test.ts` for a
valid exact binding and table-driven wrong/missing turn id, wrong source/ref,
wrong `contentRef`, hash mismatch, malformed text/finish reason, and legacy
payload cases. Extend existing projector regression coverage in
`packages/model-context/test/scrc-context-projector.test.ts` or
`packages/model-context/test/ah19-native-projector.test.ts` only where that
avoids duplicate fixtures. Assert existing ToolCall/ToolResult/ControlResult
chronology and semantics are unchanged.

### Wave 2 — actual Session frontier and runtime request

Add a model-light integration test, preferably
`packages/agent-runtime/test/s4-assistant-message-session-frontier.test.ts`,
that appends output through the actual accepted-output path and obtains rows
through the real `SessionRepository` active-frontier API. Exercise the actual
P3 `ModelContext.prepareTurn`/runtime projection path rather than manually
constructing the only tested frontier. Assert:

- selected sourced output appears once in source order in the next same-Session
  `PortableModelRequest` and its source ref is in the manifest;
- the request/hash changes because of the new assistant content;
- a selected invalid binding is rejected/not projected according to the
  accepted P3 error boundary;
- the same Execution can continue after text-only `Stop`, but text is not
  interpreted as canonical Work progress, a CompletionClaim, or settlement;
- provider turn/manifest identity advances normally for a newly prepared next
  turn.

Keep the model-light diagnostic as diagnostic evidence; do not promote its
hand-built rows into the only acceptance test. Avoid editing the large
`packages/agent-runtime/src/model-decision.ts` orchestration unless the actual
runtime seam proves a production wiring change is necessary. If it is needed,
keep the delta limited to routing the existing same-Session projection result;
do not change unrelated episode or safety policy branches.

### Wave 3 — frontier, checkpoint, replay, and episode isolation

Extend frontier/checkpoint tests to validate existing selection without
refilling older rows after filtering:

- before a typed checkpoint, only the latest selected 64 SessionItem rows are
  considered; a valid selected AssistantMessage projects and a row outside the
  selected frontier does not;
- after a typed checkpoint, the exact checkpoint plus unsummarized post-
  checkpoint frontier is used; covered rows are not reread;
- a summary may represent AssistantMessage only when the existing compaction
  process actually included it; `retainedFrontier` must not claim absent text;
- current context budget/`NeedsCompaction` failure behavior remains intact.

Use or extend `packages/agent-runtime/test/ah19-conversation-checkpoint-projection.test.ts`
and the existing P3 projector test rather than changing P2 selection/storage.
Add a regression to
`tests/p17-conversation-response-runtime.test.ts` (or the narrowly relevant
`packages/agent-runtime/test/ah19-conversation-checkpoint-projection.test.ts`)
that seeds a Work Session AssistantMessage and proves a ConversationResponse
turn receives only its P14/P17 RootWorkspaceId-owned Conversation history and
checkpoint. Also assert same-execution Work ToolCall/ToolResult/ControlResult
re-entry remains unchanged.

For replay, extend `packages/agent-runtime/test/persisted-model-output.test.ts`
and/or `packages/agent-runtime/test/model-decision-pinned-replay.test.ts`:
reuse an accepted output once; do not duplicate the Session append; and replay
an already prepared ProviderTurn from its immutable manifest/result without
recompiling that same ProviderTurn using the newly projected context. No
backfill, row rewrite, or new migration is permitted.

### Wave 4 — deterministic functional qualification

After unit/integration gates pass, extend `tests/p3-driver.test.ts` with a
deterministic model-light Provider sequence: first response is non-empty plain
text with `finishReason=Stop` and no actions; second request for the same Work
Session contains that exact assistant output. Preserve assertions for bounded
loop termination, same Execution, no false completion, and existing
action/result chronology. The loop's existing `MAX_TURNS=24` and P12 behavior
are invariants, not test knobs.

Required ordinary gates are the repository's owning-package typecheck/tests,
then architecture and full deterministic local check set as documented by the
maintainer at that time. Report exact commits and outputs; do not infer real
Provider support from deterministic/model-light passes. Do not use retries to
turn a failure green.

### Wave 5 — separately authorized real S4-B qualification

Only after Wave 4 and fresh explicit real-qualification authorization may the
owner schedule `tests/capability/real-provider/public-s4-recovery.test.ts` (or
its then-current equivalent) in the isolated qualification slot. It must use
the genuine configured Provider boundary, a fresh isolated DB/workspace, and
the existing public-process oracle. Verify actual request capture shows the
first accepted assistant output in the subsequent same-Work request, while
recovery reuses a pinned manifest/result and does not duplicate ownership,
Session output, receipts, or Provider calls. Preserve P14/P17 separation and
all existing S4 business assertions. A failed real qualification remains a
failure with retained sanitized evidence; it is not repaired by weakening the
oracle or substituting a synthetic capability claim.

## Test and acceptance matrix

| Layer | Evidence required | Does not prove |
|---|---|---|
| Projector unit | Exact source/content binding, fail-closed malformed/legacy rows, assistant-role DataOnly item, existing action chronology | Real frontier selection or runtime wiring |
| Runtime/model-light integration | Real SessionRepository frontier and `prepareTurn`; exact next request/ref/hash; same Execution and no completion inference | Real Provider behavior or S4 recovery |
| Frontier/replay/episode tests | 64-row and checkpoint boundaries; no refill; restart/pinned replay; no duplicate append; P14/P17 Work/Conversation isolation | Real public-process acceptance |
| Deterministic functional test | Two-turn text-only Stop flow and unchanged finite safety bounds | Production Provider qualification |
| Real S4-B qualification | Public-process evidence from configured genuine Provider, exact capture/receipt/ownership/recovery assertions | OS/provider combinations not actually exercised |

At every layer, confirm RuntimeSafetyObservation generation, D2/D4 counter
update rules, `MAX_TURNS`, settlement, rate limits, stop/fencing, permissions,
and canonical Work state were not changed. Assistant text remains DataOnly C3
and cannot satisfy a Work or Verification criterion. Do not claim the P12
D4-source conflict is resolved by these tests.

## Compatibility, rollback, and stop conditions

- No DDL, migration, backfill, SessionItem rewrite, event/receipt rewrite,
  provider protocol/version change, or cross-episode copy.
- Previously persisted ProviderTurn manifests/results remain byte-for-byte
  replay inputs. Never recompile an already prepared ProviderTurn after a code
  rollback or projector version change.
- A rollback is code-only: leave durable AssistantMessage rows and canonical
  state untouched; newly prepared turns can return to old projection only
  after their normal new ProviderTurn identity is established.
- Stop and raise a new design gap if the accepted exact source binding cannot
  be verified, checkpoint coverage cannot truthfully represent the text,
  conversation isolation requires a new history owner, or implementation
  would need to decide P12 D4 semantics. Do not silently broaden this plan.

This plan is not an acceptance record, owner-document landing, test result, or
implementation authorization.
