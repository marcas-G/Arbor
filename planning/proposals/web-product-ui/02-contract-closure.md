# Web Product UI Contract Closure

**Status:** FROZEN and adopted by DID v1.17 — D-1 implements the API/projection/documentation
closure for TR-WPU-A–D only. D0–D10 frontend/product implementation remains unauthorized; no
domain, DDL, event, command, authority, or transport evolution is authorized by this record.

**Decision inputs:** C1–C4 and Product IA correction approved by the product owner on
2026-09-23.

**Scope:** close the minimum presentation and read-model gaps needed by the formal
Workbench. The proposal changes neither canonical responsibility/work/verification semantics
nor command exposure, authentication, authority resolution, HTTP/WS transport, or server
single-source-of-truth rules.

## 1. Adoption record and DID requirement

Adoption requires a **DID bump from v1.16 to v1.17**. The current DID and P13/P14 documents
are frozen; this draft does not edit them. A governance owner must adopt the following tracked
revisions into the v1.17 DID and create the successor contract record. That adoption also
reconciles the DID header, governance-change record, phase/index references, and every
freeze-status version marker (including stale appendix markers) to v1.17.

| TR | Superseded target | Adopted change | Explicitly unchanged |
|---|---|---|---|
| TR-WPU-A | P13 `04-design-tokens` visual-only rules | New Web Product UI light design system: white/warm-neutral surfaces, Arbor Green brand emphasis, sans UI/body, mono only for technical metadata, optional limited serif brand/display, revised spacing/radius/density. | DTO/command semantics, auth, WS, server-state ownership, status semantics and no-icon-library decision. |
| TR-WPU-B | P10/P13 responsibility-tree wire shape | Append `parentWorkspaceId` to every returned tree node, sourced by the server projection from canonical `Workspace.parentWorkspaceId`. | Canonical responsibility hierarchy, preorder row order, `depth` request semantics, all tree mutations (there are none). |
| TR-WPU-C | P10/P13 current-work read-view shape | Add server-carried canonical Work revision to `CurrentWorkSummary`. | Work revision advancement, command payloads and authority. |
| TR-WPU-D | P10/P14 Verification read-view + DID v1.16 G-F / P14 `04-web-surface` §1 placement | Add selected Verification's frozen target work revision to `VerificationView`; `/p/:projectId` becomes Root Workbench (Tree + Root Conversation); `/p/:projectId/workspace/:rootWorkspaceId/conversation` remains its root-tab deep-link mirror; `/p/:projectId/tree` remains Tree Focus/deep-link. | Verification selection/acceptance rules, root-only composer, child transcript read-only, all nine views, no new `/chat`, `/workbench`, or backend route. |

This is a DID bump, not a reopened P13/P14 backend phase: it records a narrow public
read-model/presentation supersession. The implementation contract should carry the v1.17
baseline only after governance adoption and review.

## 2. C1 — Visual contract supersession

### Replacement presentation baseline

The Web Product UI must use a modern minimal light system:

- white and warm-neutral surfaces with Arbor Green as the primary brand/confirmation emphasis;
- sans-serif for UI and body copy; mono only for IDs, revisions, timestamps and technical
  metadata; serif is optional and limited to an Arbor wordmark or display treatment;
- design-system spacing, radius and component density from the approved product design assets;
- no obligation to reproduce the reference images' blue as a primary color.

P13's token discipline survives: components consume named tokens rather than scattered literal
values, state meaning remains semantic (attention/danger/muted), and no dark theme or icon
library is introduced by this TR. Only its paper/leaf/serif global styling and 3px-shape
requirements are superseded.

### Contract/test evolution

At a future implementation, the named source of truth stays `apps/web/src/tokens.ts` and
`apps/web/src/tokens.css`; their values and typography families are replaced under the new
system. Existing token lockstep and “no literal design values outside token files” tests remain,
but their expected values/classes must assert the new system rather than P13 botanical paper.
This is a presentation-only change: no `@arbor/api-contracts` type, command envelope or
projection query changes originate from C1.

