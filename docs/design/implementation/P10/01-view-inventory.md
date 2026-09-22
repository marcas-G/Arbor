# P10 — 01 View Inventory (authoritative, GQ1)

**Authority:** SD v1.3 §12.1/§12.2/§12.4/§13.9/§10.1 D (full inventory); DID v1.13 G1; S2.4.1–S2.4.3; P9 `05` §3.2 (Inbox as P10 surface).
**Status:** DRAFT.

## 1. Authoritative view list (SD inventory wins over the DID nine-word summary)

| View | SD source | P10 disposition | Primary derive inputs |
|---|---|---|---|
| Responsibility Tree (Agent Tree) | §12.1, §13.9 | must | workspaces (parent chain) + works.current + dependencies + verifications + attention read-model + usage summary |
| Attention view | §12.3, §13.9 | must | `02` read-model (six fact sources) |
| Workspace Detail | §12.4 ①–⑤/⑥ | must (⑥ = audit timeline from domain_events; Memory/Decisions store deferred) | workspaces/works/executions/dependencies+messages+inbox/verification+evidence/journal |
| Current Work | §12.1 | must | workspaces.current_work_id + works + active main execution |
| Verification view | §12.4 ⑤ | must | verifications + evidence + acceptances |
| Dependency View | §12.1/§13.9 | must | dependencies + deliverables + work_waits |
| Transcript | §12.4 note, §10.2 | must (on-demand debug view; human-readable projection, not truth) | session_entries + provider_turns + model_context_manifests |
| Usage | §12.1, §7.7 | must (observe-only, invariant 45) | provider_turns.usage_json aggregates |
| Inbox view | P9 `05` §3.2; SD §7.4 | must | inbox_entries (P6-owned semantics; P10 owns view/query/rebuild) |
| Search | §13.9 | **deferred with rationale**: no frozen query semantics exist upstream; introducing an index now would invent semantics — revisit with P12 transport | — |
| Workspace Summary / Project Overview | §13.9, §10.1 D | must — realized as aggregated renderings of the Tree view (no separate model) | same as Tree |

## 2. WorkspaceStatus exhaustive label map (frozen from SD §12.2 text; no invented labels)

SD §12.2: "正在执行、等待、可执行但未 admission、当前无事" + attention flags from §12.3. Exhaustive map:

```text
executing                 ⇔ active main execution exists (WorkspaceMain, not settled)
waiting-runnable          ⇔ no active main ∧ runnable ≠ ∅ (P7 classification)
waiting-blocked           ⇔ no active main ∧ runnable = ∅ ∧ (active WorkWait ∨ blocking dependency ∨ open verification pending)
idle                      ⇔ no active main ∧ runnable = ∅ ∧ no waits/blocks
retired                   ⇔ workspace lifecycle = Retired (terminal; GAP-01 negative fixture lands here)
attention-flagged         ⇔ any Attention fact targeting the workspace (overlay, composable with the above)
```

- Status is a pure projection of canonical facts (SD §12.2: no reverse pressure on Domain enums). waiting-blocked disambiguation uses the P7-frozen blocking predicate and P8 one-Open-per-revision facts.
- S2.4.1 acceptance reading: the tree view answers "who is responsible / doing / waiting / blocked / needs attention" without opening every workspace.

## 3. Per-view query shapes

- Each view is exposed via `ProjectionQueryPort` (DID §7.2) with a typed request/response in the `api-contracts` package (deps: domain only — DID §10.4.1). Shapes are frozen in `05` together with the port signature.
- Derive inputs are read-only over canonical tables + journal facts; no view writes anything (DID §10.4 hard rule; SD §13.10 "UI 只发 Command").

## 4. Must Not Decide

- No new labels beyond the SD-frozen map; no domain enum changes.
- No Search implementation (deferred, rationale above).
- No Memory/Decisions store (deferred; audit timeline substitutes).
- No transport (P12).
