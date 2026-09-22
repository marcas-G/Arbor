# P12 — 02 Authority Resolver Production Plane (G2)

**Authority:** DID v1.14 G2, v1.13 G4, v1.8 G2; §4.1 (CommandSubmissionContext), §4.1A, §4.2, §4.3, §6.2 (L2), §12.3, §12.10; SD v1.3 §8.1–§8.5; P1 `01` §2A/§4/§9, P2 `01` §2 + `00` R1, P4 `03` §2/§4, P5 `01` §3.1; P1-DG-11.
**Status:** DRAFT.

## 1. Boundary (frozen)

The Authority Resolver is a **pure / deterministic authority-decision boundary**.

```text
inputs (facts)  →  Authority Resolver  →  output: exact-bound trusted authority facts
```

- It **produces facts only**. It is side-effect free with respect to canonical state.
- It **MUST NOT**:
  - invoke `CommandGateway`;
  - mutate canonical state (no repository writes, no event append);
  - consume `InvocationApproval`;
  - execute tools.
- Canonical mutation remains **only** through `CommandGateway` (DID §10.4).

## 2. Inputs

```ts
/** The principal proven at the transport/composition boundary (DID §4.1);
 * never model-supplied. Distinct name from the domain `Principal` only to mark
 * provenance. */
type AuthenticatedPrincipal = Principal

AuthorityDecisionInput = {
  principal: AuthenticatedPrincipal      // authenticated, not model-supplied
  submissionContext: CommandSubmissionContext   // External | ExecutionOrigin | System
  envelope: CommandEnvelope              // commandType/commandId/projectId/actor/payload
  semanticRequestFingerprint: SemanticRequestFingerprint  // computed by the Application (P1 `01` §4)
  canonicalFacts: CanonicalAuthorityFacts        // project/workspace/work/execution state snapshot
  grants: ReadonlyArray<PermissionGrant>         // active grants (PermissionGrant store, §5.1)
  governance: ParentUserGovernanceFacts          // parent/child/user override facts
  policy: ProjectPolicy | WorkspacePolicy
}

/** P4 `03` §2/§4 invocation-scoped facts. `AuthorityDecisionInput` cannot
 * produce `InvocationAuthority` / `InvocationApproval` (N-03): those need the
 * resolved tool intent, the resolved regions, `controlBasisDigest`,
 * `expiresAt`, and `delegationDepth`, none of which a command envelope carries. */
InvocationDecisionInput = {
  principal: AuthenticatedPrincipal
  workspaceId: WorkspaceId
  executionId: ExecutionId
  intent: {
    toolName: string
    toolVersion: string
    argumentsJson: string
    actionDigest: string                             // normalized action + params digest
    requestedCapabilities: ReadonlyArray<string>
    resolvedRegions: ReadonlyArray<string>           // resourceSpaceIds resolved for this intent
  }
  controlBasisDigest: string
  grants: ReadonlyArray<PermissionGrant>             // active grants (PermissionGrant store, §5.1)
  governance: ParentUserGovernanceFacts
  policy: ProjectPolicy | WorkspacePolicy
  delegationDepth: number
  now: string                                        // evaluation instant for expiresAt
}
```

`semanticRequestFingerprint` is **computed by the Application** (P1 `01` §4); the resolver never computes or re-derives it. `canonicalFacts` / `grants` are **declared input snapshots**, not live I/O ports.

## 2A. Resolver port (entry point, E-05)

The resolver is declared in `packages/application` (it returns application-owned
`VerifiedCommandAuthority` / `VerifiedRuntimeCommandAuthority`; declaring it in `ports`
would create a forbidden `ports → application` edge, DID §10.4.1).

