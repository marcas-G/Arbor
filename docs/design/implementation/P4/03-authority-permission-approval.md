# P4 — 03 Authority / Permission / Approval

**Authority:** DID v1.8 §7.6/§6A.7 and v1.39 EA-DG-01, G1/G2; SD v1.14 §8.1–§8.5.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.
Accepted EA-DG-01 Executable route amendment: fixed proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
decision `planning/results/EA-DG-01-governance-acceptance.md`.

## 1. Boundary

P4 does **not** resolve PermissionGrant / Parent / User governance (G1). The
Authority Resolver stays deferred. P4 receives trusted facts and performs
deterministic exact-match plus capability-ceiling checks.

For the externally routed `ResolveControlApproval` command, strict payload
decoding follows the P4/P12 approval-decision contract (including the exact
`ApprovalId` and Approve/Reject decision fields) before the resolver and
Gateway. The codec cannot construct or accept any process-local
`AssignWorkCommandEvidence` or `AssignWorkControlAuthorizationEvidence`; this
section continues to own only the typed approval record and its atomic
consumption contract (DID §4.1B).

## 2. Trusted `InvocationAuthority` fact

```ts
interface InvocationAuthority {
  readonly principal: Principal;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly resourceSpaceIds: ReadonlyArray<string>;   // resolved regions
  readonly allowedCapabilities: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
  readonly delegationDepth: number;
}
```

Exact-match predicate (all conjuncts; any mismatch → `Denied`):

```text
authority.principal            == context.actor's authenticated principal
authority.workspaceId          == context.workspaceId
authority.executionId          == context.executionId
authority.toolName             == intent.toolName
authority.toolVersion          == intent.toolVersion
authority.resourceSpaceIds     ⊇ resolved regions of this intent
authority.allowedCapabilities  ⊇ definition.capabilityMetadata
authority.controlBasisDigest   == context.controlBasisDigest
authority.expiresAt            >  now
authority.delegationDepth      <= configured ceiling
```

- The fact is a trusted Application-boundary input; it is not derived from model
  output and never from `argumentsJson`.
- `Delegation must not amplify authority` (SD §8.4): the capability ceiling
  cannot widen across delegation.

## 3. Capability-ceiling check

P4 checks the tool's required capabilities against the fact's allowed set and
against `ResourceBoundary` (SD §8.2). P4 does not compute the ceiling from
policy; it validates the fact against the resolved tool/resource scope.

## 4. Exact-Intent Approval (G2)

```ts
interface InvocationApproval {
  readonly approvalId: string;
  readonly routeKind: "Executable";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly principal: Principal;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: LogicalActionId;
  readonly callRef: string;
  readonly toolInvocationId: ToolInvocationId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly sideEffectSemantics: SideEffectSemantics;
  readonly argumentsJson: string;
  readonly actionDigest: string;          // normalized action + params digest
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
  readonly state: "Pending" | "Approved" | "Rejected" | "Consumed" | "Expired" | "Cancelled";
  readonly revision: number;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: Principal | null;
  readonly decisionReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledBy: Principal | null;
  readonly cancellationReason: string | null;
  readonly consumedAt: string | null;
  readonly consumedBy: ToolInvocationId | null;
}
```

The immutable binding and lookup key are distinct from the row's mutable
lifecycle fields:

```ts
type ExecutableApprovalKey = Pick<InvocationApproval,
  "projectId" | "executionId" | "logicalStepNo" | "repairAttempt" |
  "actionIndex" | "logicalActionId" | "callRef" | "toolInvocationId">;

type ExecutableApprovalBinding = Pick<InvocationApproval,
  "routeKind" | "projectId" | "workspaceId" | "executionId" |
  "principal" | "logicalStepNo" | "repairAttempt" | "actionIndex" |
  "logicalActionId" | "callRef" | "toolInvocationId" | "toolName" |
  "toolVersion" | "sideEffectSemantics" | "argumentsJson" | "actionDigest" |
  "targetResourceSpaceIds" | "controlBasisDigest">;
```

