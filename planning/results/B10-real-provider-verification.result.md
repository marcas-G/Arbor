# B10 Real-provider Verification Result

**Date:** 2026-10-03

**Status:** COMPLETE — L1/L2/L3 PASS / REAL 3/3

## Governance reconciliation

The latest DID already froze the four former field-source mappings in the
manually accepted v1.26 VDC-1…VDC-8 contract. The remaining OPEN labels came
from the older v1.19 ACR-8 checkpoint and stale planning indexes. They were
reconciled as superseded historical state; no new semantic ruling was invented.

Resolved mappings:

```text
G-V2-1 AssignWork provenance
  predecessor = current parent Work when present, otherwise null
  reason      = bounded model-authored rationale

G-V2-2 ToolObservation evidence
  ToolInvocationId + observationRef + executionId + callRef
  bound by Runtime from durable ToolInvocation + sourced ToolResult

G-V2-3 conclusion summary
  model authors summary content
  Runtime BlobStore put + byte verification creates summaryRef
  Verification state/event persist the exact ref

G-V2-4 child initialWork mission
  Parent-approved proposal carries a complete explicit VerificationMission
  no placeholder or objective-derived criteria
```

## Real B10 sentinel

One isolated Project/Workspace/Work is created with a real filesystem evidence
file. A system-authorized StartVerification command admits an exact-bound
Verifier Execution. The real DeepSeek verifier must:

1. read/inspect the evidence using an executable tool;
2. call `record_verification_evidence` with the ToolResult callRef;
3. let Runtime bind canonical evidence identity;
4. call `conclude_verification` with exact criterion judgment and summary text;
5. let Runtime persist/resolve summary Blob and submit ConcludeVerification;
6. settle `Completed(VerificationConcluded)`.

Mechanical oracle additionally proves:

- Verification state `Concluded / Pass`;
- non-null summaryRef resolves to non-empty accepted bytes;
- every Evidence row has toolInvocationId, observationRef and callRef;
- target Work remains Open (no Parent Acceptance bypass);
- Provider trace contains both verification control tools.

## Stability

```text
L1 PASS
L2 PASS
L3 PASS
real repetitions 3/3
failures 0
assertion failures 0
```

Focused B10 report:

```text
C:/Arbor/planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T20-21-43.576Z-d316a201-9520-47b7-b618-822bb7c80ccb.json
```

Unified B01–B14 report:

```text
C:/Arbor/planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T20-43-10.293Z-f8122095-9c6a-4163-8702-a9ca0dff2b20.json
```

Unified-run B10 evidence:

```text
C:/Arbor/planning/testing/core-capability/evidence/real-provider/B10-L3-REAL-2026-10-02T20-48-40.750Z-62d5dc7d-fd4f-4acc-9a91-109eaf826081.json
C:/Arbor/planning/testing/core-capability/evidence/real-provider/B10-L3-REAL-2026-10-02T20-48-46.778Z-f2da6d60-d621-4177-92c1-870cd17c7fc1.json
C:/Arbor/planning/testing/core-capability/evidence/real-provider/B10-L3-REAL-2026-10-02T20-48-59.061Z-064206f8-8db3-48d0-b05e-8f52b4a7d239.json
```

## Verdict

B10 is no longer blocked or NOT_RUN. The complete B01–B14 matrix is green on
the official DeepSeek Flash deployment.
