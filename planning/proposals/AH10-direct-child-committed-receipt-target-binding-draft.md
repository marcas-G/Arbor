# AH10 Direct-child AssignWork Committed Receipt Target Binding

Date: 2026-10-09
Status: **OPEN — fixed landing proposal for manual governance; not accepted,
not landed, and not implementation-authorized.**
Proposal base: `868c940e66c51fb43784b83d80d0c8c2b0188200`.

This proposal closes the exact-target evidence gap for recovery of a
direct-child `AssignWork` whose canonical Command committed but whose Agent
Action and Observation did not. It does not close other AH10 action/state
branches. The accepted MAC-P2 contracts, CAPA, P1 Command identity and P9
recovery rules remain in force.

## Governance package and ownership

The package to accept is this file at the SHA-256 recorded in the human
decision. The proposed landing changes exactly these owning contracts:

| Contract | Proposed landing | Owns |
|---|---|---|
| System Design v1.10 → v1.11 | Add one normative §4.11, “Opaque placement target evidence for AssignWork recovery”; §4.11 is the **only semantic owner** for target binding, lifecycle-at-commit, and recovery outcome. | Domain meaning and safety invariants. |
| DID v1.32 → v1.33 | Add §6A.16 and exact §5.3 event, §7.2 ports, §9.3/§9.9 table/transaction/migration contracts; amend the Command and P4 approval-consumption contracts for typed evidence/atomic consumption. | Executable types, transaction, storage, and migration contract. |
| P1 `07` | Amend the generic prior-`Committed` rule with the AssignWork exact-binding gate and legacy exception, cross-referencing SD §4.11/DID §6A.16. | Receipt-first exception only; no independent semantics. |
| P9 `07` | Add the failed-binding durable fact and recovery branch, cross-referencing SD §4.11/DID §6A.16. | Fact recording and recovery-order integration. |
| P10 `02` / `07` | Add the exact fact-source mapping, projection behavior, and acceptance story. | Severity, target, deduplication, bubbling, and read-model ownership. |

System Design §4.11 is the single normative semantic owner for the binding
and lifecycle rule. DID, P1 `07`, and P9 `07` point back to §4.11 and may not
define alternatives. P9 owns the durable failure fact; P10 `02` owns its
Attention projection. P10 `07` adds qualification only. No other System
Design clause is amended. MAC-P2 remains the source of direct-child
placement, exact target, opaque-reference, and stale/foreign/retired
rejection requirements; CAPA remains the source of exact Grant/ActionApproval
authority.

## Problem and evidence

P1 `07` §2 requires an earlier `Committed` receipt to converge the same
`LogicalActionId` without another Command. MAC-P2 requires an exact
`targetWorkspaceRef` and rejects stale, foreign, or retired placement
references. The existing contracts do not persist the mapping between the
opaque target accepted by the action and the canonical Workspace that received
the Work.

The isolated process reproduction is
`tests/functional/pending/ah10-direct-child-assign-work-committed-receipt-stale-ref.functional.test.ts`.
Gen0 commits a Command, Child Work, and `WorkAssigned`, then is killed before
Observation persistence. The Agent Action remains Pending. The AssignWork
effect changes the placement revision, so gen1 cannot resolve the pinned ref
as current and returns `action/target-unavailable`. It does not duplicate the
Work or repeat Provider inference. An early receipt bypass was withdrawn
because receipt WorkId, ProjectId, and “same direct child” cannot distinguish
the pinned child A from sibling B.

Evidence and prior disposition are recorded in
`planning/results/AH10-direct-child-assign-work-takeover.result.md` and
`planning/results/AH10-generation-command-takeover-gap.result.md`. Independent
round 1 reviewed the prior proposal hash
`66F24BED02B67F91ACF1842453D10C26CFCC578574529FCC67C68CC9BF09C0AF` and
returned REVISE with five Blockings plus an explicit retirement-lifecycle
question. No separate review file is present at this base; the complete
findings are retained here with disposition:

| Round 1 finding | Disposition in this fixed package |
|---|---|
| SD v1.10 / DID v1.32 already occupied by FT-DG-02 | Advance to SD v1.11 / DID v1.33. |
| Legacy Committed receipt needed an explicit P1 `07` exception | Add the exact AssignWork receipt-first binding gate and old-unbound outcome to P1 `07`; cross-reference from DID/P9. |
| Handler lacked typed ControlAction authority result; Grant and ActionApproval paths needed an exact transaction/replay binding; P12 `AuthorityDecisionInput` is not a substitute | Replace `authorityRef` for AssignWork with the typed Grant/ActionApproval union; pass it unchanged to Gateway, atomically verify/consume, persist and replay-validate. |
| Attention lacked a source/carrier, exact severity/target/dedup/bubbling and owning phase | Add P9 immutable fact + dedicated event, with P10 `02`/`07` owning Action Required mapping, Parent Workspace target, dedup and subtree projection. This is explicit proposed semantics pending acceptance. |
| Grant FK, parent-child relation, indexes, conflict behavior were deferred | Fix migration 0033 with explicit composite unique indexes/FKs, typed authority FKs/checks, uniqueness and conflict rules. |
| Retirement at commit versus replay was unresolved | Require Active at initial commit; allow proof-complete receipt convergence if the Workspace retires later. |

