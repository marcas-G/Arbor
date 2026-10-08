# FT-DG-02 — accepted decision and owning-contract landing package

Date recorded: 2026-10-08. The acceptance handoff supplies the date but not an
exact clock time; no acceptance minute is inferred here.

Status: **PROPOSAL ACCEPTED; SUPPLEMENTAL NOT-FOUND DECISION RECORDED;
LANDING APPLIED UNDER THE GOVERNANCE DELEGATION EXCEPTION; independent
post-landing review PASS (Blocking = 0). Implementation remains unauthorized.**

## Accepted decision record

Per the user's explicit governance answer relayed by the task owner, accept
exactly:

```text
Token: ACCEPT_COMPLETED_WORK_PUBLIC_VIEW
Proposal: planning/proposals/completed-work-public-view-decision-draft.md
SHA-256: 6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8
```

The current file hash was independently checked with `Get-FileHash` and matches
the accepted digest. This record does not accept any modification to those
proposal bytes and does not authorize implementation or additional semantics.
The accepted scope is read-only public Work-detail retrieval for the exact
`{projectId, workspaceId, workId}` identity; current, completed and cancelled
Work remain distinguishable by canonical lifecycle; a Completed result must
bind the same Work revision to its exact accepted PASS Verification; the
accepted-but-not-yet-completed interval remains `Open` plus an explicit
accepted result; and the existing `current-work` view is not repurposed.

F21/F23 are out of scope and are not accepted or changed by this decision.

### Supplemental outward-error decision

On 2026-10-08 (Asia/Shanghai; the decision handoff did not provide an exact
minute), the user made the remaining F22 choice explicitly: an absent Work and
a Work identity outside the caller's project/workspace scope return the same
typed `NotFound` / HTTP 404 response, without revealing whether the foreign
Work exists. This is an additive decision record attached to the accepted
proposal above; it does not change that proposal's bytes or SHA-256. The
accepted outward behavior is now unambiguous. The landing draft uses the
stable projection code `projection/work-not-found` for both cases; the exact
identifier is a mechanical label for this accepted response, not a second
privacy or authorization choice.

## Exact owning-contract landing map

| Owner | Exact landing location | Accepted delta only |
|---|---|---|
| System Design | `docs/design/02-system-design.md` §12.4 (Workspace Detail / projection surfaces) | Add a distinct read-only Work-detail inspection surface for a known Work identity and preserve the canonical separation among Verification PASS, Parent Acceptance and Work Completed. Keep Workspace Detail/current-work semantics unchanged. |
| Detailed Implementation Design | `docs/design/03-detailed-implementation-design.md` §13 P10 view inventory and §13 P13 client summary | Add the Work-detail view to the P10 summary; update P13's frozen view count from nine to ten. No new port, command, event, persistence table, migration or package edge is implied. Generic `ProjectionQueryPort` and `/views/:view` remain unchanged. |
| P10 view owner | `docs/design/implementation/P10/00-contract-index.md`, `01-view-inventory.md`, `05-surface-actions-transport.md`, `07-acceptance.md` | Record the additive view in the inventory; specify exact request/response and derive sources; specify acceptance-bound Verification selection and typed projection integrity failures; add read-only tests for exact identity, privacy, lifecycle, restart and accepted/open/cancelled cases. Keep canonical Work/Acceptance/Verification ownership unchanged. |
| P13 renderer owner | `docs/design/implementation/P13/00-contract-index.md`, `03-view-rendering.md`, `06-acceptance.md` | Update the frozen view count/render matrix, define WorkPage's data/render behavior for Open/Completed/Cancelled and the accepted-but-open interval, and add the F22 browser acceptance story. WorkPage remains a Projection Renderer + Command Initiator; completed/cancelled Work has no new command surface. |

The exact proposed clause deltas, including the shared not-found mapping and
per-owner inventory/count updates, are prepared in
`planning/proposals/completed-work-public-view-landing-package.md`. This is a
planning-only landing draft; it has not edited an owning contract.

No Scenarios v1.3 edit is proposed: S2 already owns read-only local inspection
of goals, stage conclusions and necessary history; this decision supplies the
precise Work-detail projection that realizes that existing behavior. P8 does
not need a semantic change: the proposal reuses its exact Work-revision,
Verification, Acceptance and CompleteWork bindings. P12 transport semantics,
authorization and storage remain unchanged.

### Planning/implementation reconciliation after owner-contract landing

The prior draft incorrectly attributed the old WorkDetail source constraint to
`planning/proposals/web-v1/02-dev-plan.md` W-06. Independent review found the
actual conflicts in `planning/proposals/web-v1/01-ui-ia-design.md`:

1. J4 currently names
   `workspace-detail(currentWork/pendingWorks) + verification(workId)` as the
   Work Detail source.
2. §2.5 currently says Work Detail combines the parent Workspace Detail Work
   reference and Verification and “不发明 work 级新视图”.

