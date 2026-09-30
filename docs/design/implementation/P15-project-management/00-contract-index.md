# P15 — Project Management

## Document map

| Doc | Owns |
|---|---|
| `01-project-commands.md` | Rename/Close payload, authority, CAS, ProjectName and lifecycle gate |
| `02-directory-read.md` | principal-scoped directory, opaque snapshot, privacy and collision display |
| `03-close-convergence.md` | archive stop/quiescence, HumanMessage and AgentLoopStep convergence, legacy adoption |

## 0. Status and scope

**GOVERNANCE-ACCEPTED / implementation authorized after this contract landing.**

P15 implements a separate Project management surface. A Project is the long-lived container; a Workspace tree is only its internal responsibility structure. P15 owns ProjectDirectory, RenameProject, the human Close-as-archive surface, and the required Closed-project coordination rules. It does not add hard delete or Reopen.

## 1. Contracts

### 1.1 ProjectDirectory

ProjectDirectory is principal-scoped and independent from project-scoped ViewId. Every page re-authenticates its principal and validates an opaque continuation snapshot bound to principal, scope, visibility revision, sort and filter. It is not bearer authority. Grant/revoke or visible-row changes expire the snapshot; resolver failure fails closed. Tokens, errors, response shape and pagination must not disclose invisible projects. Physical timing side channels of shared infrastructure are outside this protocol guarantee.

Rows expose name, lifecycle, rootWorkspaceId, revision, updatedAt and an opaque navigation projectId. Same-name or visual-skeleton collision rows expose a scope-local displayDiscriminator; comparison keys/skeletons never leave the server.

### 1.2 RenameProject

RenameProject(name, expectedRevision) is Open-only, exact-project-governance-authorized and CAS guarded. It increments Project.revision only and emits ProjectRenamed(previousName, name, revision). Closed Rename rejects. ProjectNamePolicy v1 uses pinned Unicode 15.1.0 NFC and UTS #39 15.1.0 tables; controls/format/private-use/unassigned code points reject. Name comparison and visual skeleton are versioned persisted facts.

### 1.3 CloseProject / archive

CloseProject(expectedRevision) is exact-authority, CAS and explicit-confirmation guarded. It atomically closes the Project lifecycle gate. New SubmitHumanMessage, Pending→Claimed, autonomous admission and every existing-Project Open-required mutation reject after Close wins. CreateProject absent→Open is outside this gate.

Close automatically issues idempotent cooperative StopExecution/Quiescence for Active executions. It is not a kill and does not cancel Work. Existing execution recovery/settlement remains allowed; no new ProviderTurn, ToolInvocation, successor admission or AgentAction starts. Existing Provider/Tool evidence is persisted and reconciled under P2/P3/P9 stop and settlement contracts.

Human messages become Pending | Claimed | Answered | Declined(ProjectClosed). Close handles Pending/unadmitted Claimed atomically with Inbox retraction; delayed replay/rebuild cannot revive Declined entries. A message with a committed admission settles or writes back before it can be declined.

### 1.4 AgentLoopStep closure

Close consumes existing Stop/Quiescence and AHT contracts: NextStepReady and OutputRejected(Retry) must ensure the already committed Prepared successor, but it may not start a Provider turn; StepEffectsCommitted has no successor and transitions through the existing settlement path. Provider-only interrupted requests become existing terminal provider failure plus Interrupted/Failed, never a fake OutcomeUnknown. OutcomeUnknown requires nonempty real unresolved ToolInvocation refs.

## 2. Legacy adoption

Before enabling P15, run a read-only ProjectNamePolicy v1 preflight. Only compliant unchanged legacy names can receive atomic, idempotent metadata backfill. Any normalized-changing or rejected legacy name fails the P15 feature migration closed; it may only be repaired by a separately governed, auditable migration/repair contract. No direct SQL rewrite or legacy bypass is permitted.

## 3. Acceptance evidence

P15 requires mechanical coverage for lifecycle-gate races, Close at every HumanMessage/AgentLoopStep/Provider/Tool/settlement boundary, directory revoke/token privacy, visual collisions, and legacy migration crash/restart. Full suite must remain green.