Independent round 2 reviewed hash
`0FEFB89E81EDE2A1ADD6A893ECC233576FB9B13EFFB733044EE19FF41CFDA25E` and
returned **REVISE / Blocking = 1**: the binding incorrectly equated the
placement root with `Project.rootWorkspaceId`, although the current
Execution's Workspace may itself be a non-root Parent. This revision removes
the redundant placement-root column and global-root FK; `parentWorkspaceId`
is the exact `resolveChildRef` root, and the target-to-parent composite FK
proves the same-project direct-child edge. The qualification matrix now has a
public non-root Parent→DirectChild positive case. The model-authored opaque ref
wording was also corrected to distinguish the selector from Runtime-resolved
canonical identity. No separate round 2 review file is present; its blocker
and disposition are recorded here for audit.

The isolated RED remains excluded from default gates until an accepted contract
authorizes implementation.

## Proposed normative semantics

1. **First resolution.** A new direct-child `AssignWork` may enter its
   canonical Command transaction only after Runtime has resolved the exact
   opaque `targetWorkspaceRef` from current PlacementContext and selected an
   exact CAPA `Authorized` evidence value produced by the ControlAction
   authorizer: either its exact PermissionGrant basis or exact approved
   ActionApproval basis. That typed value crosses the in-process
   ControlAction→AssignWork Command boundary; it is never model-authored,
   serialized into Provider output, or reconstructed from a string
   `authorityRef`. In that same transaction, the Command Gateway verifies
   this same typed basis against current durable authority rows and rechecks
   the placement revision and current Parent Work/direct-child relation. A
   stale/foreign/retired target, changed placement revision,
   absent/revoked/expired/mismatched Grant, stale/mismatched ActionApproval,
   or mismatched source action is rejected before canonical Work mutation.
2. **Atomic durable evidence.** On success, one transaction writes the
   canonical child Work, `WorkAssigned` event, Committed Command receipt, and
   exactly one immutable `AssignWorkTargetBinding`. The binding records
   `targetWorkspaceRef → targetWorkspaceId` together with the ref encoding
   version and observed Workspace/placement revision; project, parent
   Workspace and Parent Work; WorkId and exact Work provenance; exact
   authority variant and all validated PermissionGrant or ActionApproval
   facts; and
   `ExecutionId`, `ProviderTurnId`, `LogicalActionId`, and `callRef`.
   `targetRefEncodingVersion = 1` labels the opaque PlacementContext reference
   contract in effect; it is not permission to recompute or enumerate the
   current `wref_` digest.
   `targetWorkspaceId` must equal the Workspace in the receipt, Work row, and
   event. A uniqueness constraint permits at most one binding and one
   successful AssignWork effect per `(ExecutionId, LogicalActionId)`.
3. **Committed replay.** Recovery first identifies the same pinned
   `LogicalActionId` and looks up its old generation's Command receipt. For a
   Committed receipt it requires the binding keyed by that exact CommandId and
   verifies the pinned target ref, complete source-action identity, project,
   parent/current Work, exact authority basis and target, receipt
   result, canonical Work/provenance, direct-parent edge, lifecycle, and
   exactly one matching `WorkAssigned` event. The immutable binding proves
   which child the original ref selected; recovery therefore does not resolve
   the now-stale ref again. It does not select another child or submit another
   Command.
4. **Fail closed.** Missing, duplicate, conflicting, malformed, foreign, or
   mismatched binding/effect evidence—including any pre-migration Committed
   receipt with no binding—does not advance the Action and does not append an
   Observation. Recovery records the new P9 durable binding-failure fact for
   the same Execution and `LogicalActionId`; it issues no Provider request,
   no new Command, and no canonical repair. A binding claiming the target was
   already Retired at commit is contradictory and fails closed. Current
   retirement after a proof-complete Active-at-commit binding does not fail
   replay (rule 7 below). A binding mismatch is an invariant/evidence
   failure, not a semantic rejection to be returned as a successful
   ControlResult.
5. **FencingRejected takeover remains unchanged.** A prior
   `TerminalRejected(FencingRejected)` receipt has no binding and is not a
   successful effect. P1 `07` still permits the current lease owner to submit
   a new generation-scoped CommandId only after the existing eligibility,
   freshness, and unresolved-effect checks pass. Other terminal rejections
   continue through their existing error algebra. A Committed receipt lacking
   a binding never becomes eligible for new-command retry.
6. **CAPA is not widened.** Binding evidence proves the exact authorization
   used for the committed effect; it does not grant authority, extend grant
   validity, broaden target scope, bypass current placement checks for a new
   effect, or create an ActionApproval. A Grant-authorized attempt rechecks
   that exact Grant at commit. An Approval-authorized attempt rechecks the
   exact Approved ActionApproval at commit and consumes it in the same
   transaction as the canonical handler resolution, keyed by that generation's
   CommandId. A FencingRejected pre-handler outcome does not consume it.
   Existing exact approval and resource boundary rules remain unchanged.
   Receipt replay consumes no new authority
   because it applies no new effect, but it must match the immutable
   authority/binding facts committed with the original effect.