```ts
interface AuthorityResolverPortService {
  /** Command / runtime authority facts (envelope-scoped). */
  resolve(
    input: AuthorityDecisionInput,
  ): Effect.Effect<CommandAuthorityFact, AuthorityResolutionError, never>

  /** P4 `03` §2 production plane: the tool-invocation authority fact. */
  resolveInvocation(
    input: InvocationDecisionInput,
  ): Effect.Effect<InvocationAuthority, InvocationResolutionError, never>

  /** P4 `03` §4 production plane: the Exact-Intent approval record
   * (produced here, NEVER consumed — §3). */
  resolveApproval(
    input: InvocationDecisionInput,
  ): Effect.Effect<InvocationApproval, InvocationResolutionError, never>
}

type AuthorityResolutionError =
  | { readonly _tag: "NoApplicableGrant";
      readonly principal: AuthenticatedPrincipal;
      readonly commandType: string;
      readonly commandId: CommandId }
  | { readonly _tag: "GrantScopeInsufficient";
      readonly principal: AuthenticatedPrincipal;
      readonly commandType: string;
      readonly requiredScope: string }
  | { readonly _tag: "GovernanceOverrideDenied";
      readonly principal: AuthenticatedPrincipal;
      readonly targetWorkspaceId: WorkspaceId }
  | { readonly _tag: "ApprovalIntentMismatch";
      readonly expected: string;
      readonly actual: string }
  | { readonly _tag: "UnsupportedOrigin";
      readonly submissionOrigin: string;
      readonly commandType: string };

type InvocationResolutionError =
  | { readonly _tag: "NoApplicableGrant";
      readonly principal: AuthenticatedPrincipal;
      readonly toolName: string }
  | { readonly _tag: "GrantScopeInsufficient";
      readonly principal: AuthenticatedPrincipal;
      readonly requiredScope: string }
  | { readonly _tag: "CapabilityCeilingExceeded";
      readonly requested: ReadonlyArray<string>;
      readonly allowed: ReadonlyArray<string> }
  | { readonly _tag: "DelegationCeilingExceeded";
      readonly delegationDepth: number;
      readonly ceiling: number }
  | { readonly _tag: "GovernanceOverrideDenied";
      readonly principal: AuthenticatedPrincipal;
      readonly targetWorkspaceId: WorkspaceId }
  | { readonly _tag: "ApprovalIntentMismatch";
      readonly expected: string;
      readonly actual: string };
```

- `R = never` is the **proof of no I/O / no side effect**: every read is of the declared inputs (`AuthorityDecisionInput` / `InvocationDecisionInput`); the resolver holds no ambient capability.
- An **unauthorized / unresolvable** resolution yields **no fact** — the entry point fails with a typed error; the Application surfaces `DomainError.AuthorityDenied` (never a silent default-allow).
- The command entry point (`resolve`) and the invocation entry points (`resolveInvocation` / `resolveApproval`) are distinct because their inputs are distinct (N-03); one entry point cannot produce both families from a single input shape.

## 3. Output (exact-bound trusted facts)

```ts
type CommandAuthorityFact =
  | VerifiedCommandAuthority
  | VerifiedRuntimeCommandAuthority;

type AuthorityFact =
  | CommandAuthorityFact
  | InvocationAuthority
  | InvocationApproval;
```

```text
VerifiedCommandAuthority        P1 `01` §2A governance variants
                                (CreateProject/CreateChildWorkspace/AssignWork/...);
                                RegisterProjectToolAuthority is P12 `01` §5.1
                                (produced here; `01` declares only its shape);
                                SelectCurrentWorkAuthority is P5 `01` §3.1
VerifiedRuntimeCommandAuthority resolver-producible variants ONLY:
                                external-origin AdmitExecutionAuthority /
                                StopExecutionAuthority (submissionOrigin "External");
                                SettleExecutionAuthority is NOT produced here
                                (origin ExecutionOrigin | RecoveryController)
InvocationAuthority             P4 `03` §2: tool capability ceiling + resource spaces
                                (produced by resolveInvocation, NOT resolve — N-03)
InvocationApproval              P4 `03` §4: Exact-Intent approval
                                (produced by resolveApproval, NEVER consumed here)
```

Command outputs are **exact-bound** to `principal`, `commandId`,
`semanticRequestFingerprint`, `projectId`, target, and submission origin where applicable;
invocation outputs are **exact-bound** to `principal`, `workspaceId`, `executionId`, tool
identity, `resolvedRegions`, and `controlBasisDigest` (plus `actionDigest` for approvals).
The Application performs deterministic exact-match only (P1 §2A) — it does not re-decide
authority.