`approvalId` is Runtime-generated from the exact action key. `expiresAt` is
first-commit TTL metadata; state, revision, human-decision fields,
cancellation provenance and consumption fields are lifecycle data and are not
part of the immutable binding.

- An approval is valid only if tool/version, `actionDigest`, target resources,
  `controlBasisDigest`, route, project/workspace/execution, subject, Step,
  LogicalActionId, callRef and `ToolInvocationId` all match the actual
  invocation and it is unexpired. `expiresAt`, revision, state and decision
  provenance are mutable lifecycle facts, not action-binding fields.
- The P4 `ApprovalRequired` handoff is returned for a new call with no record
  or the exact still-Pending request. It is nonterminal: P4 persists no
  ToolInvocation intent/settlement and does not write a new
  `Denied(ApprovalRequired)`. The Application composes P3 identity, P12
  approval fact, ActionApproval storage, P6 Inbox admission and the durable
  pause/wake facts.
- A resumed call carries Runtime-sourced `approvalId` and the exact Approved
  row revision. P4 accepts only `routeKind='Executable'`, `state='Approved'`,
  and that revision before matching the full immutable binding.
- Matching occurs before Resource Admission. After all pre-effect checks pass,
  an approval-required call persists its exact `ToolInvocation` intent and sets
  `consumedBy` to its `ToolInvocationId` in the **same fenced claim
  transaction**. The Worker fence and `stop_requested_at IS NULL` predicate
  are checked in that transaction. Intent and approval consumption either both
  commit or neither does.
- Approval consumption is not in the later terminal ToolInvocation settlement
  transaction. No database transaction spans the external effect. Once
  consumed, the approval is permanently bound to that invocation and is never
  released, refunded or transferred, including after interruption, revocation
  or an unknown effect result.
- Re-entry requires the same exact Execution, ToolInvocation and immutable
  intent. It re-resolves current authority, resources and ControlBasis before
  any further effect. An approval is consent to an exact action, not a
  PermissionGrant and never bypasses a changed or revoked authority basis.
- A binding mismatch, changed ControlBasis/resource set or expiry cannot update
  an existing request. The same invocation receives its typed no-effect
  denial/expiry result; if policy allows another attempt, it requires a new
  LogicalAction/ToolInvocation identity and a new approval request.
- A different candidate `expiresAt` during a first-issuer unique-key race is
  not a binding mismatch. The loser reads and uses the committed winner's
  ApprovalId, expiry and revision. `expiresAt` is fixed at first commit and is
  never extended on retry.
- Producing an approval is the deferred resolver's job; P4 owns the record and
  the atomic single-consumption semantics.

Denial and approval reuse:

- Before consumption, authority/approval/resource denial is persisted as a
  terminal no-effect `Denied` invocation record with
  `effect_admission_state = NotAdmitted`; the approval remains unconsumed. For
  EA-DG-01 proven Executable rows, the approval is already bound to the exact
  LogicalAction/ToolInvocationId and cannot transfer to a different
  invocation. Restored permission or a changed intent requires a new action,
  invocation and approval. Unbound pre-0038 rows remain `binding_proven=0` and
  fail closed. The same terminal denied invocation cannot later execute.
- If a claim's approval compare-and-set loses to another invocation, the
  transaction rolls back its intent insert. The losing invocation receives
  terminal `Denied(ApprovalConsumedByOtherInvocation)` and cannot execute.
- If the same invocation already consumed approval but current authority is
  denied while its effect state is `NotAdmitted`, P4 writes terminal
  `Denied(ApprovalNoLongerAuthorized)` under the current Worker fence. The
  approval remains consumed. The ToolResult is `Denied`; AgentLoop marks that
  action `TerminalRejected` and advances its cursor once without failing the
  whole Execution. A repeated call replays this Denied result. Restored
  permission requires a new action/invocation and new approval.