7. **Retirement is evaluated at the effect boundary.** New AssignWork
   validates Active lifecycle in the Command transaction. A later Retired
   state does not invalidate evidence of the already committed mutation, so
   receipt replay still converges its Action and Observation. A Retired state
   observed before initial commit is a typed lifecycle rejection. This rule
   applies to the target Workspace's lifecycle only; all immutable project,
   parent edge, Work and provenance checks remain mandatory on replay.

The stored authority fields are evidence of the typed ControlAction
`Authorized` result as checked at commit. On receipt replay, compare that
immutable evidence and exact target to the pinned action; do not call the
authorizer or consume an approval again. A Grant may since be Revoked/expired.
For an ActionApproval variant, the durable row must now be `Consumed`, retain
the exact immutable action/target/ControlBasis facts, have revision
`approvalRevision + 1`, and `consumed_by` equal the original Committed
CommandId. Neither authority lifecycle change retargets the Work.

## DID executable contract

### ADT and trusted inputs

Replace the opaque `authorityRef` on ControlAction `Authorized` with a
ports-owned typed value passed unchanged by Agent Runtime through the
ControlAction→AssignWork handler→Command boundary. It is process-local trusted
evidence, never part of the model-authored `AgentAction` or Provider output.
The exact decision is:

```ts
type AssignWorkControlAuthorizationEvidence =
  | {
      readonly _tag: "PermissionGrant";
      readonly permissionGrantId: PermissionGrantId;
      readonly permissionGrantRevision: number;
      readonly projectId: ProjectId;
      readonly subjectKind: "WorkspaceAgent" | "Execution";
      readonly subjectRef: string;
      readonly capability: "core.control.assign-work";
      readonly targetRef: WorkspaceRef;
      readonly validFrom: Instant;
      readonly expiresAt: Instant | null;
      readonly actionDigest: Sha256;
      readonly controlBasisDigest: Sha256;
    }
  | {
      readonly _tag: "ActionApproval";
      readonly approvalId: ActionApprovalId;
      readonly approvalRevision: number;
      readonly projectId: ProjectId;
      readonly workspaceId: WorkspaceId;
      readonly executionId: ExecutionId;
      readonly stableActionId: "core.control.assign-work";
      readonly actionDigest: Sha256;
      readonly targetRef: WorkspaceRef;
      readonly controlBasisDigest: Sha256;
      readonly expiresAt: Instant;
    };
```

For the Grant variant, commit-time validation requires an Active, subject-bound
Grant whose capability and target exactly equal these values, whose revision
matches, and whose validity window contains commit time. Wildcard/unbound
grants do not qualify. For the ActionApproval variant, the same control
approval must still be Approved at the supplied revision and match the exact
project/workspace/execution/action/digest/target/ControlBasis/expiry; commit
consumes it in the same transaction as the canonical handler resolution,
setting `consumed_by = commandId`. A FencingRejected or ExecutionStopping
pre-handler result does not consume it. A Grant revocation/expiry or approval
change between authorization and Command commit produces a typed terminal
rejection before Work mutation.

On restart before Command commit, Agent Runtime replays the pinned action and
obtains a fresh typed `Authorized` value. After a Committed receipt, recovery
does not invoke the authorizer: it compares the immutable authority evidence
stored with the binding and never consumes approval again. Do not pass P12
`AuthorityDecisionInput` as a substitute for ControlAction authorization or
reconstruct evidence from model arguments or an `authorityRef` string.

Add a ports-owned immutable binding value:

```ts
type AssignWorkTargetBinding = {
  readonly schemaVersion: 1;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: LogicalActionId;
  readonly callRef: CallRef;
  readonly parentWorkspaceId: WorkspaceId;
  readonly parentWorkId: WorkId;
  readonly parentWorkRevisionAtCommand: number;
  readonly targetWorkspaceRef: WorkspaceRef;
  readonly targetRefEncodingVersion: number;
  readonly parentWorkspaceRevisionAtCommand: number;
  readonly targetWorkspaceRevisionAtResolution: number;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetLifecycleAtCommit: "Active";
  readonly workId: WorkId;
  readonly predecessorWorkId: WorkId;
  readonly workProvenanceJson: string;
  readonly authority: AssignWorkControlAuthorizationEvidence;
  readonly authorityCheckedAt: Instant;
};
```

`targetWorkspaceRef` is the opaque selector carried in model-authored
`AgentAction` output. Runtime treats it as untrusted input, resolves it through
the current PlacementContext, and saves that exact original string beside the
Runtime-resolved canonical target Workspace and revision. `ExecutionId`,
action IDs, authority facts, canonical target, and revisions are Runtime-bound;
the model supplies only the ref selector plus the bounded Work semantics and
reason already allowed by VDC-5. The binding is not part of
`semanticRequestFingerprint`: it is trusted resolution evidence associated
with the immutable Command receipt. The gateway rejects a binding whose
`commandId`, target, project, source action, authority evidence, or canonical
effect differs from its transaction inputs.

