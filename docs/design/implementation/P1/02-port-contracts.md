# P1 — 02 Port Contracts

**Authority:** DID v1.6 §7.1–§7.4, §7.7, §9.5, §9.7, §10.4.1, §12.6, §12.10; DID v1.38 §4.1C FT-DG-01 ProjectResourceProfilePort and Project source
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Implements:** P1 port contracts; P1-DG-08 persistence access; P1-DG-10 port ownership.

**Accepted FT-DG-01 OPEN-1/OPEN-2 owner amendment (DID v1.38):** The existing
`ProjectRepository.create(project)` and `findById(projectId)` carry the
Project's `resourceSource: ProjectResourceSource` field. This does not add a
Profile catalog lookup or change `ProjectResourceProfilePort` timing, effects,
or filesystem boundary. The persisted source is decoded as the exact closed
P1 ADT; malformed JSON, unknown tags, missing/extra fields, or wrong field
types fail the Project read as persistence corruption and are never converted
to `LegacyUnknown`. `ProjectDirectory`'s non-path read projection is owned by
P15 `02-directory-read.md`.

Ports are Effect services (DID §7.1/§7.7); adapters are Layers. All P1
repositories **require `TransactionScope`** and never open their own
connection. No generic CRUD (DID §7.3). Owning package: **`ports`**.
Adapters: `adapters/persistence-sqlite`, `adapters/environment-local`.

## 1. Effect channel rules

```text
Repository method:
  A = typed result (ADT / Option where absence is a normal alternative)
  E = <RepositoryName>Error   // per-repository semantic error, NOT a catch-all
  R = TransactionScope        // the tag enters R at the call site; the method
                              // itself requires only TransactionScope
TransactionPort.transact adds TransactionOperationalFailure to E.
```

- There is **no** universal `RepositoryError` (DID §6A.2 / §0A.6). Each
  repository declares its own narrow error (`ProjectRepositoryError`, …).
- CAS failures are typed errors of the owning repository.
- Adapter errors (`SqliteError`, …) are translated at the adapter boundary and
  never appear in a port `E` (DID §0A.6).

## 2. Transaction

