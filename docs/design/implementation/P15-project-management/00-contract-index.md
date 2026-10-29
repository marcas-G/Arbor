# P15 — Project Management

## Document map

| Doc | Owns |
|---|---|
| `01-project-commands.md` | Rename/Close payload, authority, CAS, ProjectName and gateway admission |
| `02-directory-read.md` | local single-user directory port and DTO |
| `03-close-convergence.md` | archive stop/quiescence and conversation convergence |

## Status and scope

**IMPLEMENTATION CONVERGENCE — local single-user v1.**

A Project is the long-lived container; a Workspace tree is only its internal responsibility structure. P15 owns local project listing, RenameProject, Close-as-archive, and Closed-project convergence. Hard delete, Reopen, multi-principal visibility and paginated directory snapshots are outside v1.

## Contracts

### Local ProjectDirectory

ProjectDirectory is a read Port independent from project-scoped ViewId. The SQLite adapter returns the complete local directory ordered by updatedAt; the HTTP shell authenticates the local principal and serializes the Port result. No pagination or multi-principal visibility is claimed.

### ProjectName v1

Create and Rename share one server-side normalizer: NFC, Unicode whitespace folding, trim, rejection of control/format/surrogate characters, and 1..120 Unicode scalars. Names need not be unique. UTS #39 skeletons and persisted discriminators are deferred until a real shared-directory requirement exists.

### Gateway ProjectAdmission

Every command defaults to OpenRequired at CommandGateway. CreateProject is Bootstrap. StopExecution, SettleExecution, RevokePermission and RetireWorktree are explicitly ClosedAllowed. This is the authoritative Project lifecycle gate; handler checks may remain only as defense in depth.

### Close / conversation convergence

CloseProject CASes Open → Closed, terminates Pending and unadmitted/failed conversation messages as Declined, consumes their Inbox entries in the same transaction, and requests cooperative stop for all unsettled executions. In v1, Declined has exactly one meaning: ProjectClosed; claimedByExecutionId remains available when present.

Pending → Claimed also verifies Project Open in the same SQL CAS. Successfully admitted/settled responses keep their ordinary write-back path.

## Acceptance evidence

P15 requires tests for gateway admission on Closed projects, atomic claim rejection, message + Inbox termination, cooperative stop, local directory Port, name normalization, migration, restart, and real HTTP use.