**Approval production — recorded G2 clarification (NEW-12; DID v1.8 G2 / P4 `03` §4;
DF-04/RG-03).** DID v1.14 G2 enumerates three produced fact families —
`VerifiedCommandAuthority` / `VerifiedRuntimeCommandAuthority` / `InvocationAuthority` —
and does not name `InvocationApproval`. Producing Exact-Intent approvals is nonetheless the
deferred resolver's job (P4 `03` §4: "Producing an approval is the deferred resolver's
job"), and that resolver is P12. P12 therefore records `InvocationApproval` production as a
**G2 clarification** (a fourth output family, not a new authority plane): §2A
`resolveApproval` **produces** the record bound to the exact normalized intent +
`expiresAt`. It **MUST NOT consume** the approval; atomic single-consumption stays P4
(P4 `03` §4).

## 4. External Stop / Admit resolution (v1.13 G4)

- P12 owns resolving **External Human/Parent Stop** (and external `AdmitExecution`) into
  `VerifiedRuntimeCommandAuthority` with `submissionOrigin: "External"`.
- **Inherited P2 `01` §2 correction (DF-02/RG-05).** P2 `00` R1 restricted
  `AdmitExecutionAuthority` / `StopExecutionAuthority` to runtime origins and deferred the
  External (human/parent) path to the Authority Resolver phase. DID §4.1 already lists
  `External` in those unions. Producing `submissionOrigin: "External"` therefore **widens**
  the frozen P2 `VerifiedRuntimeCommandAuthority` unions (add `"External"` to
  `AdmitExecutionAuthority` and `StopExecutionAuthority`). This is an explicit inherited
  P2 `01` §2 correction (P2 `00` R1 + DID §4.1) — **not** "no P2 change". P2 runtime
  semantics are otherwise unchanged.
- P2 consumes/validates the trusted fact; P2 runtime semantics are unchanged.
- P10 only exposes the stop request / control surface; P10 does not resolve.

## 5. PermissionGrant store (P12 contract)

Frozen P0 domain type (`packages/domain/src/authority.ts`) — **unchanged**:

```ts
PermissionGrant { permissionGrantId; scope: string; issuer: Principal;
                  lifetime: string; state: Active | Revoked }
```

- **Choice (b) recorded (RG-04):** the resolver **derives** `subject` / `capability` from
  grants + project/workspace policy + parent/user governance facts; it does **not** mutate
  the frozen P0 `PermissionGrant` type (no added `subject`/`capability` fields, no narrowed
  `scope` union). No governance basis cites a P0/`permission_grants` type evolution, so (a)
  is not taken.
- `GrantPermission` / `RevokePermission` are governance Commands producing
  `PermissionChanged`; the resolver reads active grants.
- Temporary grants default **non-delegable** (no privilege amplification, SD §8.4).
- Approval of one intent must not authorize a different intent (Exact-Intent, P4).

### 5.1 Store surface + durability (R-08)

The resolver reads grants from a **declared input snapshot**; the Composition Root (never
the resolver — `R = never`) loads that snapshot through a `PermissionGrantRepository` port:

```ts
interface PermissionGrantRepositoryService {
  /** Active grants only (`state = 'Active'`); a Revoked grant is never loaded. */
  readonly activeGrants: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<PermissionGrant>,
    PermissionGrantRepositoryError,
    TransactionScope
  >
  readonly put: (
    grant: PermissionGrant,
    projectId: ProjectId,
  ) => Effect.Effect<void, PermissionGrantRepositoryError, TransactionScope>
  readonly revoke: (
    permissionGrantId: PermissionGrantId,
  ) => Effect.Effect<void, PermissionGrantRepositoryError, TransactionScope>
}

type PermissionGrantRepositoryError =
  | { readonly _tag: "PermissionGrantNotFound";
      readonly permissionGrantId: PermissionGrantId }
  | { readonly _tag: "PermissionGrantRepositoryFailure";
      readonly cause: unknown };
```

- **CI-1 caller restriction (M5):** `put` / `revoke` are durable canonical writes; they are
  invocable **only** by the `GrantPermission` / `RevokePermission` handlers inside the
  `CommandGateway` transaction. No other caller (resolver, composition root, adapter) may
  invoke them. The resolver only *reads* via `activeGrants` and has `R = never`.
- **Catalog reconciliation (M4):** the port uses the frozen DID §7.2 catalog name
  `PermissionGrantRepository` (C9 ownership row); it is not a new catalog surface.

