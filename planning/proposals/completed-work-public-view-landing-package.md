# FT-DG-02 — accepted owning-contract landing package (draft)

Status: **READY FOR GOVERNANCE LANDING REVIEW; NOT APPLIED**

This is an exact, planning-only draft for the accepted proposal
`planning/proposals/completed-work-public-view-decision-draft.md` at SHA-256
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`, token
`ACCEPT_COMPLETED_WORK_PUBLIC_VIEW`, plus the user's supplemental 2026-10-08
choice that unknown and cross-project/workspace Work queries receive the same
typed NotFound/404 response. The proposal bytes remain unchanged. No
`docs/design/**` file has been edited, and implementation is not authorized by
this draft.

## Shared semantic delta

Add a distinct, read-only `work-detail` view over the exact
`{ projectId, workspaceId, workId }` identity. It reads canonical Work and the
existing Acceptance/Verification facts; it does not create lifecycle truth or
alter `current-work` / `workspace-detail.pendingWorks`.

- `Open`, `Completed`, and `Cancelled` are returned according to canonical
  Work lifecycle.
- A persisted Acceptance is represented as `acceptedResult` only when bound to
  that Work and revision. Its Verification identity/verdict must be the exact
  concluded PASS verification bound by that Acceptance. For `Completed`, a
  missing or inconsistent binding is a typed projection-integrity failure.
- The accepted-but-not-completed interval remains `lifecycle: Open` with the
  actual accepted result. Cancellation remains canonical `Cancelled`; any
  Acceptance remains historical evidence.
- If an Acceptance exists for the current Work revision, the Verification view
  for that Work selects only its bound Verification; otherwise retain the
  existing selection rule.
- An absent Work and a Work belonging to a different project/workspace return
  the same `NotFound` Problem category / HTTP 404 and the same stable code
  `projection/work-not-found`; neither response includes target facts. A
  malformed request remains the existing invalid-request class. This records
  the user's explicit privacy choice without specifying a new transport or
  authorization model.

## Owning-document clause deltas

Apply only the following additions/reconciliations. Existing surrounding
clauses remain in force.

### `docs/design/02-system-design.md` — §12.4

After the existing Workspace Detail inventory, add a distinct read-only Work
detail item:

```text
Work Detail is a separate read-only inspection surface addressed by the exact
Project / Workspace / Work identity. It may show Open, Completed, or Cancelled
Work from canonical Work lifecycle, with its objective and revision. An
accepted result is shown only from the canonical Acceptance for that Work
revision and its exact concluded PASS Verification. Acceptance does not itself
mean Work is Completed; the accepted-but-open interval remains Open. Work
Detail does not redefine Workspace Detail's Current/Pending Work or the
Current Work view.
```

Add one sentence that absent and out-of-scope target identities have the same
not-found presentation and expose no target contents. Do not change §12.1,
§12.5, lifecycle ownership, or command semantics.

### `docs/design/03-detailed-implementation-design.md` — §13 P10/P13 summaries

- In the P10 summary, add `Work Detail` to the existing view list, pointing to
  the exact Work identity and the P10 contracts below.
- In the P13 summary, change the frozen view count from nine to ten. Do not
  alter the package DAG, generic query port, transport route, or P12 ownership.

### P10 owner files

`docs/design/implementation/P10/00-contract-index.md`

- Add `Work Detail` to the P10-owned view list and route its contract to `01`,
  `05`, and `07`.
- Preserve the current P10/P12, P8, and projection-only boundaries.

`docs/design/implementation/P10/01-view-inventory.md`

- Add one authoritative `Work Detail` row: source is exact canonical Work plus
  that Work/revision's Acceptance and bound Verification/Evidence; disposition
  is `must`; it is a separate view from Workspace Detail and Current Work.

`docs/design/implementation/P10/05-surface-actions-transport.md`

- Add `WorkDetailReq = { projectId, workspaceId, workId }` and the proposal's
  response fields: `workId`, `projectId`, `workspaceId`, `objective`, `why`,
  `completionExpectation`, `lifecycle`, `revision`, and optional
  `acceptedResult = { acceptanceId, verificationId, targetWorkRevision,
  verdict: Pass, actor, acceptedAt }`.
- Define the exact derive/binding rules in “Shared semantic delta” above;
  source all fields from canonical persisted facts, not Session text.
- Add the typed projection error `projection/work-not-found` for both absent
  and cross-project/workspace identities. Map both to Problem category
  `not-found` (HTTP 404) with indistinguishable safe details and no target
  payload. Keep malformed request handling in `projection/invalid-request`.
- Preserve the generic `ProjectionQueryPort`, `/views/:view`, and all P12
  transport semantics.

`docs/design/implementation/P10/07-acceptance.md`

- Add a Work Detail story for exact identity, Open/Completed/Cancelled,
  accepted-but-open, exact Acceptance→PASS Verification binding, stale/missing
  binding integrity failure, restart persistence, and no writes.
- Assert absent and foreign target requests have the same typed not-found
  response and reveal no Work, Acceptance, Verification, or Evidence fields.
- Keep assertions through the public projection/API surface; do not infer
  success from a database-only oracle.

### P13 owner files

`docs/design/implementation/P13/00-contract-index.md`

- Change the frozen view count from nine to ten and route the added renderer
  to `03` and F22 acceptance to `06`.

`docs/design/implementation/P13/03-view-rendering.md`

- Add the Work Detail row to the renderer matrix. WorkPage loads the exact
  `work-detail` response; it does not synthesize Work lifecycle from another
  view. Render `Open + acceptedResult` as “已验收、待完成”, `Completed` as
  “已完成”, and `Cancelled` as cancelled, with the proposal's objective,
  verification and acceptance details. Keep the existing Verification view
  for evidence detail.
- Specify that `projection/work-not-found` / `not-found` renders the same
  object-not-found state for absent and foreign targets.
- Update fixture/render coverage to ten views × typical/minimal/unknown-enum;
  add the not-found behavior to existing Problem rendering coverage without
  creating transport semantics.

`docs/design/implementation/P13/06-acceptance.md`

- Add F22: after Acceptance and CompleteWork, reopening the same Work URL
  renders the same Work as Completed with its objective and bound PASS /
  Acceptance details, including after restart. Also cover accepted-but-open,
  Cancelled, and indistinguishable absent/foreign not-found responses.
- Update EC-3 from 9×3 to 10×3. Retain the existing role: Projection Renderer
  + Command Initiator; no new Work command is introduced.

## Planning reconciliation (not an owning-contract semantic edit)

The old WorkDetail source constraint is in
`planning/proposals/web-v1/01-ui-ia-design.md`, not in the W-06 delivery row.
After the owning contracts land, mark these two IA statements as superseded by
the accepted `work-detail` source:

1. The J4 row (currently line 49) that names
   `workspace-detail(currentWork/pendingWorks) + verification(workId)` as the
   Work Detail data source.
2. §2.5's “数据组合” clause (currently line 161) that says Work Detail uses
   the parent workspace-detail Work reference plus Verification and “不发明
   work 级新视图”.

Do not rewrite either historic statement as if it had always specified the new
view; annotate/supersede them with a reference to the accepted landing. The
W-06 row in `planning/proposals/web-v1/02-dev-plan.md` is only the delivery
item “Work Detail + 关注事项页”; it is not the conflicting source rule and
remains unchanged. Preserve `planning/results/WEB_V1.result.md` as historical
evidence for that delivered scope. Qualify the pending F22 browser case against
the accepted view before moving it into the default functional gate. F21 and
F23 remain untouched.

## Explicit non-deltas

No Scenario, P8, P12, Domain, Application, persistence schema, event, command,
authority, route identity, generic transport, or package-DAG semantics change.
No design file is changed by this planning draft. The code/error identifier
above is part of the proposed P10 contract label only; it does not add
information to the selected NotFound behavior.

## Landing and review exit gates

1. A manual-governance owner applies exactly the deltas above to the named
   owning documents, preserving proposal hash and supplemental decision
   record.
2. An independent consistency review verifies the four owner layers agree on
   identity, lifecycle, Acceptance/Verification binding, and the shared 404
   privacy behavior; it also verifies the inventory/count is ten and no
   non-listed semantic surface changed.
3. Only after accepted design landing and a zero-blocking post-landing review
   may a separate implementation authorization be considered. This package
   itself is not implementation authorization.