### Port and transaction boundary

Evolve P2 `WorkspacePlacementPort.resolveChildRef(rootWorkspaceId, ref)` to
return `Option<ResolvedChildPlacementRef>` rather than only
`Option<WorkspaceId>`:

```ts
type ResolvedChildPlacementRef = {
  readonly _tag: "ResolvedChildPlacementRef";
  readonly projectId: ProjectId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetWorkspaceRevision: number;
  readonly refEncodingVersion: 1;
};
```

The WorkspacePlacementPort implementation alone constructs this typed result.
For this call, `rootWorkspaceId` is the current Execution Workspace and is
therefore the direct Parent Workspace; it may be a non-root Workspace in the
Project tree. The port returns `None` unless the opaque ref resolves in the
current canonical PlacementContext to one Active direct child of that root.
The handler passes
the exact original ref and this result as trusted
`AssignWorkCommandEvidence`, alongside the parent/current-Work identities and
typed ControlAction authority. In the same Command transaction, Gateway
re-reads the root/parent Workspace, its current Parent Work, and target row;
checks project and direct-parent edge; requires Active lifecycle and exact
target revision equal to `expectedWorkspaceRevision`; and captures the
parent Workspace and Parent Work revisions at that command boundary. Any
revision drift yields `RevisionConflict`/the existing typed stale-target
rejection before Work mutation. The returned revision is durable proof of
which revision generated the current opaque ref; no later hash re-derivation
is part of replay.

Add `AssignWorkTargetBindingRepository.findByCommandId(commandId)` and
`insert(binding)`, both requiring the existing `TransactionScope`. The
dispatcher passes the typed evidence above to the handler; the handler passes
it unchanged as trusted Command submission context. Inside P1
`TransactionPort.transact`, Gateway reads the exact Grant or ActionApproval
row and checks every mutable and immutable field against the evidence and
pinned action. It does not accept a bare `authorized: true` and does not call
P12 `AuthorityDecisionInput` as a substitute for ControlAction authorization.
For Grant, it checks Active state, revision, subject, capability, target, and
time window. For ActionApproval, it checks Approved state/revision,
`binding_proven = 1`, route `Control`, project, workspace, execution, stable
action, digest, target, ControlBasis, and expiry, then consumes it by this
CommandId in the same transaction after the handler attempt. Only then does Gateway write the Work,
event, receipt, and binding. Do not split authority validation, approval
consumption, binding insertion, or receipt resolution into separate
transactions. Extend the P4-owned `ControlApprovalStore.consumeApproved`
input for this route with `consumedBy: CommandId`; its SQL sets `state =
'Consumed'`, increments revision once, and writes `consumed_by` in that same
transaction. The Command Gateway owns this call for AssignWork. Do not call the
current standalone `ControlActionAuthorizer.consumeApproval` after Gateway
commit for AssignWork.

Operational rollback before commit leaves no binding, Work, event, or
authoritative receipt; it may leave only the existing non-authoritative
CommandAttempt trace. After commit, all four canonical facts are visible
together. A uniqueness conflict is handled by re-reading the binding/receipt
inside a fresh transaction and either returning the exact existing committed
result or failing closed; it never overwrites evidence.

### SQL and migration

Migration `0033_assign_work_target_bindings` (`PRAGMA user_version = 33`)
adds the exact binding. It first adds composite unique indexes needed as
SQLite parent keys, then the binding table:

