# Agent Core Gap Closure — Governance Decision Draft

**Status:** RECOMMENDED / AWAITING MANUAL ACCEPTANCE
**Date:** 2026-10-01

## 1. Tool authority source

### Problem

`InvocationAuthority` requires exact capabilities, regions, digest, expiry and
delegation depth. Non-human principals currently require PermissionGrant, but
Workspace AgentBinding does not carry capabilities and ordinary Work admission
does not create grants. The production bridge therefore hardcodes broad
capabilities, which must be removed.

### Recommended ruling

Adopt a hybrid baseline:

1. `read` and `list` are baseline capabilities of a ResponsibilityBound
   Execution, limited to the Workspace's current ResourceBoundary and current
   ControlBasis.
2. `patch`, `shell`, Project tools, and every non-read-only tool require an
   active explicit PermissionGrant whose scope covers every requested
   capability.
3. ExecutionBound specialists inherit no new capability. Their ceiling is the
   intersection of the parent InvocationAuthority and their mission/resource
   boundary.
4. Authority TTL comes from policy; no indefinite expiry.
5. Tool Runtime resolves regions first, then invokes AuthorityResolver with the
   exact ToolDefinition capability metadata and resolved resource-space IDs.
6. Denial is a normal `Denied` observation, not a defect and not a canonical
   mutation.

## 2. G-V2-1 — AssignWork provenance

### Recommended ruling

- Add explicit intent `supersedesCurrentWork: boolean` to the control action.
- When false: `predecessorWorkId = null`; reason is the model-authored bounded
  assignment rationale.
- When true: Application binds predecessor to the Workspace's canonical
  `currentWorkId` under revision check; absence rejects the command.
- Never infer predecessor from history, `why`, or recency.

## 3. G-V2-2 — ToolObservation identity

### Recommended ruling

- The canonical evidence handle is an `ObservationRef` containing
  `sessionId + sessionSequence + sourceKind + sourceRef + contentHash`.
- For executable actions, `sourceRef` is the durable AgentLoop action
  observation source, which binds ProviderTurn callRef, resultRef and
  ToolInvocation settlement.
- Verification Evidence stores the ObservationRef plus the observed
  EnvironmentRevision; model-visible text is never itself the identity.

## 4. G-V2-3 — Verification conclusion summary

### Recommended ruling

- The verifier authors bounded summary content after evidence recording.
- Runtime stores it as a content-addressed Blob before ConcludeVerification.
- `summaryRef` is that BlobRef.
- Verification conclusion persists the exact summaryRef; ConcludeVerification
  rejects a missing blob or a ref not bound to the same Verification.
- Parent Acceptance may read the summary but cannot rewrite it.

## 5. G-V2-4 — initial Work VerificationMission lifecycle

### Recommended ruling

- A child proposal with `initialWork` must include a complete
  VerificationMission draft.
- The first-layer human governance gate may Approve/Reject/Modify it before
  Work creation.
- After creation, only RefineWork may replace the mission; replacement bumps
  Work revision and invalidates prior Verification/Acceptance bindings.
- No placeholder or empty mission is admitted.

## 6. Implementation sequence after acceptance

1. ToolAuthorityResolver port + ToolRuntime integration.
2. Read/list baseline policy and explicit grant tests for write/shell.
3. ObservationRef ADT/persistence/evidence binding.
4. Verification summary Blob binding.
5. ProposeChildWorkspace mission schema + governance Modify path.
6. AssignWork supersession intent/provenance binding.
7. B10 L1/L2/L3 qualification.

## Acceptance token

Manual governance may accept this complete package with:

```text
ACCEPT_AGENT_CORE_GAP_CLOSURE
```
