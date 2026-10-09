# AH10 Direct-child AssignWork Target Binding — Governance Acceptance and Landing

Date: 2026-10-09
Decision: **Accepted exact fixed package; design landing committed; independent consistency review PASS (Blocking = 0).**
Implementation: **Not authorized.**
Proposal: `planning/proposals/AH10-direct-child-committed-receipt-target-binding-draft.md`
Accepted SHA-256: `E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9`

## Decision record

The manual governor explicitly accepted the complete fixed proposal at the SHA-256 above. The accepted decision includes the proposal's selected disposition for an unproven Committed AssignWork receipt: persist one immutable P9 failure fact/event; project it through P10 as `Action Required` at the Execution's owning Parent Workspace; deduplicate by `(executionId, logicalActionId, committedCommandId)` and use existing subtree-summary bubbling; leave the Action Pending and recovery blocked; provide no v1 dismiss or repair action.

The proposal file's status sentence (“not accepted”) describes its pre-decision draft state and remains byte-for-byte unchanged so the accepted SHA stays auditable. The external manual acceptance supersedes that historical status sentence. Recomputing the proposal SHA immediately before landing returned the accepted value exactly.

Acceptance does not authorize implementation. Migration 0033 is recorded as a design contract only. No migration, production code, test, preserved dogfood database, staging, commit, or push was touched.

## Baseline and landed owners

Landing began at `HEAD = 868c940e66c51fb43784b83d80d0c8c2b0188200`, matching the proposal base. The exact nine-file design landing was committed as `932bfcd00884318e186aa60b547c6ffbbbb79f04` (`docs: land accepted AH10 target binding contract`). The independent review's seven owner hashes match the committed files, and the accepted proposal SHA was rechecked after the landing commit. Owning revisions are:

| Owner | Baseline | Landed revision | Contract added |
|---|---:|---:|---|
| `docs/design/02-system-design.md` | SD v1.10 | SD v1.11 | §4.11 is the sole semantic owner of binding, lifecycle-at-commit, and recovery result. |
| `docs/design/03-detailed-implementation-design.md` | DID v1.32 | DID v1.33 | §6A.16, §5.3 event, §7.2 ports, §9.3 migration 0033 schema, §9.9 atomic command/approval/failure event contracts. |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | Frozen P1 `07` | Amended | Exact AssignWork Committed-receipt gate and sole old-unbound exception. |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | Frozen P9 `07` | Amended | Immutable failure fact/event and recovery/observation order. |
| `docs/design/implementation/P10/02-attention-readmodel.md` | P10 `02` draft | Amended | Source, `Action Required`, Parent target, stable dedup, subtree projection, DTO fields, fixed detail. |
| `docs/design/implementation/P10/07-acceptance.md` | P10 `07` draft | Amended | Story I for projection, deduplication, bubbling, rebuild, and no canonical mutation. |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | P4 `03` draft | Amended | AssignWork's Command-boundary exact ActionApproval consumption with `consumedBy: CommandId`. |

SHA-256 of the seven landed owner files at this uncommitted landing:

| File | SHA-256 |
|---|---|
| `docs/design/02-system-design.md` | `4E410658ECA40AC42BFCB6A49D9F71D9496F6FE756E25863A2F6ADEED0AD52A2` |
| `docs/design/03-detailed-implementation-design.md` | `A0CCA77105D614E60CA766F50E9D93ABC8F8D2FE947D54345FB692AF1E6FFC40` |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | `494022A0CC34C5F2D7173C06ECDC89C5DF20D449B12F543C3573F211033CA8A1` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `2AF192086EEC80E26127871CBCFEE282A792E7A5709D47D04E0A46B84617E474` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `EA41A7E924368A3824CBDA4A32C8146CA710F69A6635093D8046A3E09FEB79C5` |
| `docs/design/implementation/P10/07-acceptance.md` | `CBB4F83DE5CE7F275F2E033BC8FD8194C3F23748A1189F1C63B3FB6A232A198B` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `0BAC1B514B017E48100A420F2FD4DC542701A1609E02AC1E3E39489D6A0DB4B0` |

## Landing diff

- System Design §4.11 freezes the effect-boundary rule: exact opaque selector binding; Active-at-commit; proof-complete replay after later retirement; fail-closed old or inconsistent receipts; no hash enumeration, authority widening, re-authorization, backfill, or repair.
- DID §6A.16 defines the process-local typed Grant/ActionApproval evidence, immutable target binding, current PlacementContext resolution, replay checks, and recovery outcomes. §5.3 registers `AssignWorkTargetBindingEscalated`; §7.2 registers the required ports. §9.3 specifies the exact additive migration 0033 tables, indexes, checks, and composite foreign keys. §9.9 binds authority validation, optional approval consumption, Work/event/receipt/binding writes, and the P9 failure fact/event to their transaction boundaries.
- P1 `07` adds only the exact prior-Committed receipt exception. P9 `07` owns the immutable source fact/event and recovery ordering. P10 `02` owns the accepted view mapping; P10 `07` adds projection acceptance. P4 `03` owns the route-specific atomic ActionApproval consumption adapter contract.
- No new semantics were added to MAC, CAPA, P12, or unrelated System Design clauses. No other AH10 branch is closed.

## Cross-document self-check

**Pass (independent review; Blocking = 0):** `planning/results/AH10-target-binding-design-landing.review.md` independently verified the accepted proposal against the seven owner files, including SQL/FK completeness, authority-field binding, commit-side crash behavior, P10 projection atomicity, and the adversarial qualification requirements. It recomputed the accepted proposal SHA and all seven owner hashes; all match this record. SD §4.11 is the only semantic owner; DID/P1/P9 refer back to it. P9 owns the fact/event and P10 owns the projection. Failure severity, Parent Workspace target, stable dedup identity, subtree behavior, fixed summary, and absence of dismiss/repair are consistent between accepted proposal, P9/DID, and P10. Typed Grant and ActionApproval evidence flow from ControlAction through the Command boundary; ActionApproval consumption is CommandId-bound and atomic, while replay does not consume again. New effects require Active lifecycle and exact current placement; post-commit retirement permits only proof-complete convergence. Historical Committed receipts receive no inferred binding or backfill. Migration 0033 is additive and forward-only and was not executed.

The independent review reports **Blocking = 0** for design content and cross-document consistency. The design landing commit is `932bfcd00884318e186aa60b547c6ffbbbb79f04`; this record update is the separate audit-chain follow-up commit. Its own commit SHA is reported externally to avoid a self-referential commit record. This governance acceptance and review do not authorize implementation. A separate explicit token `AUTHORIZE_AH10_ASSIGN_WORK_TARGET_BINDING_IMPLEMENTATION` is required before implementation.

## Scope and repository state

The design landing commit contains exactly the seven owning documents above, this decision record, and the independent review record. The proposal, F23 materials, implementation/test files, untracked P12 material, and the preserved dogfood database remain outside the landing commit. Existing unrelated working-tree changes remain unstaged and uncommitted. This follow-up changes only this governance record; no implementation or migration was performed.