Those two IA statements are now explicitly marked superseded by the accepted
`work-detail` source in `planning/proposals/web-v1/01-ui-ia-design.md`. W-06 in
`planning/proposals/web-v1/02-dev-plan.md` remains unchanged as the delivery
item “Work Detail + 关注事项页”; it is not a semantic/source constraint.
`planning/results/WEB_V1.result.md` remains historical evidence of the
delivered scope. A new F22 result must qualify the accepted source and
renderer after implementation. The existing Work URL identity
`{projectId, workspaceId, workId}` already matches the proposal and does not
require a new route identity choice.

After design landing, the existing `apps/web` Work route should consume the
new Work-detail view instead of deriving the Work header only from
`workspace-detail.currentWork/pendingWorks`. That is implementation follow-up,
not part of this design landing record.

## Governance disposition

The formerly open outward-error question is resolved by the supplemental
decision above: absent and cross-project/workspace Work identities have the
same typed NotFound/404 behavior. No other governance blocker was found in the
accepted proposal's scope. P10 `05` now specifies the projection-owned typed
result and mapping. This is a design contract only; implementation still
requires separate authorization. F21/F23 and unrelated Web or domain
semantics remain out of scope.

## Landing record and post-landing consistency review

The exact accepted package was applied under the manual-governance delegation
exception on 2026-10-08. Applied package SHA-256:
`266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`;
accepted source proposal SHA-256:
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`.
Owning revisions: System Design v1.10 and DID v1.32; P10/P13 contract indexes
record this additive FT-DG-02 landing. Exact changed owner files are
`docs/design/02-system-design.md`, `docs/design/03-detailed-implementation-design.md`,
P10 `00`/`01`/`05`/`07`, P13 `00`/`03`/`06`; the two accepted IA source clauses
are annotated in `planning/proposals/web-v1/01-ui-ia-design.md`. The W-06
delivery row and `planning/results/WEB_V1.result.md` were not changed.

### Landing self-check — PASS

The landing was checked against its accepted package: the exact Work identity,
canonical lifecycle, same-revision Acceptance and bound PASS Verification,
accepted-but-open distinction, and shared absent/foreign NotFound/404 are
consistent in System Design, P10 request/error contract, and P13 rendering /
acceptance. P10 inventory and P13 render matrix both contain ten views; EC-3
is ten views × three fixtures. The old IA J4/§2.5 source constraint is marked
superseded, while W-06 remains a delivery item and WEB_V1.result remains
historical. No command, event, persistence, authority, route identity, generic
transport, P12 or package-DAG semantics were added. This is an integrator
self-check, not the required independent post-landing review.

### Independent post-landing review — PASS (2026-10-08)

A separate read-only Luna reviewer checked the landed owner-document diff
against the accepted package and the supplemental NotFound/404 decision.
Result: **Blocking = 0**. The reviewer confirmed the exact identity and
same-revision Acceptance→PASS Verification binding; the `Open + acceptedResult`
versus `Completed` distinction; identical `projection/work-not-found` /
`not-found` / HTTP 404 for absent and foreign targets with no target facts;
ten P10 views, ten P13 views and EC-3 10×3; and no added command semantics.
The IA J4/§2.5 clauses are superseded, while W-06 and `WEB_V1.result.md` are
unchanged. No tests were run. This review covers only the FT-DG-02 landing;
unrelated in-flight worktree changes were not part of its scope.

### Pre-landing package self-review — PASS (2026-10-08; revised)

The revised planning-only owner package was cross-checked against the accepted
proposal, SD §12.4, DID §13 P10/P13 summaries, P10 `00`/`01`/`05`/`07`, P13
`00`/`03`/`06`, and the identified IA statements. The Work
identity/lifecycle and Acceptance→Verification binding stay consistent across
owners; the P10 typed error and P13 404 render use the same absent/foreign
behavior; the view inventory and renderer count both move from nine to ten.
The obsolete IA source rule is explicitly superseded; W-06 remains a delivery
item and WEB_V1.result remains historical. No Scenarios/P8/P12/transport/
command/persistence change is in the draft. **Blocking = 0 for the revised
planning package.** This reviews the proposed package only, not landed design
or implementation.

After the accepted owning-document changes are applied, an independent review
must check:

1. System Design and P10 agree that Work detail is read-only and does not
   reinsert terminal Work into `current-work` or `workspace-detail.pendingWorks`.
2. `acceptedResult` is selected only from the same Work/revision's canonical
   Acceptance and its exact concluded PASS Verification; missing/mismatched
   links fail with the accepted typed projection error.
3. `Open + acceptedResult` renders “已验收、待完成”; `Completed` renders
   “已完成” only from canonical Work lifecycle; cancellation preserves any
   acceptance only as history.
4. Unknown and foreign `{projectId, workspaceId, workId}` targets return the
   single chosen error without leaking Work, Verification or Acceptance data.
5. P10's `ViewId`, DTO, projection behavior and P13's ten-view render/acceptance
   matrix agree; no command, event, DDL, migration, authority or transport
   change has slipped into the package.
6. The pending F22 test becomes a default-gate browser journey only after the
   view is implemented; its negative identity and stale-Verification cases
   remain public-API assertions.

This checklist is satisfied by the independent post-landing review recorded
above. Design landing is complete; implementation still requires a separate
authorization.
