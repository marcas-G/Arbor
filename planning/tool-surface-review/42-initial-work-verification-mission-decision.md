# Initial Work / VerificationMission Source Decision

**Date:** 2026-09-27
**Status:** `DESIGN_GAP` remains open; no lifecycle choice made

## Question

When `ProposeChildWorkspace` includes `initialWork`, what supplies its
P8-valid `VerificationMission`, and at what point in the Work lifecycle must
that mission exist?

## Frozen contract facts

1. P6 `ChildWorkspaceProposal.initialWork` contains `objective`, `why`,
   `constraints`, and `completionExpectation`; it explicitly omits
   `verificationMission` because P6 does not own verification semantics
   (`docs/design/implementation/P6/01-formation-semantics.md` §2).
2. P6's formation chain creates the Workspace and, when `initialWork` is
   present, follows with P1 `AssignWork` (`P6/01` §4.2).
3. P1 `AssignWork` requires a `VerificationMission`
   (`docs/design/implementation/P1/01-command-contracts.md` §7).
4. P6's frozen formation text says the initial Work path uses the P1 minimal
   placeholder mission until P8 tightens the rule (`P6/01` §2).
5. P8 requires a non-empty mission goal and at least one required criterion;
   invalid missions are rejected by `StartVerification`
   (`docs/design/implementation/P8/01-verification-commands.md` §1;
   `P8/04-evidence-binding.md` §5).
6. P8 says the mission is the Producer/Parent's semantic responsibility and
   that a stored Work with the P6 placeholder must be refined before it can
   be verified (`P8/04` §5). This assigns responsibility for valid mission
   semantics, but does not specify how that responsibility enters the P6
   proposal or when it must be discharged for a newly formed child Work.

## Candidate relationships and ruling

| Candidate | Frozen support | Ruling |
|---|---|---|
| Parent Agent supplies the full VerificationMission in the child proposal | P8 assigns mission semantics to Producer/Parent; P6's proposal schema omits mission and explicitly says P6 does not own it | **Not closed.** No frozen cross-phase rule adds this field to the proposal or says initial Work must carry it at proposal time. |
| Runtime derives the mission from objective, why, constraints, or completion expectation | No frozen deterministic derivation or derivation algorithm exists; P8 makes mission content a semantic responsibility | **Not allowed by current evidence.** It would invent goal/criteria semantics. |
| Work is created first and a later independent verification-planning/refinement action supplies the mission | P8 says existing placeholder Work must be refined before verification | **Possible lifecycle reading, not a complete rule.** The sources do not say whether this applies to newly created initial Work, which action owns the refinement in the formation chain, or whether verification may remain unavailable until then. |

The frozen contracts therefore do not uniquely decide the relationship.

## Field-source classification

| Field | Classification | Basis |
|---|---|---|
| `initialWork.objective` | `MODEL_SUPPLIED` | Explicit P6 proposal field. |
| `initialWork.why` | `MODEL_SUPPLIED` | Explicit P6 proposal field. |
| `initialWork.constraints` | `MODEL_SUPPLIED` | Explicit P6 proposal field. |
| `initialWork.completionExpectation` | `MODEL_SUPPLIED` | Explicit P6 proposal field. |
| Missing `initialWork.verificationMission` source and timing | `DESIGN_UNRESOLVED` | P6 omits it; P8 tightens mission validity but does not freeze proposal-time versus later-refinement semantics. |

No Runtime binding can supply model-owned mission judgments. No
`DETERMINISTIC_DERIVATION` is established. No placeholder mission is approved
as the v2 semantic value.

## Creation and verification boundary

The evidence supports a narrow statement: P8 rejects an invalid mission when
starting verification, and existing Work may need refinement before it can
be verified. The reviewed text does **not** explicitly settle whether a
newly created child Work may persist temporarily with a placeholder mission
after P8, or whether valid mission content is a mandatory precondition for
that Work's creation.

Therefore the following are not frozen:

- whether initial Work creation is conditional on a valid mission;
- whether a Parent must provide mission semantics in `ProposeChildWorkspace`;
- whether a later refinement step is mandatory before the child Work becomes
  eligible for verification;
- how the approved formation proposal remains semantically complete if its
  initial Work is later refined.

## Semantic-preservation result

The path

```text
ProposeChildWorkspace.initialWork
→ CreateChildWorkspace
→ AssignWork
→ Work.verificationMission
→ StartVerification
```

cannot currently be proven complete without selecting one of the unresolved
lifecycle policies above. Deriving criteria from other text, silently using
the historical placeholder, or treating future refinement as guaranteed
would add semantics not stated by the frozen sources.

**Classification:** `DESIGN_GAP` / `DESIGN_UNRESOLVED`
**Closure:** OPEN

## Evidence

- `docs/design/implementation/P6/01-formation-semantics.md` §§2, 4.2, 5–6
- `docs/design/implementation/P1/01-command-contracts.md` §7
- `docs/design/implementation/P8/01-verification-commands.md` §1
- `docs/design/implementation/P8/04-evidence-binding.md` §5
- `packages/domain/src/formation.ts` `ChildWorkspaceProposal`
- `packages/domain/src/verification.ts` `VerificationMission`
