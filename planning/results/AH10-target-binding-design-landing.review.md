# AH10 Direct-child AssignWork Target Binding — Independent Design Landing Review

Date: 2026-10-09
Review: **PASS; Blocking = 0**
Scope: Read-only consistency review of the accepted governance landing in the current working tree. No implementation or tests were run.

## Acceptance and baseline

- Accepted proposal: `planning/proposals/AH10-direct-child-committed-receipt-target-binding-draft.md`
- Accepted SHA-256: `E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9`
- Recomputed current proposal SHA-256: `E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9` — exact match.
- Baseline HEAD: `868c940e66c51fb43784b83d80d0c8c2b0188200`, matching the proposal base recorded in the landing decision.
- Owner revisions: System Design v1.10 → v1.11; DID v1.32 → v1.33.

The current working-tree owner-file hashes were recomputed during this review and match the landing decision record:

| Owner file | Semantic / executable ownership | Current SHA-256 |
|---|---|---|
| `docs/design/02-system-design.md` | SD v1.11 §4.11 is the sole semantic owner for exact selector-to-target binding, lifecycle at commit, and recovery outcome. | `4E410658ECA40AC42BFCB6A49D9F71D9496F6FE756E25863A2F6ADEED0AD52A2` |
| `docs/design/03-detailed-implementation-design.md` | DID v1.33 defines typed evidence, ports, migration 0033, transaction boundaries, and event/schema contracts. | `A0CCA77105D614E60CA766F50E9D93ABC8F8D2FE947D54345FB692AF1E6FFC40` |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | The narrow direct-child AssignWork exception to prior-Committed receipt convergence. | `494022A0CC34C5F2D7173C06ECDC89C5DF20D449B12F543C3573F211033CA8A1` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | Immutable failure fact/event and recovery/Observation ordering. | `2AF192086EEC80E26127871CBCFEE282A792E7A5709D47D04E0A46B84617E474` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | Action Required severity, Parent Workspace target, stable deduplication, and subtree projection. | `EA41A7E924368A3824CBDA4A32C8146CA710F69A6635093D8046A3E09FEB79C5` |
| `docs/design/implementation/P10/07-acceptance.md` | Projection qualification story, including deduplication, rebuild, restart, and no canonical mutation. | `CBB4F83DE5CE7F275F2E033BC8FD8194C3F23748A1189F1C63B3FB6A232A198B` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | P4-owned ActionApproval consumption adapter, atomically bound to the AssignWork CommandId. | `0BAC1B514B017E48100A420F2FD4DC542701A1609E02AC1E3E39489D6A0DB4B0` |

## Review findings

The landing matches the accepted fixed package. SD §4.11 owns the semantics; DID specifies the executable contract; P1 adds only the receipt-first exception; P9 owns the immutable failure fact/event; P10 owns its projection and qualification; P4 owns the approval-consumption adapter. The reviewed contracts agree on:

- Exact typed PermissionGrant or ActionApproval evidence crossing the trusted ControlAction-to-Command boundary; commit-time revalidation and, for approvals, single CommandId-bound consumption in the same transaction as Work, event, receipt, and binding.
- Proof-complete receipt replay without resolving the stale selector, reauthorizing, consuming approval again, or issuing another Command. Missing, old-unbound, malformed, duplicate, or mismatched committed evidence stays fail-closed, leaves the Action Pending, emits no Observation, and records the P9 fact/event.
- Action Required projection at the Execution's owning Parent Workspace, deduplicated by the deterministic fact identity and included in existing subtree summaries.
- A direct Parent that may be non-root; Active lifecycle required at the original effect commit, with later retirement compatible with proof-complete replay.
- Additive, forward-only migration 0033, composite project/parent/authority constraints, and no legacy binding backfill.
- The accepted sibling A→B adversarial case and the broader crash/authority matrix remain qualification requirements. The package requires a separate explicit implementation authorization token; the landing does not grant it.

No F23/FT-DG-03 proposal or semantics were introduced into the landing. The reviewed diff is limited to the seven owner documents above. No P12, production-code, or test files are part of the diff; no tests were run.

## Audit status and authorization

**Blocking = 0** for the reviewed design content and cross-document consistency. The landing is still uncommitted at the reviewed baseline, so there is no landing commit SHA to record yet. After commit, update the governance landing decision record with that SHA before treating the governance audit chain as complete or marking the design gap resolved.

Implementation remains **NOT AUTHORIZED**. It requires the separate explicit token `AUTHORIZE_AH10_ASSIGN_WORK_TARGET_BINDING_IMPLEMENTATION` after this review, as specified by the accepted proposal.