## 3. C2 — Responsibility Tree read-model enhancement

### Chosen minimum: `parentWorkspaceId` only

`parentWorkspaceId` alone is sufficient and is the minimum safe addition. For every returned
node it gives the direct, canonical parent edge; exactly one returned node has `null` and every
other `parentWorkspaceId` names a node in the same response. A graph renderer can therefore draw
the responsibility tree without recovering parentage from preorder positions, names, UI state or
indentation. `depth` would only duplicate a presentation-derived distance from the root and is
not needed to reconstruct the frozen hierarchy.

The browser may lay out a graph using the explicit parent edges, but must not infer or repair a
missing edge. The projection, not the browser, validates the graph invariants. Before traversal it
must reject a workspace set unless it has exactly one null-parent root, every non-null parent is
in the same project set, and parent pointers are acyclic. A dangling parent is never promoted to a
root; `depth` applies only after validating and traversing from that root. This is a read failure
for an invalid projection input, not a new canonical hierarchy rule. Existing consumers may
continue to render `nodes` in server preorder and ignore the additive field.

### API-contract draft

```ts
// packages/api-contracts/src/views.ts
export interface TreeViewNode {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkspaceId: WorkspaceId | null; // NEW: canonical direct parent
  readonly name: string;
  readonly status: WorkspaceStatusLabel;
  readonly currentWork?: CurrentWorkSummary | undefined;
  readonly subtreeAttention: SubtreeAttention;
  readonly usageSummary?: UsageSummary | undefined;
}
```

Every successful Tree response contains exactly one root; an empty workspace set is a projection
failure, not an empty-success response. The new field is required on every returned node and has
these projection invariants:

1. `parentWorkspaceId === null` only for the project's returned root.
2. A non-null parent belongs to the same `nodes` response and is emitted before its child.
3. Parent pointers are acyclic and match canonical `Workspace.parentWorkspaceId`; depth limiting
   never emits an orphan.
4. `nodes` remains root-first deterministic preorder. No `children` array is added to the wire
   DTO and no request field changes.

### Projection evolution

| Location | Exact future change | Source of truth |
|---|---|---|
| `packages/projection-runtime/src/tree.ts` | Validate one root / no dangling parent / no cycle before `childrenOf` traversal; then extend derive-side `TreeViewNode` with `parentWorkspaceId` and in `buildNode` copy `workspace.parentWorkspaceId` rather than calculating a parent from traversal. | Canonical `Workspace.parentWorkspaceId`. |
| `packages/projection-runtime/src/query-runtime.ts` | Keep `flattenTreeNodes` preorder traversal; preserve the new parent field while dropping only internal `children`; omit derive-side `currentWork: null` at the wire boundary. Validate the resulting value as `TreeViewRes`, not unchecked `unknown`. | Derive-side tree node. |
| `packages/api-contracts/src/views.ts` | Apply the API change above. | Public DTO contract. |

No repository write, event emission, hierarchy mutation, new ViewId, request parameter or browser
parent reconstruction is introduced.

## 4. C3 — Canonical Work revision carrier

### API-contract draft

```ts
// packages/api-contracts/src/views.ts
export interface CurrentWorkSummary {
  readonly workId?: WorkId | undefined;
  readonly objective: string;
  readonly status: WorkLifecycle;
  readonly revision: number; // NEW: canonical Work.revision, never a UI default
  readonly activeExecution?: ExecutionSummary | undefined;
}
```

`revision` is required whenever `CurrentWorkSummary` is present and is copied exactly from the
canonical Work row. The pre-existing optional `workId` remains source-compatible for generic
rendering, but a SteerWork affordance requires **both** `workId` and `revision`; it is absent if
either is unavailable. `0` is valid only when it came from the server, never as a fallback.