```ts
class TransactionScope extends Context.Tag("arbor/TransactionScope")<
  TransactionScope, { readonly session: AdapterSession }>() {}
interface TransactionPort {
  transact: <A, E, R>(body: Effect<A, E, R | TransactionScope>)
    => Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

`AdapterSession` is an **opaque `ports`-owned type** (`interface AdapterSession
{ readonly id: string }`); it must not reference `adapters/*` (DID §10.4.1).

See `03-transaction-model.md`.

## 3. Repositories

### ProjectRepository

| Method | Semantics |
|---|---|
| `findById(projectId): Effect<Option<Project>, ProjectRepositoryError>` | |
| `create(project)` | insert; composite `(root_workspace_id, project_id)` FK + `UNIQUE(workspace_id, project_id)` |
| `updatePolicyIfRevision(projectId, expectedRevision, policy, newPolicyRevision, newRevision)` | CAS |
| `closeIfRevision(projectId, expectedRevision, newRevision)` | CAS |

### WorkspaceRepository

| Method | Semantics |
|---|---|
| `findById(workspaceId): Effect<Option<Workspace>, WorkspaceRepositoryError>` | |
| `create(workspace)` | parent immutable |
| `changeResponsibilityIfRevision(...)` | CAS; `responsibility_revision++` |
| `updateResourceBoundaryIfRevision(...)` | CAS; `resource_boundary_revision++` |
| `updatePolicyIfRevision(...)` | CAS; `workspace_policy_revision++` |
| `selectCurrentWorkIfRevision(...)` | CAS |
| `replacePrimarySessionIfRevision(...)` | CAS |
| `retireIfRevision(...)` | CAS |
| `countActiveChildren(workspaceId)` | retire precondition |
| `hasOpenWork(workspaceId)` | retire precondition |

### WorkRepository

| Method | Semantics |
|---|---|
| `findById(workId): Effect<Option<Work>, WorkRepositoryError>` | |
| `create(work)` | lifecycle Open |
| `refineIfRevision(...)` / `completeIfRevision(...)` / `cancelIfRevision(...)` | CAS |
| `listByWorkspace(workspaceId, lifecycle?)` | open-work / current checks |

### SessionRepository

| Method | Semantics |
|---|---|
| `findById(sessionId): Effect<Option<Session>, SessionRepositoryError>` | |
| `create(session)` | `WorkspacePrimary` / `ExecutionScoped` binding; P1 bootstrap |

`appendEntry` (runtime operational mutation, DID §4.4) is **P2**, not P1.

### ResourceOwnershipRepository

| Method | Semantics |
|---|---|
| `loadActiveConflicts(resourceSpaceId)` | conflict load inside `BEGIN IMMEDIATE` |
| `insertClaim(claim)` | resolved `CanonicalResourceRegion` |
| `releaseClaim(claimId, releasedAt)` | `UPDATE ... WHERE released_at IS NULL` |
| `listActiveByWorkspace(workspaceId)` | retire precondition |

P1 `ResourceOwnershipClaim` record (matches the DDL columns;
`resource_space_id` is derived from `region.resourceSpaceId`):

```ts
{ claimId, workspaceId, region: CanonicalResourceRegion,
  sourceAddressSnapshot: ResourceAddress, resourceBoundaryRevision,
  resolvedAtEnvironmentRevision, createdAt, releasedAt: string | null }
```

### WorkspaceResourceActivationStore (FT-DG-01 OPEN-3)

This P1-owned operational store records only a root Workspace's committed
boundary-activation obligation. It is not a Profile source/audit record and
stores no canonical path, Profile ref/version, raw failure, or model/user
text.

```ts
interface WorkspaceResourceActivationIntent {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly status: "Pending" | "Active";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

type NewWorkspaceResourceActivationIntent = Omit<
  WorkspaceResourceActivationIntent,
  "status" | "activatedAt"
> & { readonly status: "Pending"; readonly activatedAt: null };

type WorkspaceResourceActivationStoreError = RepositoryFailure<
  "WorkspaceResourceActivationStore"
>;

interface WorkspaceResourceActivationStoreService {
  readonly insertPending: (
    intent: NewWorkspaceResourceActivationIntent,
  ) => Effect.Effect<void, WorkspaceResourceActivationStoreError, TransactionScope>;
  readonly find: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    resourceBoundaryRevision: ResourceBoundaryRevision,
  ) => Effect.Effect<Option.Option<WorkspaceResourceActivationIntent>, WorkspaceResourceActivationStoreError, TransactionScope>;
  readonly compareAndSetActive: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    resourceBoundaryRevision: ResourceBoundaryRevision,
    activatedAt: string,
    updatedAt: string,
  ) => Effect.Effect<boolean, WorkspaceResourceActivationStoreError, TransactionScope>;
  readonly listPending: (
    projectId?: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceResourceActivationIntent>, WorkspaceResourceActivationStoreError, TransactionScope>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<WorkspaceResourceActivationIntent>,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
}
```

The unique identity is `(projectId, workspaceId, resourceBoundaryRevision)`;
`insertPending` participates in the CreateProject Gateway transaction.
`listPending` is deterministic (createdAt then identity) and is the P12
activation worklist. `listAll` is deterministic and lets P12/P10 reconcile
stale Active projection rows after a crash. Active intents remain durable so
replay/rebuild can prove the exact transition; no intent is hard-deleted by
P12 or P10. The additive migration never infers/backfills rows from a
non-empty Workspace boundary or a missing claim.

### CommandStore

| Method | Semantics |
|---|---|
| `findResolution(commandId): Effect<Option<StoredCommandResolution>, CommandStoreError>` | returns tuple metadata and the stored result/error JSON as raw text; does not decode the receipt |
| `insertCommitted(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, resultJson)` | authoritative |
| `insertTerminalRejected(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, terminalErrorJson)` | authoritative, no event |
| `recordResolvingAttempt(commandId, outcome, startedAt, settledAt)` | resolving attempt (Committed / TerminalRejected); written in the **command transaction** (03 §3.1/§3.2) |
| `recordRetryableAttempt(commandId, failureKind, startedAt, settledAt)` | non-authoritative trace; written in a **separate** short transaction after rollback (03 §3.3) |

`StoredCommandResolution` is the ports-owned pre-decode representation of an
existing `commands` row:

```ts
interface StoredCommandResolution {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly schemaVersion: string;
  readonly fingerprintAlgorithmVersion: number;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly resultJson: string | null;
  readonly terminalErrorJson: string | null;
  readonly createdAt: string;
  readonly settledAt: string;
}
```

`resultJson` and `terminalErrorJson` are the stored column text, not parsed
JSON values; `findResolution` MUST NOT parse, validate, or otherwise interpret
either field. Within the existing command transaction, the Application
compares `(semanticRequestFingerprint, schemaVersion,
fingerprintAlgorithmVersion)` from this representation with the current
request first. A mismatch follows P1 `01`'s existing `IdempotencyConflict`
branch without decoding or disclosing either raw field. Only an exact tuple
match may proceed to the existing Application receipt decoding and produce a
typed P1 `CommandReceipt`. This port contract does not define exact-tuple
result/error shape rules or decoding failures; it adds no corruption error
type, failure mapping, or receipt repair behavior.

The exact-tuple Application decoder and its `PersistenceCorruption<"CommandStore">`
classification are defined in `01-command-contracts.md` §3A. The Port remains
raw and version-neutral: it does not select a command result schema, convert
`result_json` / `terminal_error_json` to a typed value, or make a corruption
disposition. Gateway/Recovery call sites own the trusted command type and
schema selection after the appropriate identity/tuple checks; adapter JSON
parsing before those boundaries is forbidden. This clarification changes no
`StoredCommandResolution` field, SQL, DDL, migration, or transaction owner.

`CommandStore` allocates the next free `attempt_no` for a `command_id`
(serialized by `BEGIN IMMEDIATE`); callers do not supply it.

### DomainEventJournal

| Method | Semantics |
|---|---|
| `append(events)` | append in the semantic transaction; allocates project-local sequence |
| `readAfter(projectId, sequence, limit)` | consumer catch-up |
| `lastSequence(projectId): Effect<number, DomainEventJournalError>` | returns `0` when absent (allocation support) |

### ConsumerDeadLetterStore

| Method | Semantics |
|---|---|
| `quarantine(consumerId, projectId, sequence, reason)` | `INSERT OR IGNORE`; same transaction as the offset skip (05 §3) |

### ProjectionStore

| Method | Semantics |
|---|---|
| `apply(batch)` | projection writes in the same SQLite DB/tx as the offset advance (05 §4) |
| `reset()` | clear the projection for rebuild (05 §6) |

### OwnershipWriteService

| Method | Semantics |
|---|---|
| `resolveAndWrite(projectId, addresses, claims)` | implements the 04 §3.3 ownership write sequence; returns `{ regions, claims }` |
| `activatePendingWorkspaceResource(projectId, workspaceId, resourceBoundaryRevision, addresses)` | P11 CreateProject recovery path; resolves addresses outside the write transaction, then in one `BEGIN IMMEDIATE` scope checks the exact Pending intent and environment revision, loads overlaps, inserts the complete claim set, CASes Pending→Active, appends `WorkspaceResourceActivationChanged(Active)`, and commits; returns `Activated` or idempotent `AlreadyActive`; missing/mismatched intent fails closed |

`ProjectionStore` requires `TransactionScope`; ordinary `resolveAndWrite`
opens its own transaction (it resolves outside, then transacts). The activation
operation also resolves outside, but its claim insert, intent CAS, and P1
DomainEventJournal append share exactly one transaction; it MUST NOT call
`resolveAndWrite` as a nested/separate commit and MUST NOT expose a state where
claims are committed while the intent remains Pending or vice versa.

### ConsumerOffsetStore

| Method | Semantics |
|---|---|
| `read(consumerId, projectId): Effect<number, ConsumerOffsetStoreError>` | returns `0` when the row is absent |
| `advance(consumerId, projectId, lastSequence)` | upsert (`INSERT ... ON CONFLICT(consumer_id, project_id) DO UPDATE`); same transaction as the projection write (05 §4) |

### EnvironmentRevisionStore

| Method | Semantics |
|---|---|
| `current(projectId): Effect<Option<string>, EnvironmentRevisionStoreError>` | read **inside** the ownership write tx; `None` = not observed (treated as not stale) |
| `record(projectId, revision)` | called by the ownership write (lazy init with the observed revision) and by environment-change (later phase) |

### Error classification

```text
EnvironmentError / ResourceResolutionStale are Port/Application operational
errors, NOT DomainError. ResourceResolutionStale is a retryable operational
failure (re-resolve + re-evaluate), never an authoritative rejection.
```

## 4. Other P1 ports

| Port | Method | Notes |
|---|---|---|
| `Clock` | `now(): Effect<string, never>` | ISO timestamp; testable; provided by the adapter Layer |
| `IdGenerator` | `generate<T>(kind): Effect<T, never>` | used by **callers** and the journal (EventId), not command handlers |
| `ProjectEnvironmentPort` | `resolve(projectId, addresses): Effect<{ regions: ReadonlyArray<CanonicalResourceRegion>; observedEnvironmentRevision: string }, EnvironmentError>` | resolve **outside** write tx (DID §1.5); returns regions + revision together |

### ProjectResourceProfilePort (FT-DG-01 CreateProject v2)

**Accepted runtime selection amendment (2026-11-11; DID §4.1D):** Startup
Profiles retain the immutable snapshot below. A separately persisted,
append-only host registry also resolves explicitly human-selected directory
references at runtime and reloads them after restart. Registration/probing
happens outside Application; `list()` stays path-free and `resolve()` remains
pure in-memory access. A reference cannot change its canonical address.
`ProjectRepository.isDirectoryLinked(path)` checks persisted Project-root
FileTree bindings under TransactionScope; CreateProject uses it for dynamic
`directory-` references after receipt lookup and before writes, failing closed
if that check is unavailable. It reads SQLite only and performs no host I/O.

The P12 host composition loads and validates the local host Profile registry at
startup, then supplies this immutable, read-only snapshot to Application. The
Port itself performs no filesystem I/O; its Profile lookup is deterministic
memory access so CreateProject may call it only after the Gateway has checked
for an existing receipt, without holding the transaction across a slow host
probe.

```ts
interface ProjectResourceProfileSummary {
  readonly resourceProfileRef: string;
  readonly version: string;
  readonly displayName: string;
  readonly available: boolean;
}

interface TrustedProjectResourceProfile extends ProjectResourceProfileSummary {
  readonly available: true;
  readonly canonicalAddress: Extract<ResourceAddress, { readonly _tag: "FileTree" }>;
}

interface ProjectResourceProfilePortService {
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectResourceProfileSummary>, never>;
  readonly resolve: (
    resourceProfileRef: string,
    version: string,
  ) => Effect.Effect<Option.Option<TrustedProjectResourceProfile>, never>;
}
```

`canonicalAddress` is an Application/handler trusted value and must never be
returned by the public profile-list transport. The list exposes only opaque
ref, version, friendly display name and availability. The host configuration
owns stable ref/version values across process restart; changing canonical path
or scope requires a new version. Profile lookup does not decide authority,
create a GitWorktree, or mutate ownership claims. The existing
ProjectEnvironmentPort / OwnershipWriteService remains the filesystem
resolution and ownership-activation path after the canonical Workspace
boundary has committed.

## 4A. Application boundary input: `VerifiedCommandAuthority`

`VerifiedCommandAuthority` (`01-command-contracts.md` §2A, P1-DG-11) is **not**
a port service and has **no** repository or adapter in P1. It is a trusted
**Application-boundary input fact** passed to
`CommandGateway.execute(envelope, submissionContext, authority)`; the `ports`
package neither defines, stores, nor resolves it. P1 performs deterministic
exact-match validation only (no Permission/RBAC/Authority Resolver).

## 5. Transaction participation summary

```text
ProjectRepository / WorkspaceRepository / WorkRepository / SessionRepository
ResourceOwnershipRepository / CommandStore / DomainEventJournal
ConsumerOffsetStore / EnvironmentRevisionStore / ConsumerDeadLetterStore
ProjectionStore                                    -> require TransactionScope
OwnershipWriteService                               -> opens its own transaction
WorkspaceResourceActivationStore                   -> require TransactionScope
ProjectEnvironmentPort                             -> NO TransactionScope (slow I/O)
ProjectResourceProfilePort                         -> NO TransactionScope (immutable in-memory snapshot)
Clock / IdGenerator                                -> NO TransactionScope
CommandStore.recordResolvingAttempt                -> command transaction
CommandStore.recordRetryableAttempt                -> separate scope (after rollback)
```

## 6. Frozen execution details

- **Time source.** Repositories/adapters obtain `created_at` / `updated_at` /
  `settled_at` from `Clock` (provided by the adapter Layer); the domain never
  reads time. `recordResolvingAttempt` / `recordRetryableAttempt` receive
  `startedAt` / `settledAt` from the caller (Clock-backed).
- **`AdapterSession`.** Repositories obtain the live driver connection from
  `TransactionScope.session`; the adapter Layer owns the concrete cast.
- **Ownership write orchestration.** The 04 §3.3 sequence is a ports-level
  service `OwnershipWriteService.resolveAndWrite(projectId, addresses, claims)`
  returning `{ regions, claims }` or
  `EnvironmentError | ResourceOwnershipRepositoryError | ResourceResolutionStale`.
  Implemented by the SQLite adapter in P1-007 and exercised by tests; P1 has
  no ownership command.

## 7. Out of scope

- Execution/lease ports (P2), including `SessionRepository.appendEntry`.
- Provider/Tool/Blob/Projection ports (P3+).

## Native OS Sandbox accepted ports

Extend the existing `PermissionGrantRepository` only for this exact contract:
`findById(permissionGrantId)` returns the complete CAPA v2 projection and
`findSandboxPolicyGrantIssuerProvenanceByGrantId(permissionGrantId)` returns
the immutable issuer provenance in a TransactionScope. A provenance insert
operation is callable only from the authenticated `GrantPermission` handler
inside CommandGateway. Resolver composition may read the exact Grant and
provenance facts; the pure P12 Resolver itself remains `R = never`. P1 also
owns transactional `SandboxPolicyDecisionStore` exact-key read/write. No
generic authorization port is added.

## Linux workspace networking V2 governance supplement

Accepted under `ACCEPT_LINUX_WORKSPACE_NETWORK_V2`; proposal SHA-256 `9801a907a540a7ea2ec5a68e2ac197105c4bf5a1b00191c3801e888dded59111`.

This supplement owns only the Linux V2 changes assigned to this document. For V2 it supersedes the conflicting first-release Windows-only, blanket loopback-denial, V1 broker and discovery clauses; V1/Windows/historical evidence retain their original meaning. It creates no Supported result, migration execution, preserved-database upgrade or release claim. Service registration, cross-command service reuse and preview still require their separate exact contract and acceptance; the full product goal is not reduced. DID 1.66 owns the closed technical definitions.

##### 8.2 Command、snapshot、receipt 与内部 process policy

- 新 `OsEnforcedPolicySummaryV2` 等于当前 `OsEnforcedPolicySummaryV1` 的**全部现有
  字段、类型和键序**，仅 version 改为 2，networkBrokerControls 改为上述 V2；kind
  仍为 `OsEnforced`。必须绑定 Linux、linux-bwrap 和精确 V2 registry rule digest。
  旧 `TrustedLocalUnconfinedV1` 不变，不获得 version 2。
- 新 `SandboxPolicyDecisionCommittedInternalV2` 等于 V1 的完整字段和键序，仅
  version=2、effectivePolicySnapshot=上述 V2。原 receipt 的命令身份、指纹、
  时间和单次消费不变；旧命令重放只返回它原来的 V1 结果，不能被重新物化成 V2。
- `DecideSandboxPolicy` schema 2 复用 schema 1 的全部输入字段、精确 authority/
  revision/CAS/选择合同，只允许上述 V2 Linux OsEnforced 分支。schema 1 只能物化
  原 V1；schema 2 不能生成 TrustedLocal。模型不能提交受信规则、控制或资格结果。
  新候选使用显式 policySchemaVersion=2，UI 转发该版本；缺失/未知版本拒绝，
  不从字符串 providerId 猜测版本。
- `SandboxEnvironmentBasisV1` 及其字节保持不变：相同 mounts/authority/registry
  输入仍得到原摘要。完整 effective-policy 摘要含 version 和 V2 controls，结合
  registry 内 V2 rules digest 绑定不同语义；不得用旧 policyDigest 验收新策略。
- 新内部 `OsEnforcedSandboxProcessPolicyV2` 与现有 process policy 具有相同现有
  字段和约束，kind 为 `OsEnforcedProcessPolicyV2`，另含唯一新增字段
  `networkBrokerControls: SandboxNetworkBrokerControlsV2`。它是进程内类型，不是
  新 wire 协议或 durable record。现有 SandboxProcessPort.run 的 request.policy
  扩展为 V1/V2 closed union；V2 adapter 不接受 V1 假冒 V2，反向亦然。
- V2 broker binding 不含 certificatePath，不产生 CA 文件；提供私有 socket、
  固定 relay artifact、端口及 close 生命周期。绑定只在精确隔离执行中使用，
  不从模型输入解析主机路径。旧 V1 binding 与执行分支保持原义。


## 2026-11-16 Durable Workspace sandbox authorization storage supplement

Engineering landing of the already accepted Workspace permission lifetime and
bounded Parent allocation decisions; package
`docs/proposals/2026-11-16-workspace-sandbox-authorization-storage.md`,
SHA-256 `3beeec1c67f3b4013431f9971d5dee562294a218a9a00032c62e77de9129d21c`. Runtime integration and installed qualification remain open.

WorkspaceSandboxAuthorizationStore exposes findCurrent(Project, Workspace) and
appendCommitted(record), both TransactionScope-bound. appendCommitted is a
Gateway-only writer. The adapter proves each read against the exact committed
Authorization command receipt and fails corruption closed. Identity is Project +
Workspace + authorizationRevision, with immutable canonical JSON and exact cause.


## 2026-11-16 supplement: Workspace authorization commands and human revocation

Product authority: explicit project-owner answers on persistent Workspace
authorization, bounded direct-Parent allocation and user-only reversal of
human revocation. Engineering landing package: `docs/proposals/2026-11-16-workspace-authorization-commands-and-revocation.md`; SHA-256
`07e2552d26ff41a1b23df398260cda6752c81f4fe0fe5f275eda54f291e65e7c`.

WorkspaceSandboxAuthorizationStore returns the current immutable head only
when its full canonical fact matches the exact committed schema1 command result
{ authorization }. Unknown/malformed/mismatched facts or receipts are corruption,
not absence. appendCommitted is Gateway-only, TransactionScope-bound and requires
the exact successor; a stale append returns a typed store revision conflict.
The same transaction reads all Parent source heads, target Workspace facts and
trusted time before appending. Neither cached snapshots nor a historical head
can replace this validation.

## 2026-11-20 Workspace default execution capability supplement

Accepted under `ACCEPT_WORKSPACE_DEFAULT_EXECUTION_CAPABILITY`; fixed proposal
`docs/proposals/2026-11-20-workspace-default-execution-capability.md`, SHA-256
`8503d5c2663d3098171c57646b78a8408d5f1a28dc7f3cf3a37f2181fddaed66`.

The Workspace authorization store and initialization port must support a
system-created baseline head for a newly admitted Project/Workspace after the
exact qualified Linux provider is confirmed. Its record is Workspace-scoped,
uses the current boundary/policy revisions, selects `WorkspaceWrite` and the
qualified controlled network mode, and is distinct from a human Grant or a
Parent allocation. Replaying initialization is idempotent; it cannot overwrite
a current user Revoked head or silently widen a changed boundary.

The port contract must expose enough typed state for the composition to
distinguish `NotInitialized`, `Granted`, `Revoked`, `Expired` and
`Unavailable` before admitting an executable Work. Existing exact
per-Execution policy binding remains downstream of this persistent fact.
