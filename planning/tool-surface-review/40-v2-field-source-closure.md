# AgentDirective v2 Field-Source Closure

**Date:** 2026-09-27
**Status:** HISTORICAL SOURCE AUDIT — superseded; G-V2-1…4 RESOLVED by the
manually accepted DID v1.26 VDC-1…VDC-8 contract
**Scope:** G-V2-1 through G-V2-4 only. No v2 redesign, model-facing representation, S01, or implementation.

> Supersession notice (2026-10-03): the OPEN findings below describe the
> 2026-09-27 checkpoint. DID v1.26 later froze all four sources and its
> implementation is mechanically/live qualified. Preserve the audit as
> history; do not use its old status as a current gate.

## Decision

The source audit found four unresolved mappings. The scoped G-V2-3 assessment
identifies a compatible content-to-BlobRef candidate but also confirms that
the frozen P8 contract has no durable Verification-to-summaryRef binding.
All four mappings remain `DESIGN_UNRESOLVED`.

| Gap | Field(s) reviewed | Unique source classification | Closure |
|---|---|---|---|
| G-V2-1 | `AssignWork.Provenance.predecessorWorkId` | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-1 | `AssignWork.Provenance.reason` | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-2 | selected `ToolObservation` source identity | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-3 | conclusion summary content and required `summaryRef` | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-4 | `ProposeChildWorkspace.initialWork.verificationMission` | `DESIGN_UNRESOLVED` | OPEN |

No fifth gap is introduced. The four previously recorded source-mapping gaps
remain open.

## Field-source rule

Each field is classified by one of the user-defined categories:

`MODEL_SUPPLIED`, `RUNTIME_BOUND`, `CONTENT_PERSISTED_TO_REF`,
`EXISTING_OBJECT_REFERENCE`, `DETERMINISTIC_DERIVATION`, or
`DESIGN_UNRESOLVED`.

The first five categories require an authoritative frozen source and a
lossless rule. An implementation convention, likely value, or convenient
downstream DTO mapping is not sufficient.

## G-V2-1 — `AssignWork.Provenance`

### Frozen shape and evidence

P1 `AssignWork` requires a `provenance: Provenance` payload member.
`packages/domain/src/work.ts` defines that value as exactly:

```ts
interface Provenance {
  readonly predecessorWorkId: WorkId | null;
  readonly reason: string;
}
```

The shape does not contain actor, timestamp, or action-kind fields. DID
§1.4A says an unfinished item moved to a successor Workspace is represented
by a *new* Work whose provenance points to the superseded Work; it does not
define a general derivation rule for all `AssignWork` actions. Responsibility
Handoff is deferred, so that special successor statement does not establish
a universal predecessor rule.

The accepted Action Language matrix (`planning/tool-surface-review/28-action-language-final-matrix.md`,
`AssignWork` row) labels provenance Runtime-bound. That establishes an
accepted ownership intent, but does not specify the exact source of either
member or a deterministic transform into P1's payload.

### Classification

| Semantic member | Classification | Reason |
|---|---|---|
| `predecessorWorkId` | `DESIGN_UNRESOLVED` | It may be null or identify a superseded Work, but the action contract does not state when assignment means succession or which existing Work is the predecessor. |
| `reason` | `DESIGN_UNRESOLVED` | P1 does not define whether this repeats `why`, describes a supersession, or is generated from another frozen fact. Equating it with `why` would be an unapproved semantic mapping. |

**Semantic owner:** unresolved at the field level.
**Authoritative source:** none frozen for the general `AssignWork` path.
**Deterministic transform:** none established.
**Validation rule:** P1 requires a `Provenance` value but does not define a
semantic validation rule that resolves these sources. No model-authored
opaque ID, default, or inferred reason is accepted by this review.

## G-V2-2 — exact ToolObservation source identity

P4 defines a stable `invocationId` and persists tool invocation records under
that identity (`P4/01` §3; `P4/06` §1). P4 also distinguishes a bounded
observation from a large raw result stored behind optional `resultRef`
(`P4/01` §4; `P4/07` §§4–5). These facts identify a tool invocation and
sometimes a result artifact; they do not freeze an identity for the exact
model-visible observation selected as evidence.

P3's Session `Observation` entry has a generic `ref` and trust metadata
(`P3/04` §3.4). It does not define that ref as a ToolInvocation ID, result
artifact ID, or immutable observation ID. P8's `EvidenceRecord` has
`kind: "ToolObservation"` and optional `artifactRef`, but no source
observation/invocation field (`P8/04` §1).

The implementation path is also not a closure source: the current directive
handler converts successful/expected-failure tool results to `{ source:
"Tool", observation }` without carrying a source identity
(`apps/single-workspace/src/directives.ts`, `toOutcome`); the driver appends
that payload as a Session Observation (`packages/agent-runtime/src/driver.ts`,
observation append loop). The current EvidenceRecord row contains no
ToolObservation source locator (`packages/ports/src/verification-store.ts`,
`EvidenceRecordRow`).