Because the API already says `CurrentWorkSummary.status` is required, the projection runtime's
tree-specific current-work mirror must also supply `status` while adding `revision`. Its internal
`currentWork: null` is not public-wire compatible with the API's optional member: flattening must
omit that property when no current work exists, and a present value must contain `workId`,
`objective`, canonical `status`, and canonical `revision`. This is a pre-existing API/derive
alignment repair within the same mapper work, not a new domain field.

### Projection/read-surface evolution

| Location | Exact future change | Source of truth |
|---|---|---|
| `packages/projection-runtime/src/views/shared.ts` | Add `revision: number` to `CurrentWorkSummaryView`. | Canonical Work. |
| `packages/projection-runtime/src/views/current-work.ts` | Emit `revision: work.value.revision`. | Current canonical Work. |
| `packages/projection-runtime/src/views/workspace-detail.ts` | Emit the same revision in `currentWork`. | Current canonical Work. |
| `packages/projection-runtime/src/tree.ts` | Extend `CurrentWorkView` to emit canonical `status` and `revision` alongside workId/objective before flattening. | Current canonical Work. |
| `packages/projection-runtime/src/query-runtime.ts` | Convert tree derive `currentWork: null` to omitted; structurally validate every present summary against the expanded public Tree wire shape. | Tree derive / public DTO. |
| `packages/api-contracts/src/views.ts` | The one shared `CurrentWorkSummary` change automatically reaches tree nodes, workspace detail and current-work responses. | Public DTO. |

### Web command binding after adoption

```ini
expectedWorkRevision = currentWork.revision  # exact server value
```

The later Workbench implementation may expose SteerWork only in a current-work context with that
binding. It must remove all current `expectedWorkRevision = 0` call sites. A non-current
`PendingWorkRef` is still not a SteerWork target until it itself carries a future exact revision;
this proposal deliberately does not add one.

The precise later Web migration targets are
`apps/web/src/pages/workspace/WorkspacePage.tsx` and
`apps/web/src/pages/work/WorkPage.tsx`: pass `currentWork.revision` only after the matching
`currentWork.workId` has been established, otherwise keep the SteerWork control unavailable.
`apps/web/test/command-forms.test.tsx` may retain a literal `0` only as an explicitly
server-supplied form-prop test fixture, never as a page binding default.

## 5. C4 — Verification target revision carrier

### Conditional API-contract

An empty Verification view has no Verification record, so an unconditional numeric field would
fabricate a target revision. The minimum correct wire expression is: **when `verificationId` is
present, `targetWorkRevision` is present and branded as `WorkRevision`; when no verification is
selected, both are absent.** The public contract expresses that condition as a union, while the
projection constructs it through one shared pair constructor.

```ts
// packages/api-contracts/src/views.ts
export type VerificationIdentity =
  | {
      readonly verificationId: VerificationId;
      readonly targetWorkRevision: WorkRevision;
    }
  | {
      readonly verificationId?: undefined;
      readonly targetWorkRevision?: undefined;
    };

export type VerificationView = VerificationIdentity & {
  readonly verdict?: VerificationVerdict | undefined;
  readonly criteriaResults: ReadonlyArray<CriterionResult>;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
  readonly acceptance?: AcceptanceView | undefined;
};
```

Invariant: if `verificationId` is defined then `targetWorkRevision` equals the selected
canonical `Verification.targetWorkRevision` frozen when StartVerification created that record.
It is not the browser's current Work revision and must not be recomputed from a current Work row.

### Projection/read-surface evolution

`AcceptanceView` receives no new public field. Its existing contents are surfaced only if the
found canonical acceptance's `(workId, targetWorkRevision, verificationId)` exactly equals the
selected Verification. The existing `(workId, targetWorkRevision)` lookup may remain a storage
optimization only when its returned row is filtered by
`acceptance.verificationId === selected.verificationId`; otherwise `acceptance` is absent. This
keeps read rendering truthful under re-verification at the same Work revision without changing
the frozen command's triple binding.