Durable surface (DID §9.3 table name `permission_grants`; DID §9.4 relational rule — an
authority relation is relationalized). P12 migration `0012_permission_grants`
(forward-only; sets `user_version = 12`; P12 final baseline `13`), following `06`'s
`0011_lease_worker_incarnation`:

```sql
CREATE TABLE permission_grants (
  permission_grant_id TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  scope               TEXT NOT NULL,
  issuer              TEXT NOT NULL,
  lifetime            TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('Active','Revoked'))
);
CREATE INDEX permission_grants_active ON permission_grants (project_id, state);
```

- The frozen P0 `PermissionGrant` type is unchanged (no added `subject`/`capability`
  fields, §5); `project_id` is the relational scope key, not a new domain field.
- **Load assertion:** the Composition Root loads
  `PermissionGrantRepository.activeGrants(projectId)` into `AuthorityDecisionInput.grants`; the
  resolver therefore sees only `Active` grants.
- **Revoked → no fact assertion:** a revoked grant is absent from the loaded snapshot, so
  the resolver has no matching grant and the entry point fails with `NoApplicableGrant`
  (no fact produced; Application surfaces `DomainError.AuthorityDenied`) — never a silent
  default-allow.

## 6. Determinism / purity / replay

- The resolver is a deterministic function of its **declared inputs**: same
  `(principal, submissionContext, envelope, semanticRequestFingerprint, canonicalFacts,
  grants, governance, policy)` → same command fact; same `InvocationDecisionInput` → same
  `InvocationAuthority` / `InvocationApproval`.
- **Reads are of declared inputs only.** `canonicalFacts` / `grants` are snapshots supplied
  in `AuthorityDecisionInput` / `InvocationDecisionInput`; the resolver performs no
  live/ambient I/O, and `R = never` (P1 §2A) is the proof. The decision is a pure function
  of those inputs.
- **Fingerprint ownership boundary (P1 `01` §4).** The Application computes
  `semanticRequestFingerprint`; the resolver treats it as opaque and only exact-binds its
  output to it. A change in authorization state must not change the fingerprint (P1 `01` §2A).
- **Read→commit TOCTOU.** A resolution is a pure function of a read snapshot and is **not**
  itself the authoritative authorization. The authoritative gate is the Application's
  in-transaction exact-match plus canonical preconditions (DID §12.3; P1 `01` §3 step c):
  an out-of-transaction pre-check never constitutes final authorization. Exact-binding to
  `(principal, commandType, commandId, fingerprint)` plus typed approval `expiresAt` ensures
  a stale resolution can never authorize a **different** intent; a resolution invalidated by
  a canonical-state change before commit does not by itself authorize the mutation, and the
  Application's in-transaction authority/precondition check rejects with
  `DomainError.AuthorityDenied`. A resolver must not cache or re-use a resolution across a
  canonical-state change.
- It must not consult model output, prompts, or the `CommandEnvelope.payload` for trust.

## 7. Must Not Decide

- No canonical mutation; no approval consumption; no tool execution.
- No change to P1/P2/P4 exact-match rules or frozen rejection vocabulary.
- No implicit default-allow; no RBAC/ACL invention beyond the SD §8 model.
- No `PermissionGrant` type mutation (see §5); no `SettleExecution` / runtime-origin
  authority production (see §3/§4).

## 8. Verification

```text
resolver command output binds principal + commandId + fingerprint + projectId + target
RegisterProjectToolAuthority produced here (shape declared by `01` §5.1)
resolver invocation output binds principal + workspaceId + executionId + tool + regions
  + controlBasisDigest (+ actionDigest for approvals)
External Stop → submissionOrigin "External" trusted fact → P2 consumes
no path: resolver → CommandGateway / repository write / approval consume / tool invoke
behavioral authority assertion (E-06), same envelope payload:
  principal WITHOUT a matching grant             → no fact (AuthorityResolutionError)
  valid grant whose target/scope ≠ this intent   → no fact
  only the exact (principal, commandType, commandId, fingerprint) tuple → fact produced
unauthorized / missing grant → no fact produced → DomainError.AuthorityDenied at Application
PermissionGrant store: activeGrants loads only state = 'Active' into grants; a revoked
  grant is absent → no matching grant → NoApplicableGrant (no fact), never default-allow
```