**Classification:** `DESIGN_UNRESOLVED`.

There is no authoritative canonical handle that this review can designate.
`invocationId`, `resultRef`, and Session `ref` are distinct existing concepts;
the frozen documents do not establish that any one is the exact selected
observation identity or that P8 durably preserves it. Runtime therefore
cannot yet mechanically prove that a submitted source exists, belongs to the
current verifier execution/session, and was not fabricated by the model.

## G-V2-3 — `ConcludeVerification.summaryRef`

The scoped assessment in
`planning/tool-surface-review/44-g-v2-3-conclusion-summary-closure.md`
identifies model-authored content persisted via P4 `BlobStorePort.put` as a
compatible candidate. However, frozen P8 does not durably associate the
resulting `summaryRef` with the concluded Verification: the event omits it,
the Verification state shape omits it, and P8 `04` only names
`missionSnapshot` and `criteriaResults` as stored conclusion snapshots.
Accordingly the full field mapping remains `DESIGN_UNRESOLVED` and G-V2-3
remains OPEN under the no-frozen-contract-change constraint.

## G-V2-4 — `initialWork` and `VerificationMission`

P6 freezes optional `initialWork` as `objective`, `why`, `constraints`, and
`completionExpectation`, and explicitly omits `verificationMission` because
P6 does not own verification semantics (`P6/01` §2). Its formation chain
creates the child Workspace and then calls P1 `AssignWork` when `initialWork`
exists (`P6/01` §4.2). P6 specifies use of a minimal placeholder mission in
that path.

P8 later freezes a mission validity rule: a mission must have a non-empty
goal and at least one required criterion; an invalid mission is rejected by
`StartVerification` (`P8/01` §1; `P8/04` §5). P8 also says existing Work with
the P6 placeholder must be refined before it can be verified. This makes
Runtime invention of mission semantics impermissible, but does not decide
whether the parent agent must supply a mission in a child proposal, whether
the child Work may be created and refined later, or precisely when that
refinement must occur.

| `ProposeChildWorkspace` field | Classification | Reason |
|---|---|---|
| `initialWork.objective`, `why`, `constraints`, `completionExpectation` | `MODEL_SUPPLIED` | These are explicitly part of the P6 proposal and bootstrap inputs. |
| `initialWork.verificationMission` | `DESIGN_UNRESOLVED` | P6 omits it; P8 assigns mission meaning to Producer/Parent responsibility and invalidates the placeholder for verification, but no frozen cross-phase rule binds that responsibility to initial proposal creation or later refinement. |

**Authoritative source:** no single lifecycle rule reconciles the P6 proposal
shape and P8 mission requirements.
**Deterministic transform:** prohibited absent a frozen derivation; neither
objective text nor completion expectation uniquely determines criteria.
**Validation rule:** P8 rejects an invalid mission when starting verification;
the reviewed sources do not settle whether this is also a creation-time
condition for a child Work produced by `initialWork`.

## Cross-branch source completeness

The unresolved classifications prevent the required proofs:

- `AssignWork`: downstream Work history may gain an invented predecessor or
  reason.
- `RecordVerificationEvidence`: the chosen observation cannot be proven to
  survive as an exact existing source reference.
- `ConcludeVerification`: the summary meaning and reference cannot be
  preserved from an unspecified source.
- `ProposeChildWorkspace`: a P8-valid mission cannot be supplied or derived
  without selecting an unfrozen lifecycle rule.

No placeholder, default, or inferred semantic value is authorized here.
P6's already-documented placeholder mission remains an existing frozen
historical/current-design fact, and is explicitly not adopted as a v2
solution.

## Evidence index

| Claim | Frozen/design evidence | As-built evidence |
|---|---|---|
| Provenance shape and P1 requirement | `packages/domain/src/work.ts` `Provenance`; `docs/design/implementation/P1/01-command-contracts.md` §7; `docs/design/03-detailed-implementation-design.md` §1.4A | `adapters/persistence-sqlite/src/repositories.ts`, Work mapping |
| Tool invocation vs observation identity | `docs/design/implementation/P4/01-tool-contracts.md` §§3–4; `P4/06-invocation-persistence-reconciliation.md` §1; `P3/04-sqlite-schema.md` §3.4; `P8/04-evidence-binding.md` §1 | `apps/single-workspace/src/directives.ts` `toOutcome`; `packages/agent-runtime/src/driver.ts` observation append; `packages/ports/src/verification-store.ts` `EvidenceRecordRow` |
| P8 summary source | `docs/design/implementation/P8/01-verification-commands.md` §3; `P4/07-blob-artifact.md` §§1–4 | `packages/application/src/commands/conclude-verification.ts` `ConcludeVerificationPayload` and handler |
| Initial Work / mission | `docs/design/implementation/P6/01-formation-semantics.md` §§2, 4.2; `P8/01-verification-commands.md` §1; `P8/04-evidence-binding.md` §5 | `packages/domain/src/formation.ts` `ChildWorkspaceProposal`; `packages/domain/src/verification.ts` `VerificationMission` |
