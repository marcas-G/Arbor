# P4 — 03 Authority / Permission / Approval

**Authority:** DID v1.8 §7.6/§6A.7, G1/G2; SD v1.3 §8.1–§8.5.
**Status:** DRAFT (first draft for contract review).

## 1. Boundary

P4 does **not** resolve PermissionGrant / Parent / User governance (G1). The
Authority Resolver stays deferred. P4 receives trusted facts and performs
deterministic exact-match plus capability-ceiling checks.

## 2. Trusted `InvocationAuthority` fact

```ts
interface InvocationAuthority {
  readonly principal: Principal;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly resourceSpaceIds: ReadonlyArray<string>;   // resolved regions
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
authority.controlBasisDigest   == digest(context.controlBasis)
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

## 5. Rejection projection

- All authority/permission/approval failures → `Denied` observation (`02` §3),
  persisted as a settled invocation.

## 6. Must Not Decide

- No PermissionGrant lookup / Parent-User resolution / RBAC-ABAC-ACL.
- No policy/ceiling computation from governance facts.
- No escalation routing decisions (a later governance phase).
