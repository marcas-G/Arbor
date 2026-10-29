# P12 — 02 Authority Resolver Production Plane (G2)

> **DID v1.30 CAPA supersession (2026-10-03).** The original §5 conclusion
> that PermissionGrant could not gain a subject is superseded. PermissionGrant
> v2 is subject/capability/target/time-bound; unbound legacy rows are revoked by
> migration 0029. Control Actions use `Authorized | Denied |
> ApprovalRequired`; migration 0030 adds exact durable control approvals.
> Approval pauses before handler execution and resumes the same
> Execution/AgentLoopStep after human resolution. Sandbox and executable-tool
> approval remain separate boundaries.

> **DID v1.39 EA-DG-01 successor (2026-10-11).** P12 `resolveApproval` also
> binds Runtime-owned Executable Step/LogicalAction/callRef/ToolInvocation
> identity and a stable ApprovalId; the Application reads the request store
> before invoking the pure resolver and preserves the first committed TTL.
> `ResolveExecutableApproval` receives its own authenticated-human decision
> authority fact. Resolver remains `R = never`: it does not persist, read
> approval rows, decide, consume or wake them.

**Authority:** DID v1.14 G2, v1.13 G4, v1.8 G2 and v1.39 EA-DG-01; §4.1 (CommandSubmissionContext), §4.1A, §4.2, §4.3, §6.2 (L2), §12.3, §12.10; SD v1.14 §8.1–§8.5; P1 `01` §2A/§4/§9, P2 `01` §2 + `00` R1, P4 `03` §2/§4, P5 `01` §3.1; P1-DG-11.
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox authority addendum accepted under `ACCEPT_NATIVE_OS_SANDBOX_COMMAND_AUTHORITY_AMENDMENT_V3`.

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

