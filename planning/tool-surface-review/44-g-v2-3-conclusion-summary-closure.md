# G-V2-3 — Verification Conclusion Summary Closure

**Date:** 2026-09-27
**Status:** Closure assessment — source/ref path adjudicated; durable P8 binding remains unresolved
**Scope:** `AgentDirective v2` / `ConcludeVerification.summaryRef` only
**Authority:** G-V2-3 assessment; no frozen contract, code, Prompt, or
model-facing schema changed

## Decision

Recommended ruling for a normal verifier conclusion: the verifier model owns the summary's
meaning and authored content. The summary is part of the semantic intent of
`ConcludeVerification`: it is the verifier's concise human-readable account of
the judgment, including material findings and, for `Unknown` or `Fail`, the
reason or uncertainty a downstream reader needs. It is not derivable from the
verdict and criterion results without losing that explanation.

The model supplies summary **content**, never `summaryRef`. Runtime preserves
the content byte-for-byte as UTF-8 and obtains the authoritative reference
from P4 `BlobStorePort.put`. `summaryRef` is that content-addressed `BlobRef`.
This uses the same content → P4 BlobStore → returned reference pattern as the
closed P6 communication-body path. The summary is content, not a P4
`ArtifactId`; an Artifact metadata record is not required merely to store the
summary bytes.

P4 supplies the storage and reference mechanism; P8 supplies the required
`summaryRef` slot. Neither frozen source had already assigned this exact
content-to-ref meaning to verification summaries. Selecting model-authored
content and `BlobRef` is therefore a governance decision for this existing
gap, not a claim that the mapping was already frozen.

For the P8 `Unknown(Orphaned)` governance path, there is no active verifier
model to author a judgment. The authorized Parent governance actor supplies
the concise orphaning explanation as the summary content; Runtime performs
the same content-to-BlobRef binding. This does not let Runtime invent a
verifier judgment or rewrite a submitted summary.

## Canonical boundary

Under the recommended ruling, the semantic input to normal
`ConcludeVerification` consists of the
criterion-level judgments and their selected evidence, the overall verdict,
and the authored summary content. P8's frozen mission supplies each
criterion's requirement and required/optional status; Runtime validates and
binds the submitted results against that mission. P8 continues to enforce
the deterministic overall-verdict aggregation and evidence binding.

The post-persistence P8 command remains the existing contract:

```text
{ verificationId, verdict, criteriaResults, summaryRef,
  conclusionReason?: "Orphaned" }
```

`summaryRef` in this command is Runtime-produced storage metadata. The
model-facing semantic input contains summary content instead; this closure
does not define its wire schema.

## Persistence and failure boundary

The compatible candidate persistence order is:

```text
verifier judgment + authored summary content
→ Runtime binds the active verification and validates the P8 judgment
→ BlobStorePort.put(UTF-8 summary bytes) → content-addressed BlobRef
→ verify the returned ref resolves to those bytes
→ P8 ConcludeVerification(summaryRef = BlobRef)
→ Control-DB ConcludeVerification transaction
```

Blob storage and the P8 Control-DB transaction do not share a transaction.
Under this proposed mapping, successful, verified content persistence is a precondition for submitting
the conclusion command. Blob write or resolution failure means no conclusion
command is submitted. A successful Blob write followed by command rejection,
operational failure, or process crash may leave an unreachable orphan Blob;
that is allowed under P4's write-before-metadata failure model and the
closed P6 body-binding precedent. An orphan is not a conclusion and may only
be collected while unreachable.

The frozen P8 contract does not define a durable association from
`summaryRef` to the concluded Verification. `VerificationConcluded` omits
`summaryRef`; the frozen Verification state shape has no summary reference;
and P8 `04` names only `missionSnapshot` and `criteriaResults` as conclusion
snapshots stored in the `verifications` row. P1's command record stores the
request fingerprint and resolution, not the original payload as a queryable
summary link. A downstream consumer therefore cannot resolve the summary
from durable canonical state under the current contracts.

To make this required ordering enforceable and guarantee
“committed conclusion ⇒ resolvable summary,” P8 must define a
durable Verification-to-`summaryRef` association in the conclusion
transaction. This assessment does not add that association because frozen
contracts are out of scope. Consequently the content → ref → command step is
well-defined as a candidate, but the complete chain to durable state remains
open.

## Retry and immutability

The same exact UTF-8 bytes produce the same content-addressed BlobRef. A
retry of one logical output occurrence reuses its bound command identity and
unchanged semantic request. P1's command ID plus semantic request fingerprint
returns the prior receipt on an exact replay and rejects changed content under
the same command ID as an idempotency conflict. A retry after a blob-only
write can therefore reuse the same content/reference; it cannot silently
replace the summary under the same command identity.

The P8 Open-only conclusion transition prevents a second conclusion from
changing a committed verdict. Under the current frozen shape, however, that
immutable state does not retain the summary reference. The proposed retry
protocol avoids duplicate conclusions but does not fill this persistence
omission.

## Runtime ownership and field classification

Runtime may enforce P8 validation, bind the active `verificationId` and
authority, copy mission snapshots, encode/persist summary bytes, create the
BlobRef, allocate command/event identifiers and timestamps, and derive
`workId`, `targetWorkRevision`, and flattened `evidenceRefs` from the bound
Verification and criterion results. Runtime may reject invalid content or a
P8-inconsistent judgment; it may not compose, paraphrase, normalize, or
otherwise alter the summary or model's criterion judgment.

The semantic fields are the criterion judgments, evidence selections,
overall verdict assertion, and summary content. The generated `summaryRef`,
IDs, authority/principal, causal fields, timestamps, and Verification/work/
revision bindings are Runtime metadata or existing-object bindings. The
optional `conclusionReason: "Orphaned"` remains the P8 governance-path
selector and is not an ordinary verifier-model choice.

## Design Gap result

The proposed ownership and BlobRef binding resolve the content-to-ref choice,
but the durable P8 link is absent. Therefore `G-V2-3 = OPEN`; no new,
separate Design Gap is needed because the missing durable association belongs
to this same summary-to-conclusion chain. G-V2-1, G-V2-2, and G-V2-4 are
outside scope and unchanged.

## Frozen-source support

- P4 `BlobStorePort` owns content bytes, has `put/get/stream`, and defines
  `BlobRef` as content-addressed: `docs/design/implementation/P4/07-blob-artifact.md`
  §§1–2; DID §7.8.
- P8 requires `summaryRef` in `ConcludeVerification`, validates criterion
  results/evidence and deterministic verdict aggregation, and defines the
  Open-only immutable conclusion: `docs/design/implementation/P8/01-verification-commands.md`
  §3; `docs/design/implementation/P8/04-evidence-binding.md` §2; DID §12.11.
- The P6 closure establishes model-authored body → Runtime `BlobStorePort.put`
  → authoritative content-addressed BlobRef → durable command, with
  write-before-command ordering and permissible orphan blobs:
  `planning/tool-surface-review/31-communication-binding-closure.md`
  (“G-C1 — Body and reference”, “Authoritative persistence point and failure
  boundary”, and “Retry and idempotency”).
- P1 supplies atomic command state/event/receipt persistence and exact replay
  semantics: `docs/design/implementation/P1/03-transaction-model.md` §§3.1,
  3.4; DID §§7.4, 9.9.