```sql
CREATE UNIQUE INDEX commands_id_project ON commands(command_id, project_id);
CREATE UNIQUE INDEX executions_id_project_workspace
  ON executions(execution_id, project_id, workspace_id);
CREATE UNIQUE INDEX workspaces_id_project_parent
  ON workspaces(workspace_id, project_id, parent_workspace_id);
CREATE UNIQUE INDEX works_id_project ON works(work_id, project_id);
CREATE UNIQUE INDEX permission_grants_id_project
  ON permission_grants(permission_grant_id, project_id);
CREATE UNIQUE INDEX action_approvals_id_project
  ON action_approvals(approval_id, project_id);

CREATE TABLE assign_work_target_bindings (
  command_id                    TEXT PRIMARY KEY,
  schema_version                INTEGER NOT NULL CHECK (schema_version = 1),
  project_id                    TEXT NOT NULL,
  execution_id                  TEXT NOT NULL,
  provider_turn_id              TEXT NOT NULL,
  logical_action_id             TEXT NOT NULL,
  call_ref                      TEXT NOT NULL,
  parent_workspace_id           TEXT NOT NULL,
  parent_work_id                TEXT NOT NULL,
  parent_work_revision_at_command INTEGER NOT NULL CHECK (parent_work_revision_at_command >= 0),
  target_workspace_ref          TEXT NOT NULL,
  target_ref_encoding_version   INTEGER NOT NULL CHECK (target_ref_encoding_version = 1),
  parent_workspace_revision_at_command INTEGER NOT NULL CHECK (parent_workspace_revision_at_command >= 0),
  target_workspace_revision_at_resolution INTEGER NOT NULL CHECK (target_workspace_revision_at_resolution >= 0),
  target_workspace_id           TEXT NOT NULL,
  target_lifecycle_at_commit    TEXT NOT NULL CHECK (target_lifecycle_at_commit = 'Active'),
  work_id                       TEXT NOT NULL,
  predecessor_work_id           TEXT NOT NULL,
  work_provenance_json          TEXT NOT NULL,
  authority_kind                TEXT NOT NULL CHECK (authority_kind IN ('PermissionGrant','ActionApproval')),
  permission_grant_id           TEXT,
  action_approval_id            TEXT,
  authority_evidence_json       TEXT NOT NULL,
  authority_checked_at          TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id),
  UNIQUE (work_id),
  FOREIGN KEY (command_id, project_id)
    REFERENCES commands(command_id, project_id),
  FOREIGN KEY (execution_id, project_id, parent_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (parent_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id),
  FOREIGN KEY (target_workspace_id, project_id, parent_workspace_id)
    REFERENCES workspaces(workspace_id, project_id, parent_workspace_id),
  FOREIGN KEY (parent_work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (predecessor_work_id, project_id)
    REFERENCES works(work_id, project_id),
  FOREIGN KEY (permission_grant_id, project_id)
    REFERENCES permission_grants(permission_grant_id, project_id),
  FOREIGN KEY (action_approval_id, project_id)
    REFERENCES action_approvals(approval_id, project_id),
  CHECK (
    (authority_kind = 'PermissionGrant' AND permission_grant_id IS NOT NULL AND action_approval_id IS NULL)
    OR
    (authority_kind = 'ActionApproval' AND permission_grant_id IS NULL AND action_approval_id IS NOT NULL)
  )
);

CREATE INDEX assign_work_target_bindings_target
  ON assign_work_target_bindings(project_id, target_workspace_id, target_workspace_ref);
CREATE INDEX assign_work_target_bindings_parent_work
  ON assign_work_target_bindings(project_id, parent_work_id, created_at);
```

`authority_evidence_json` is the versioned full snapshot of the typed union.
The `authority_kind` check requires exactly one foreign-keyed Grant or
ActionApproval id. Composite foreign keys enforce project consistency across
Commands, Executions, Workspaces, Works, Grants, and ActionApprovals. The
triple Workspace key enforces the exact target→parent edge; it is not merely a
same-project check. Transactional validation additionally checks mutable
Grant state/revision/subject/capability/target/time or ActionApproval
state/revision/route/action digest/target/ControlBasis/expiry and consumes an
approval after the handler attempt. The DID landing must include these exact
constraints and indexes; no schema choice is deferred.

`work_provenance_json` is the exact JSON serialization passed to the Work
row's `provenance` column in the same transaction. At replay, compare its
parsed typed fields and serialized stored value to the canonical Work row;
require `predecessorWorkId == parentWorkId` and equality to the pinned
model-authored bounded reason. No hash algorithm or lossy projection is used.

On uniqueness conflict, the serialized command transaction reads the existing
binding. Byte-equivalent identity and authority evidence for the same
CommandId returns its existing Committed receipt. A different CommandId or
different ref/Workspace/authority/source-action/effect evidence for the same
LogicalAction fails closed. If it conflicts with an existing Committed
receipt, record the single deduplicated Attention fact keyed to that committed
CommandId; if no Committed effect exists, roll back and return typed terminal
conflict with no Attention fact. Never `INSERT OR REPLACE` or overwrite
evidence. Migration is additive and
forward-only. It creates no bindings for old rows; pre-migration Committed
receipts without bindings follow the explicit P1 `07` exception and P9 fact
record below. The old binary refuses `user_version > 32`; rollback never
downgrades schema version or deletes binding/attention rows. Historical
receipts, events, grants, approvals, Work, and Actions remain read-only audit
evidence.

### P1 `07` receipt-first exception

P1 `07` §2's “prior `Committed` receipt converges the ledger; no new
Command” remains the first lookup and remains unconditional for other action
kinds. Direct-child AssignWork adds exactly this evidence gate:

```text
old AssignWork Command = Committed
  + exact AssignWorkTargetBinding + matching Work/event/provenance/authority
    → converge existing Action; no new Command
  + no binding / mismatch / malformed evidence
    → record P9 AssignWorkBindingAttentionFact; leave Action Pending;
      no Observation; no new Command; no Provider request
```

The second branch is the sole exception to P1 `07`'s successful
receipt-convergence rule. It does not alter the Command resolution or
receipt, and does not reinterpret an old receipt as FencingRejected. An
unbound old Committed receipt can never fall through to new-generation
Command eligibility. DID §6A.16 and P9 `07` cross-reference this exception.

### P9 durable failure fact and P10 owner