/** Stable action identity assigned by Runtime, never accepted from model output. */
type ExecutableApprovalIdentity = {
  logicalStepNo: number
  repairAttempt: number
  actionIndex: number
  logicalActionId: LogicalActionId
  callRef: string
  toolInvocationId: ToolInvocationId
}

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
  projectId: ProjectId
  workspaceId: WorkspaceId
  executionId: ExecutionId
  intent: {
    toolName: string
    toolVersion: string
    argumentsJson: string
    actionDigest: string                             // normalized action + params digest
    sideEffectSemantics: SideEffectSemantics
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

type InvocationApprovalDecisionInput = InvocationDecisionInput & {
  approvalIdentity: ExecutableApprovalIdentity
}
```

For External command resolution, `envelope` is already a typed semantic
envelope produced by the registered strict wire-v1 codec; the resolver never
receives raw JSON or caller-supplied wire-version data. Before `resolve`, the
Application binds `envelope.actor` to the authenticated `principal` by exact
string equality and supplies the derived Handler schema and P1 semantic
fingerprint. Resolver visibility is evaluated for that exact principal,
External origin, project, target, current canonical facts, active Grants, and
policy before the Command Gateway can reveal any receipt or conflict. The
Resolver itself does not read receipts or mutate state. The Gateway's
in-transaction exact receipt replay and final authority/precondition checks
remain authoritative (DID §4.1B; P1 `01` §3; `03` §3.1).

P8 v1.46 adds one declared `canonicalFacts.retryVerificationOrigin` input for
the permanent non-receipt origin fact. Application/Composition loads this
immutable origin by candidate CommandId through the P8 origin store after
strict codec and Actor/Principal binding; it never reads CommandStore or a
receipt. The Resolver remains pure (`R = never`) and consumes only that
declared snapshot. The origin contains CommandId, ProjectId, original actor,
source Verification/Work, successor Verification/verifier Execution and
createdAt; it contains no fingerprint/schema/algorithm, summary, revision,
payload, or receipt data.
An absent origin is no replay authority. A malformed, duplicate, contradictory,
or unreadable stored origin is not treated as absence: Composition returns
typed `PersistenceCorruption<"RetryVerificationOriginStore">`, which the
external boundary maps to the fixed safe non-retryable corruption Problem
before Gateway. No row contents or receipt data are exposed.

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
    input: InvocationApprovalDecisionInput,
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
      readonly commandType: string }
  | { readonly _tag: "ExecutableApprovalNotFound" };

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

For `ResolveExecutableApproval`, the `resolve` entry point may produce the P1
command-specific `ExecutableApprovalDecisionAuthority`. It binds the
authenticated human, CommandId/fingerprint, project, exact Executable
ApprovalId, workspace, active Execution and expected approval revision. The
decision resolver applies the configured human/parent policy; a `user:`
principal string alone grants no decision authority. Missing and foreign
approval targets produce the same safe not-found failure before Gateway
receipt access. For a visible authorized target, P12 binds the supplied
expected revision but does not turn a stale revision into not-found; P1's
Gateway CAS returns the existing typed RevisionConflict. P12 returns the fact
only; P1/Gateway and P4/P6 own the transaction that decides, consumes the
Inbox entry and writes the event.

- `R = never` is the **proof of no I/O / no side effect**: every read is of the declared inputs (`AuthorityDecisionInput` / `InvocationDecisionInput` / `InvocationApprovalDecisionInput`); the resolver holds no ambient capability.
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
RetryVerificationReplayOnlyAuthority
                                P8 `01` §3A: only permanent origin plus current
                                Resolver authorization; Gateway consumes it
                                only through an existing receipt tuple branch
InvocationAuthority             P4 `03` §2: tool capability ceiling + resource spaces
                                (produced by resolveInvocation, NOT resolve — N-03)
InvocationApproval              P4 `03` §4: Exact-Intent approval
                                (produced by resolveApproval, NEVER consumed here)
```

Command outputs are **exact-bound** to `principal`, `commandId`,
`semanticRequestFingerprint`, `projectId`, target, and submission origin where applicable;
invocation outputs are **exact-bound** to `principal`, `workspaceId`, `executionId`, tool
identity, `resolvedRegions`, and `controlBasisDigest` (plus `actionDigest` and
Runtime-owned Step/LogicalAction/callRef/ToolInvocation identity for approvals).
The Application performs deterministic exact-match only (P1 §2A) — it does not re-decide
authority.

**Approval production — recorded G2 clarification (NEW-12; DID v1.8 G2 / P4 `03` §4;
DF-04/RG-03).** DID v1.14 G2 enumerates three produced fact families —
`VerifiedCommandAuthority` / `VerifiedRuntimeCommandAuthority` / `InvocationAuthority` —
and does not name `InvocationApproval`. Producing Exact-Intent approvals is nonetheless the
deferred resolver's job (P4 `03` §4: "Producing an approval is the deferred resolver's
job"), and that resolver is P12. P12 therefore records `InvocationApproval` production as a
**G2 clarification** (a fourth output family, not a new authority plane): §2A
`resolveApproval` **produces** the Pending fact bound to the exact normalized
intent and Runtime-owned ExecutableApprovalIdentity. The deterministic
ApprovalId derives from that stable identity, not from `now` or `expiresAt`.
The resolver computes candidate first-commit `expiresAt` from policy/`now`
only when the Application has established that no logical-action row exists;
the Application looks up first and does not call the resolver to refresh an
existing row. On a unique-key race, storage compares only immutable binding
fields and returns the winner's ApprovalId, original expiry and current
revision even when the losing resolver used a different `now`. P12 holds no
repository, so it does not persist, look up or consume approvals. Atomic
single-consumption stays P4 (P4 `03` §4).

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
- Under FT-DG-03, their registered closed descriptors follow the exact P12
  command contracts: GrantPermission's grant ID, scope, issuer, lifetime, and
  state rules; RevokePermission's PermissionGrantId and target binding. The
  descriptor validates data only; P12 still resolves the authenticated
  principal and current authority, and the Gateway remains the sole writer.
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

### P8 `RetryVerification` human authority

For the accepted P8 orphan governance command, the resolver may produce
`OrphanConclusionAuthority` only from the authenticated local-human context
and exact current canonical facts. Root Work is governed by the authenticated
local human; child Work is governed only by the authenticated human of the
exact direct Parent Workspace. The authority binds Project, Work, current
Work revision, exact Open Verification, the complete exact bound verifier
Execution set and the Work's current governance owner. The P8 handler
independently revalidates these facts in the canonical transaction, including
old verifier ownership against the Verification's captured owner snapshot.
Agent grants, verifier Execution authority, RecoveryController, scheduler,
Attention and arbitrary External command origin cannot construct this fact.

For a historical source after a successful RetryVerification, the Resolver may
produce `RetryVerificationReplayOnlyAuthority` only when the declared permanent
origin fact matches the candidate CommandId, ProjectId, original actor, source
Work and source Verification; the authenticated principal still equals the
original actor and currently has the exact Root-local or direct-Parent human
governance authority for that source. A different source/project/actor,
missing origin, Agent, revoked authority or changed owner that no longer
authorizes the original actor yields no fact and the generic denial before
Gateway. Current visibility is re-evaluated on every replay; origin does not
preserve authority after revocation or owner change.

For the paired P6 `UnboundLegacy` Governance Inbox entry, current recipient
visibility is derived from the disposition's Project/Work IDs and current
canonical Work/Workspace governance owner, then checked against the same
current Root-local or exact direct-Parent human route. A stored
`inbox_entries.workspace_id` is a projection target, not an authority fact;
stale recipient rows cannot make a former owner visible or authorized. The
Inbox read does not inspect/decode Command receipts and never grants
`RetryVerificationReplayOnlyAuthority`; an UnboundLegacy external replay
continues to generic-deny before Gateway.

Origin matching does not compare expected revision, summary, successor
Verification/Execution IDs, semantic fingerprint, Handler schema version, or
fingerprint algorithm. The produced authority remains exact-bound to the
current candidate's commandId/project/fingerprint under P1 `02A`; it does not
compare those tuple values with the origin row. For the same CommandId and
source scope, those candidate fields reach Gateway's existing complete tuple
comparison, which remains the
only receipt read and returns the existing `IdempotencyConflict` branch before
decoding either JSON field. The `RetryVerification` handler accepts only
`RetryVerificationAuthority`; it never accepts replay-only authority. If an
origin exists but Gateway finds no corresponding receipt, P1 returns the
fixed safe `PersistenceCorruption<"CommandStore">` disposition without
handler invocation or writes. An unbound legacy disposition has no replay
authority and is generic-denied; its human-only P6 Inbox item is not an Agent
instruction or an Attention source.

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

## Accepted Native OS Sandbox authority amendment V3

Add only `SandboxPolicyDecisionAuthority` for authenticated human
`DecideSandboxPolicy`. The exact CAPA v2 `PermissionGrant` must bind the same
HumanPrincipal decision subject, capability exactly `DecideSandboxPolicy`,
and one canonical `ExecutionId`; Project/Workspace/Episode come from and are
checked against the canonical Execution relation. Lifetime is finite,
Execution-bound and checked using trusted `AuthorityNow`; Resolver never
uses `envelope.issuedAt`.

The issuer must be an authenticated HumanPrincipal in P5's current
OS-protected operator snapshot and must differ from the decision subject.
That allowlist authorizes only this exact GrantPermission capability and
target, never a generalized admin/RBAC permission. `GrantPermissionAuthority`
for this scope binds the snapshot revision/digest. The immutable
`SandboxPolicyGrantIssuerProvenanceV1` records exact GrantId, originating
Committed GrantPermission CommandId, issuer, config revision and digest.

Composition loads the exact Grant via the existing transactional
`PermissionGrantRepository.findById(permissionGrantId)` and exact provenance
lookup, together with the canonical Execution facts and trusted clock. P12/02
remains a pure `R = never` resolver: it reads no repository, receipt or
decision store. It produces authority only if Grant, provenance, committed
originating command and current operator snapshot match exactly. Removed or
re-added operators cannot revive old Grants; a new Grant is required. P1
Gateway performs its independent same-transaction exact recheck. No other
P12 command scope or P12/10 authorization path is added.


## Accepted full-chain Native Sandbox exact authority projection (V21)

P12/02 remains the only CAPA-v2 resolver. For GrantPermission to create
sandbox issuer provenance, authenticated actor and configured issuer are the
same currently listed canonical HumanPrincipal; capability is exactly
DecideSandboxPolicy; target is exactly one ExecutionId; subject is a distinct
HumanPrincipal and exactly the later decision actor; lifetime is finite and
checked with trusted AuthorityNow (validFrom <= now < expiresAt). Preserve
exact subject/scope/capability/target/revision/state/issuer projection without
P1 parsing or widening. Committed Grant, provenance, receipt and existing
PermissionChanged plus SandboxPolicyGrantIssued ordering remain atomic per P1.

SandboxPolicyDecisionAuthority binds authenticated actor, exact Grant ID,
issuer provenance and current immutable authority/operator bundle revision and
digest, exact canonical Execution/Episode and human-selected policy CAS
preconditions. Resolver preflight precedes any receipt disclosure; P1 performs
an independent exact same-transaction Grant/provenance/current-bundle recheck.
Removed or re-added issuer cannot revive an old grant; a new exact grant is
required. Cross-Execution, wildcard, expired/revoked, nonhuman, same-issuer/
subject or malformed decisions fail closed through existing terminal
rejections with sanitized details. Authority/config failures are not
provider-unavailable facts and never trigger FullAccess fallback.

P12 consumes P5's one OS-protected SandboxAuthorityBundleV1 snapshot only
through explicit injected ports; P12/02 does not read files, SQLite, receipt
or decision stores. P1 command fields never accept caller-supplied authority,
issuer, high-water, registry or evidence internals. P12/02 adds no resolver
route, permission, capability or broader admin/RBAC semantics.