| Location | Exact future change | Source of truth |
|---|---|---|
| `packages/projection-runtime/src/views/shared.ts` | Add paired optional `targetWorkRevision` to `VerificationViewView` and the shared pair assertion/constructor used by all Verification projection paths. | Canonical Verification. |
| `packages/projection-runtime/src/views/verification.ts` | For every selected open/concluded verification, project `selected.targetWorkRevision`; emit `undefined` with the existing empty result; include an acceptance only after its verificationId matches the selected verification. | Selected canonical Verification / acceptance. |
| `packages/projection-runtime/src/views/workspace-detail.ts` | When it projects the selected open verification, include `open.targetWorkRevision`; include an acceptance only after its verificationId matches `open.verificationId`; leave no verification absent. | Selected canonical Verification / acceptance. |
| `packages/api-contracts/src/views.ts` | Apply the paired-field contract above. | Public DTO. |

### Web command binding after adoption

```ini
targetWorkRevision = verification.targetWorkRevision  # exact server value
```

The later Work Detail/Queue implementation may show AcceptWorkOutcome only with a selected
verification that supplies `verificationId` and `targetWorkRevision`, has the appropriate
server-projected verdict/acceptance state, and sends those two exact values. It never supplies
`0`, reconstructs a revision, or alters the existing server-side triple-binding validation.

The precise later Work migration target is `apps/web/src/pages/work/WorkPage.tsx`: carry the
paired target revision from that work's `verification` query into `WorkGovernance`; disable and
withhold the form unless both paired values are present. A workspace-detail verification may
remain an informational card, because it can represent a different work in the workspace.

## 6. Product IA supersession

The formal landing route is now:

```text
/p/:projectId  -> Root Workbench (Tree + Root Conversation)
/p/:projectId/tree -> Tree Focus / deep-link surface
```

Workbench resolves the root as the one server-projected Tree node whose
`parentWorkspaceId === null`, presents the graph/list context from C2, and binds the only composer
to that root. It does not create `/workbench` or `/chat`.
The former separate Overview dashboard is no longer a required landing surface; its existing
server views are retained and may be reused only as constrained supporting information in
existing pages. No server view is removed.

Primary desktop and mobile navigation rename the first destination from “概览” to “工作台”;
Tree remains a focus destination. Queue, Attention, Usage and Settings retain their existing
source-limited definitions.

## 7. Compatibility and deployment contract

| Area | Compatibility effect | Required handling |
|---|---|---|
| JSON wire consumers | Added fields are backward-compatible for consumers that ignore unknown keys. `nodes` order, request shapes and all existing fields remain unchanged. | Deploy projection/API contract before a Web version that needs fields. |
| TypeScript consumers and fixtures | Required Tree parent and CurrentWork revision are source-breaking for object literals/mocks; paired Verification field is additive. | Update all typed fixtures in one contract migration; compiler is the inventory. |
| Existing ordered/list Tree consumers | They can ignore `parentWorkspaceId` and retain preorder rendering. | Do not replace `nodes` with a nested wire structure. |
| Old servers | A new Web must not fallback to an assumed `0`, inferred parent or guessed verification target. | Feature deployment is ordered; absence means no action/graph surface, not a client workaround. |
| Canonical storage and behavior | No DDL, event, command handler, authority, migration, or semantic version change. | Projection reads existing canonical fields only. |

## 8. Exact test evolution

