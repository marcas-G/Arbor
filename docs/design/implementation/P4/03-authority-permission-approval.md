# P4 — 03 Authority / Permission / Approval

**Authority:** DID v1.8 §7.6/§6A.7, G1/G2; SD v1.3 §8.1–§8.5.
**Status:** DRAFT (first draft for contract review).

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
  readonly toolName: string;
  readonly toolVersion: string;
  readonly actionDigest: string;          // normalized action + params digest
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
  readonly consumedBy: ToolInvocationId | null;
}
```

- An approval is valid only if tool/version, `actionDigest`, target resources,
  `controlBasisDigest` all match the actual invocation and it is unexpired.
- It is consumed **atomically by exactly one matching invocation**
  (`consumedBy` set in the same transaction as the invocation settlement).
- A mismatch / changed control revision / expiry forces re-approval.
- Producing an approval is the deferred resolver's job; P4 owns the record and
  the atomic consumption semantics.

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

- All authority/permission/approval failures → `Denied` observation (`02` §3),
  persisted as a settled invocation.

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