- P4 `Denied` reason codes are the closed `NoEffectDenialCode` set in `01`;
  stop/quiescence is instead `ExecutionStopping` or the existing `Interrupted`
  settlement and never a Denied code.
- `ApprovalRequired` is not in the new-write denial set. Historical persisted
  `Denied(ApprovalRequired)` remains a terminal decoder/replay case only.

### Control ActionApproval consumption for AssignWork (DID v1.33)

For the AssignWork Control route, the P4-owned `ControlApprovalStore` exposes
`consumeApproved(approvalId, consumedBy: CommandId)` within
the caller's existing `TransactionScope`. It succeeds only for the exact
Approved ActionApproval revision already validated against project,
workspace, execution, stable action, action digest, target, ControlBasis, and
expiry by the Command Gateway. Its SQL changes state to `Consumed`, increments
the approval revision exactly once, and sets `consumed_by` to that same
generation's Committed CommandId in the transaction that commits the canonical
AssignWork Work, event, receipt, and target binding.

The Command Gateway owns this call for direct-child AssignWork. Do not consume
after Gateway commit through a standalone ControlActionAuthorizer operation.
A pre-handler FencingRejected or ExecutionStopping result does not consume the
approval. Receipt replay verifies the immutable approval evidence and the
original `consumed_by` CommandId/revision, without re-authorizing or consuming
again. This is a route-specific atomicity contract; it does not widen
PermissionGrant, ActionApproval, or ResourceBoundary authority. See DID §6A.16
and System Design §4.11.

FT-DG-03 validation follows DID §4.1B and the owning P1/P12 command contracts.
The External codec cannot construct or accept the process-local
`AssignWorkCommandEvidence` or `AssignWorkControlAuthorizationEvidence` used by
the direct-child Control route. It does not alter the existing exact
CommandId-bound approval consumption, replay evidence, or transaction boundary.

## 5. Rejection projection

- Actual authority/permission/approval rejection → `Denied` observation (`02`
  §3), persisted as a terminal no-effect invocation settlement using the new
  closed `NoEffectDenialCode` union (`01` §4–§5, `06` §1/§3). It is valid only
  when `effect_admission_state = NotAdmitted`; `Denied` never asserts that an
  external effect occurred.
- A new approval-required Executable call with no Approved exact row returns
  the nonterminal `ApprovalRequired` handoff (`02` §2); it creates neither a
  terminal Denied row nor an Executable effect intent. Human Reject/TTL Expire
  later produce `ApprovalRejected`/`ApprovalExpired` for the same
  ToolInvocationId. Historical `Denied(ApprovalRequired)` is accepted only by
  the persisted settlement decoder and exact terminal replay.
- A pre-consumption denial leaves approval unconsumed. A post-consumption
  revocation remains bound to the same invocation and replays its stored Denied
  result; it does not release approval for another invocation.
- `ExecutionStopping` and P4 `Interrupted` are separate stop/quiescence results,
  not permission-denial projections.

## 6. Must Not Decide

- No PermissionGrant lookup / Parent-User resolution / RBAC-ABAC-ACL.
- No policy/ceiling computation from governance facts.
- No escalation routing decisions (a later governance phase).
## Workspace capability distribution (governance 2026-10-01)

- `list` / `read` (`fs:read`) are baseline capabilities inside an active
  Workspace's current ResourceBoundary.
- `patch`, `shell`, Project tools and external tools require elevated
  capabilities explicitly distributed by the parent Workspace; a child
  ceiling is always a subset of its parent's current ceiling.
- Root elevated capabilities originate from Project creator/Project Policy.
- ExecutionBound specialists can only receive an explicit subset of their
  parent Execution ceiling.
- Tool Runtime resolves exact regions before authority resolution. The
  resulting InvocationAuthority binds principal, Workspace, Execution, tool
  version, capabilities, resource spaces, ControlBasis digest, TTL and
  delegation depth.
- Authority denial is a normal Tool observation, never a defect or canonical
  mutation.