| Test layer | Files | Required assertions |
|---|---|---|
| API/projection contract | `tests/p10-api-contracts.test.ts`, `tests/p10-acceptance.test.ts`, `tests/p10-views-detail.test.ts` | Tree wire rows expose canonical parent edges/root null and preserve preorder; current-work/tree/detail expose exact canonical Work revision; selected verification/detail expose frozen target revision; empty verification exposes neither paired field; all derives remain read-only. |
| Projection unit coverage | `packages/projection-runtime/src/tree.ts`, `src/query-runtime.ts`, `src/views/current-work.ts`, `src/views/workspace-detail.ts`, `src/views/verification.ts` test suites or their existing P10 hosts | Empty workspace sets, multiple roots, dangling parents and cycles reject before traversal; depth-limited output has no orphan; flattening omits `currentWork` when absent and validates `TreeViewRes`; revision 0 is accepted only when canonical row is 0; a historical verification reports its own target revision rather than the current Work revision; two verifications at the same Work revision never attach another verification's acceptance. |
| API/fixture type coverage | `packages/api-contracts/src/views.ts`, `apps/web/src/views/fixtures.ts` and all fixture users | Every typical/minimal/unknown fixture satisfies the new type; minimal tree nodes include parent and any present current-work includes revision; a shared pair assertion rejects a one-sided Verification fixture. |
| Web binding regression | `apps/web/test/tree-page.test.tsx`, `apps/web/test/conversation-tab.test.tsx`, `apps/web/test/work-page.test.tsx` (or successor Workbench tests), `apps/web/test/command-forms.test.tsx` | Graph receives explicit parent edges; root conversation still uses first server node; SteerWork posts server revision including a server-supplied 0; AcceptWorkOutcome posts verification's target revision; no fallback literal revision path remains. |
| Negative/static tests | P13/P14 closure scans and future WPU closure suite | No browser parent inference, `AdmitExecution`, `SendMessage`, EventSource, local turn insertion or new mutation exposure. |

## 9. Gate disposition

| Gate | Before | Closure result | Residual constraint |
|---|---|---|---|
| G1a — SteerWork revision | Blocked: no exact Work revision in a UI source. | **CLOSED by C3** after server projects `CurrentWorkSummary.revision`. | Only current-work contexts with server workId + revision may steer. |
| G1b — AcceptWorkOutcome target revision | Blocked: Verification view omitted frozen target revision. | **CLOSED by C4** after selected Verification projects targetWorkRevision. | Requires a selected verificationId + paired target revision; server still validates the triple. |
| G2 — permission grant inventory | Blocked. | **DEFERRED.** | Revoke remains unavailable. |
| G3 — rich settings/project data | Blocked. | **DEFERRED.** | Settings remains project/permission/session constrained. |
| G4 — advanced usage analytics | Blocked. | **DEFERRED.** | Usage remains groupBy + server rows. |
| G5 — rich Attention explanation | Blocked. | **DEFERRED.** | Attention remains its existing facts + target link. |
| G6 — graph hierarchy | Blocked: flat preorder did not name edges. | **CLOSED by C2** after server projects direct canonical parent edge. | UI never repairs/makes an edge; server preorder remains compatible. |

## 10. Independent-review acceptance criteria

The review is Blocking=0 only when it confirms all of the following:

1. C2 requires only `parentWorkspaceId`; direct edges are canonical, complete and compatible with
   depth-limited preorder responses, and empty/root/dangling/cyclic input fails before traversal.
2. C3 reads `Work.revision` in every `CurrentWorkSummary` projection path and never creates a
   client fallback; the pre-existing tree `status` wire alignment is included.
3. C4 pairs `verificationId` and `targetWorkRevision`, preserves the empty Verification state,
   sources the latter from `Verification.targetWorkRevision`, not current Work, and attaches an
   acceptance only when all three selected identity fields match.
4. No C1 token choice changes business/transport semantics; no C2–C4 item changes a command,
   event, DDL, canonical aggregate or authority resolver.
5. Landing IA changes only presentation routing: `/p/:projectId` Workbench and `/tree` Tree
   Focus; neither `/chat` nor `/workbench` is introduced.
6. G2–G5 are explicitly deferred, and the revised DAG contains contract closure as a prerequisite
   rather than treating it as frontend work.