P9 `07` owns the immutable operational fact table
`assign_work_binding_attention_facts` and dedicated
`AssignWorkTargetBindingEscalated` Domain Event. The event and row are written
together by `RecoveryAttentionFactStore.recordAssignWorkBindingFailure` inside
`TransactionScope`. This is not a Work mutation, approval, or reuse of the
`ReconciliationEscalated` tool-side-effect record. The stable
`attention_fact_id` is SHA-256/versioned over
`(executionId, logicalActionId, committedCommandId)`; a unique constraint on
that triple makes repeated recovery inserts idempotent. `failure_code` records
the first detected typed condition and is never rewritten. Store only typed
reason and canonical identities; do not store the opaque ref, arbitrary model
text, or raw database error. On conflict, read the existing row and require
the identity tuple to match; otherwise report an invariant failure.

The current Execution owner records the fact/event after it detects an old
Committed receipt that fails the binding gate. The paired write is durable
before recovery returns blocked. A crash before its transaction commits
retries the same deterministic fact insert and emits one event in the next
successful transaction; a crash after commit returns the existing fact/event.
The fact preserves the Action as Pending and stops
recovery; P9 does not invent a new settlement or complete the Execution.

P10 `02` owns this fixed read-model mapping from the dedicated event and its
correlated P9 fact row:

| Fact source | Severity | Target | Deduplication and bubbling |
|---|---|---|---|
| `AssignWorkTargetBindingEscalated` + `assign_work_binding_attention_facts` | `Action Required` | affected Execution's owning/Parent Workspace (`executions.workspace_id`) | `attentionFactId` (derived from `(executionId, logicalActionId, committedCommandId)`); normal P10 subtree-summary bubbling, with no context copied |

P10 `07` adds acceptance that one Attention row appears after the event
consumer catches up; its target is the Parent Workspace, subtree count increments
once, and rebuild/restart reproduces it. The view makes no canonical
mutation. The fact remains visible; v1 adds no dismiss or repair action.
P10 retains the existing three severity values and maps this source to
`Action Required`. This is an explicit proposal decision, not an assumption
that P9 already specifies this source's presentation.

P9 adds this ports-owned read/write surface to the DID Port Catalog:

```ts
interface RecoveryAttentionFactStore {
  recordAssignWorkBindingFailure(
    fact: AssignWorkBindingAttentionFact,
  ): Effect<void, RecoveryAttentionFactStoreError, TransactionScope>;
  findAssignWorkBindingFailure(
    attentionFactId: AttentionFactId,
  ): Effect<Option<AssignWorkBindingAttentionFact>,
            RecoveryAttentionFactStoreError, TransactionScope>;
}
```

`record...` inserts by the deterministic fact id and unique tuple, appends
`AssignWorkTargetBindingEscalated`, and returns the existing row only when the
tuple is identical; otherwise it returns a typed invariant conflict. Both
writes share one transaction. `find...` is read-only. P10 consumes the event
through its existing apply-then-advance consumer and reads this port in that
same projection transaction; the event, source fact, Attention row, and
consumer offset therefore recover together. P10 owns the read-model DTO row;
it does not write the P9 source table. The source value `source` is
`AssignWorkTargetBindingFailure`, `targetWorkspaceId` is the Execution's
owning Workspace, and `dedupKey` is the stable fact id. Detail uses the fixed
summary “A committed AssignWork could not be proven to match its exact target;
recovery is paused.” plus the typed `failure_code`; no opaque ref or raw
authority material is projected.

Add to migration `0033`:

```sql
CREATE TABLE assign_work_binding_attention_facts (
  attention_fact_id       TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id              TEXT NOT NULL,
  execution_id            TEXT NOT NULL,
  target_workspace_id     TEXT NOT NULL,
  logical_action_id       TEXT NOT NULL,
  committed_command_id    TEXT NOT NULL,
  failure_code            TEXT NOT NULL CHECK (failure_code IN (
    'LegacyUnbound','MissingBinding','DuplicateBinding','MalformedBinding',
    'RefMismatch','AuthorityMismatch','ForeignTarget','PlacementMismatch',
    'SourceActionMismatch','ReceiptMismatch','WorkMismatch',
    'ProvenanceMismatch','EventMismatch','CommitLifecycleMismatch'
  )),
  first_detected_at       TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, committed_command_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (committed_command_id, project_id)
    REFERENCES commands(command_id, project_id)
);

CREATE INDEX assign_work_binding_attention_target
  ON assign_work_binding_attention_facts(project_id, target_workspace_id, first_detected_at);
```

`AssignWorkTargetBindingEscalated` is appended to the existing
project-local event journal in the same transaction as this fact row. Its
payload is exactly `{attentionFactId, executionId, targetWorkspaceId,
logicalActionId, committedCommandId, failureCode}`; `aggregate_ref` is the
Execution's owning Workspace, `correlation_ref` is the LogicalActionId, and
`caused_by_command_id` is the committed AssignWork Command being investigated.
For a new tuple, the RecoveryAttentionFactStore appends the event and inserts
the row; both roll back together. A duplicate tuple returns the existing row
without appending another event. A deterministic fact/event conflict with
different payload returns a typed invariant error.

`attention_fact_id` is `att_` plus lowercase hex of the versioned SHA-256
tuple above. The row is immutable and retained; no resolution command,
dismissal state, or automatic deletion is added. P10 consumes the event and
loads this P9-owned fact as its durable source.

## Recovery and observation order

For the pinned successful Provider result, the current generation performs:

