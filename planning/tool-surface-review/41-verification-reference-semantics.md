# Verification Reference Semantics

**Date:** 2026-09-27
**Status:** HISTORICAL SOURCE AUDIT — G-V2-2/3 RESOLVED by accepted DID v1.26
VDC-2/3; retained as pre-closure evidence

## Purpose

This document checks whether a verifier's chosen source and conclusion summary
have stable, authoritative references that can pass through a canonical
`AgentDirective v2` action into P8 records without loss. It does not define a
new storage schema or choose an implementation.

## ToolObservation identity

### What is identified by the frozen sources

| Object | Frozen identity/evidence | What it identifies |
|---|---|---|
| Tool invocation | P4 `ToolIntent.invocationId`; P4 `tool_invocations.invocation_id` | The invocation intent/settlement, keyed with `executionId` for replay. |
| Large tool result | Optional P4 `resultRef`, backed by Artifact in P4's large-result path | A stored raw result artifact when one exists. |
| Bounded observation | P4 `BoundedObservation { text, truncated }`; P3 Session Observation has generic `ref` | The observation content/surface, but no frozen typed identity tying it to the invocation or exact bounded result. |
| Verification evidence | P8 `EvidenceRecord.evidenceId`, `kind`, optional `artifactRef`, `recordedByExecutionId`, `recordedAt` | The evidence record and some artifact provenance; not a selected ToolObservation locator. |

P4's stable `invocationId` is not automatically the identity of the
observation produced by that invocation. P4 returns a bounded observation;
large outputs may have `resultRef`, while small outputs can have no artifact
reference. P3's generic Session `ref` is not normatively specified as either
of those identities. P8 does not persist an invocation ID, Session entry ref,
or observation ID for `kind: "ToolObservation"`.

### Model choice and Runtime proof

The canonical action needs to preserve which available observation was
selected as support for a particular criterion. The model must select that
source; Runtime must establish that the selected source is an authentic,
existing object in the current verifier's allowed context. Copying the
observation's text cannot prove provenance.

The current runtime implementation does not establish this chain:

1. `apps/single-workspace/src/directives.ts`, `toOutcome`, maps successful
   tool results to `source: "Tool"` plus bounded observation content, with no
   invocation or observation ID.
2. `packages/agent-runtime/src/driver.ts`, observation append loop, persists
   the returned `source` and `observation` as a Session entry.
3. `packages/ports/src/verification-store.ts`, `EvidenceRecordRow`, has no
   selected observation/invocation locator.

This describes the current implementation surface only. It does not amend
P4, P3, or P8 contract meaning.

### Source classification

| Field | Classification | Reason |
|---|---|---|
| Criterion selected for evidence | `MODEL_SUPPLIED` | The action expresses the semantic relation between evidence and criterion. |
| Exact ToolObservation source identity | `DESIGN_UNRESOLVED` | No frozen canonical handle and persistence field connect the model-visible observation to an exact source object. |
| Artifact source when evidence is explicitly an existing ArtifactRef | `EXISTING_OBJECT_REFERENCE` | P8 has `artifactRef`; this does not close the separate ToolObservation case. |

P8 also carries evidence-record identity and recording-execution/time fields.
Those identify the record and its recorder; they do not identify the selected
ToolObservation source and are outside this gap's source classification.

The classification for the selected ToolObservation is
`DESIGN_UNRESOLVED`, not `EXISTING_OBJECT_REFERENCE`: that latter
classification would require a frozen reference identity and binding rule,
which are absent.

### Required validation facts that remain unprovable

Without a frozen identity link, Runtime cannot mechanically establish all of:

- the referenced observation exists;
- it is the exact observation the model selected;
- it arose from the current verifier execution/session or another explicitly
  permitted source;
- the model did not fabricate or substitute the source;
- the EvidenceRecord retains a durable locator that can later be resolved.

P8's verifier-authority check establishes who may append evidence; it does
not establish which tool observation was selected.

## `ConcludeVerification.summaryRef`

### Frozen command and persistence facts

P8 `ConcludeVerification` requires `summaryRef` alongside verdict and
criterion results (`P8/01` §3). The corresponding P8 Evidence binding
contract specifies criterion results, evidence refs, and evidence record
shape, but does not define summary content or its author.

P4's `BlobStorePort.put` returns a content-addressed `BlobRef`, and
`ArtifactService.store` writes content before artifact metadata
(`P4/07` §§1–4). This establishes a general content-storage capability and
its artifact failure shape. It does not state that a P8 conclusion summary
must be authored in the model action, persisted using P4, or included in an
atomic transaction with the conclusion.

The current application accepts `summaryRef` in
`ConcludeVerificationPayload`, but the handler neither loads nor persists
summary content and the emitted `VerificationConcluded` event does not carry
the field (`packages/application/src/commands/conclude-verification.ts`,
payload and event construction). This is an as-built fact and does not
determine the intended v2 contract.

### Source classification and closure

| Semantic item | Classification | Frozen rule available? |
|---|---|---|
| Summary body/meaning | `DESIGN_UNRESOLVED` | No author, required content, or deterministic source is defined in P8. |
| `summaryRef` | `DESIGN_UNRESOLVED` | P8 requires a string reference but does not define its target class or creation boundary. |
| Existing P4 BlobRef/Artifact | `EXISTING_OBJECT_REFERENCE` only if a frozen P8 rule selects one | No such P8 rule was found. |
| Model-authored body persisted by Runtime | `MODEL_SUPPLIED` body + `CONTENT_PERSISTED_TO_REF` reference is a candidate only | Not frozen; cannot be recorded as the decision. |

No conclusion can be made about:

- whether the summary is model-authored semantic content or an existing
  artifact/reference;
- whether Runtime must persist bytes and create the ref;
- whether summary persistence and conclusion persistence are atomic;
- whether persistence failure rejects the whole conclusion or can leave a
  partially completed operation.

Accordingly, this audit recorded the gap as `DESIGN_UNRESOLVED`. P4's blob
mechanics alone could not be generalized into a P8 semantic rule without an
explicit decision.

## Closure result

The scoped assessment in `44-g-v2-3-conclusion-summary-closure.md` finds a
compatible content-to-BlobRef candidate but also identifies the missing
durable P8 association. Therefore `G-V2-2 = OPEN` and `G-V2-3 = OPEN`. No
conclusion in this audit changes the ToolObservation source-identity finding.

## Evidence

- `docs/design/implementation/P4/01-tool-contracts.md` §§3–4
- `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` §1
- `docs/design/implementation/P4/07-blob-artifact.md` §§1–5
- `docs/design/implementation/P3/04-sqlite-schema.md` §3.4
- `docs/design/implementation/P8/01-verification-commands.md` §§2–3
- `docs/design/implementation/P8/04-evidence-binding.md` §§1–2
- `apps/single-workspace/src/directives.ts` `toOutcome`
- `packages/agent-runtime/src/driver.ts` Session observation append loop
- `packages/ports/src/verification-store.ts` `EvidenceRecordRow`
- `packages/application/src/commands/conclude-verification.ts` payload and handler