```text
load same AgentLoopStep / pinned decode / same LogicalActionId
→ find prior generation Command receipt (P1 `07` receipt-first)
→ if AssignWork Committed: require exact binding gate above
→ if binding unproven: insert/read the same durable P9 fact and stop
→ if binding proven: verify canonical facts
→ mark/reconcile the existing Agent Action as Applied
→ append exactly one sourced Observation
→ advance action cursor / StepEffectsCommitted under P9
```

No Provider request occurs. No new Command is created on the Committed branch.
The binding, Command result, Work, and event remain immutable. Action
disposition and Observation keep their existing P9 identities and
idempotency; a crash between Action disposition and Observation resumes that
same P9 handoff without duplicating either. Missing or inconsistent binding
diverts before Action Applied/Observation into durable Attention.

## New-write, legacy, migration, and rollback disposition

- New AssignWork Committed receipts must have exactly one binding in the same
  transaction. Enforce this in the Command/Application boundary and test it;
  SQL cannot enforce cross-table existence at every insert without changing
  the existing `commands` resolution model.
- Existing FencingRejected receipts remain readable and eligible only under
  P1 `07` rules; they do not need a binding.
- Existing Committed AssignWork receipts created before migration have no
  fabricated binding. They fail closed with durable Attention if recovered
  while Action-Pending. Do not backfill from Work provenance or infer a child.
- A rollback before commit removes all transaction writes. A crash after
  commit preserves all four facts and replay uses the binding. Application
  rollback after schema migration requires a compatible prior binary only
  when it can safely refuse the newer schema; do not roll schema version back
  or delete binding rows.
- Historical audit remains readable. No old `CommandId`, receipt, event,
  Grant, Work, or Action row is rewritten. No replay migration manufactures
  evidence.

## Required qualification matrix

All process cases use real daemon processes, the same isolated durable
database, real lease expiry/takeover, public setup/controls, and independent
read-only snapshots. Test-only transaction probes may pause at a boundary but
must not write receipts, grants, bindings, or leases directly.

| Case | Gen0 / setup | Gen1 expected result |
|---|---|---|
| RED baseline | Existing reproduction: Work + receipt + event commit, kill before Observation, no binding in current schema. | Current implementation remains blocked at `target-unavailable`; this is the pre-landing evidence, not a passing test. |
| Commit-before | Pause inside the binding/Work/receipt/event/optional approval-consumption transaction before COMMIT; independent connection sees none; kill gen0. | Rollback leaves no binding/effect/receipt/approval consumption; gen1 revalidates exact current ref and typed authority and commits exactly one matching set. |
| Commit-after | Commit all canonical facts and optional ActionApproval consumption, verify they are visible, kill gen0 before Action Applied/Observation. | Gen1 validates binding against pinned ref and Work provenance without re-resolving stale ref; same Command receipt, one Work/event/binding, original ActionApproval `consumed_by` is the original CommandId, Action Applied, one Observation, no Provider repeat. |
| Non-root Parent positive | Publicly form `ProjectRoot → Parent → DirectChild`; run AssignWork in an Execution owned by the non-root Parent; obtain the child's ref through that Parent's `list_workspaces`, authorize its exact target, commit, then kill gen0 before Observation. | `rootWorkspaceId = parentWorkspaceId = Execution.workspaceId` binds the non-root Parent, not `Project.rootWorkspaceId`; gen1 resolves from the persisted binding and produces one Work/event/Action/Observation. |
| Attention-fact commit sides | On binding mismatch, pause recovery-fact/event transaction before COMMIT in one run and after COMMIT in another; kill daemon and restart. | Before: neither fact nor event remains and retry creates one pair. After: one pair remains; retry returns it without another event. P10 produces one row and rebuild preserves one row. |
| Action/Observation boundary | Commit canonical transaction; crash after Action disposition or after Observation append in separate runs. | P9 converges the same Action/Observation once; no new Command or Provider request. |
| Sibling substitution A→B | Pin ref/grant for child A, arrange canonical receipt/Work/binding facts naming sibling B (or corrupt one persisted binding field in isolated fixture). | Durable Attention; no Action Applied, Observation, new Command, second Work, or provider replay. A valid binding for A succeeds only for A. |
| Authority mismatch | Wrong typed Grant/ActionApproval variant, id/revision, subject/capability/target/validity, action digest, ControlBasis, parent, project, source action, WorkId, provenance, or event cardinality. | Durable Attention for contradictory committed evidence; pre-effect mismatches are typed authorization/stale rejection with no binding or Work. |
| ActionApproval path | Create the exact pending CAPA approval, approve it through the public governance route, pass the typed approval evidence across ControlAction→Command, and crash around Command commit. | Approval consumption is atomic with canonical Command resolution; replay validates the stored ActionApproval evidence and original `consumed_by`, without re-authorizing or re-consuming. |
| Missing/duplicate/old binding | Delete only in isolated fixture, duplicate logical binding, malformed version, or recover legacy Committed receipt lacking binding. | Durable Attention; no inference/reexecution/backfill. |
| Foreign target | Existing binding or current ref points outside project/direct-parent scope. | Durable Action Required Attention for inconsistent committed evidence; new effect is rejected before Work/receipt/binding. |
| Retired lifecycle timing | Target Active at command commit and Retired before gen1 replay; separate case has target Retired before initial command commit. | First case converges from commit-time Active binding with no new mutation; second is rejected before Work/receipt/binding. |
| Grant/approval race | Concurrent exact Grant revoke/expiry or ActionApproval revision/expiry/consumption and initial AssignWork commit. | SQLite transaction serialization yields typed rejection with no effect/binding/approval consumption, or one commit bound to the exact authority and at most one same-transaction approval consumption; never commits from stale authorizer output. |
| Existing negative branches | Old FencingRejected before/after receipt commit. | Existing new-generation Command eligibility remains green and writes one effect/binding; non-fencing terminal receipts are not retried. |

Every green case asserts exact `targetWorkspaceRef`, typed authority variant
(PermissionGrant or ActionApproval), its id/revision/subject/capability/target
or action digest/ControlBasis/expiry, and no authority reconstructed from the
P12 command resolver; same ProviderTurn/LogicalAction/callRef;
unique generation-scoped Command behavior; one Work/WorkAssigned/binding;
canonical Work provenance and Workspace; one Action disposition/Observation;
and zero second Provider decision. Binding corruption is fixture-local and
must not modify the shared DB. Both sides of the canonical transaction commit
boundary are mandatory, in addition to the existing before/after Observation
qualification.

## Non-recommended alternative: enumerate historical reference hashes

Do not recover the target by recomputing the current `wref_` hash over
historical Workspace revisions. The current digest formula is implementation
behavior, not a frozen stable-reference contract. Enumeration would require
freezing the canonical encoding/version, the starting and terminal revision,
whether every revision is retained and contiguous, uniqueness/collision
behavior, imported/migrated data handling, version rollover, and a bounded
search cost. Workspace revision may change for unrelated reasons; future hash
changes would strand older refs or tempt permissive fallback. A sibling A/B
collision or missing revision history would still have to fail closed. The
binding records the resolution at the only moment it is authoritative and
avoids making replay depend on perpetual hash-format compatibility.

## Governance decision requested

The exact severity, target, deduplication, subtree behavior, and no-repair
policy above are explicit proposed semantics. P9 does not already define this
source's attention presentation; P10 is the proposed owner. The one decision
required from the governor is whether to accept this complete fixed package,
including the following selected disposition for unproven committed receipts:

- persist one immutable `assign_work_binding_attention_facts` row;
- map it in P10 to `Action Required` at the Execution's owning Workspace,
  deduplicated by `(executionId, logicalActionId, committedCommandId)` and
  bubbled by the existing subtree summary;
- keep the Action Pending and block recovery, with no dismiss or repair action
  in this proposal.

This is a proposal choice, not an inference from P9. If the governor rejects
any part, the package returns for revision; neither landing nor implementation
may independently choose a severity, target, dedup key, projection behavior,
or repair route.

## Landing, review, and implementation authorization sequence

1. Manual governor accepts this exact proposal by recorded SHA-256 and records
   the one decision above. This does not itself authorize implementation.
2. Land only the listed SD §4.11 semantic clause; DID §6A.16 and §5.3/§7.2/
   §9.3/§9.9 details; P1 `07` exception; P9 `07` fact/event; and P10 `02`/
   `07` projection/acceptance. Record resulting System Design and DID
   revisions and the landing commit SHA in the decision record. Do not modify
   implementation code, tests, or unrelated frozen clauses in this landing.
3. An independent reviewer compares the accepted proposal hash with the
   landed files and checks single-owner consistency, Grant and ActionApproval
   evidence across the handler/Command boundary, atomic approval consumption,
   P1 receipt-first exception, P9 fact/event durability, P10 severity/target/
   dedup/bubbling, SQL/FK/migration completeness, retirement timing, no legacy
   inference/backfill, and the full adversarial/crash matrix. Review must
   report **Blocking = 0** before the Design Gap is marked
   design-resolved. If any accepted text cannot be landed exactly, stop and
   obtain a new governance decision; do not silently amend semantics.
4. Only after landing review, request a separate explicit token:
   `AUTHORIZE_AH10_ASSIGN_WORK_TARGET_BINDING_IMPLEMENTATION`. Its scope is
   the additive migration, typed port/repository, trusted AssignWork Gateway
   validation/binding transaction, exact receipt-first recovery and durable
   Attention integration, isolated pending RED promotion/strengthening, and
   the qualification matrix above. It excludes other AH10 controls and does
   not close AH10 globally.
5. Implement in order: first preserve/extend the pending RED with sibling A/B
   and missing-binding cases; add migration and port; make first resolution
   atomic; add receipt-first validation and Attention; qualify all crash sides
   on real daemons; run targeted checks, then full `pnpm check` and
   `pnpm test:functional`; record exact commit/base and results. No phase
   closure claim until every authorized criterion passes.

No `docs/design/**`, implementation, or test file has been changed by this
proposal. No staging, commit, push, or implementation authorization is
performed.
