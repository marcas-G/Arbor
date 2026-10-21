# P1 — 03 Transaction Model

**Authority:** DID v1.6 §7.4, §12.6, §6.3, §6A.15, §9.1, §9.7; accepted DID v1.52 F23 P6 operator rebuild / v1 route-command qualification.
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Implements:** concrete transaction mechanism; supports P1-DG-02 / P1-DG-04.

This document freezes the concrete transaction interface that DID §7.4 leaves
open ("v1.2 不冻结具体机制，只冻结可观察保证"). It does not change the DID.

## 1. Observable guarantee (from DID §7.4 / §12.6)

```text
One semantic Command = ONE transaction-scoped DB session.

Within that scope:
  all participating Repository reads/writes
  authoritative fence validation (ExecutionOrigin)
  Command resolution
  DomainEventJournal append
observe/write through the same transactional DB session.
```

A `transact()` wrapper around repositories that each open their own
connection is **not** compliant.

## 2. Frozen mechanism — `TransactionScope` service

Chosen from the three DID options: **TransactionScope service**, implemented
as an Effect `Context.Tag` whose service carries the **live adapter session**
(not a bare string), so the type system enforces propagation.

```ts
// owning package: ports
class TransactionScope extends Context.Tag("arbor/TransactionScope")<
  TransactionScope,
  { readonly session: AdapterSession }   // opaque; domain/application never see SQL
>() {}

interface TransactionPort {
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R | TransactionScope>
  ) => Effect.Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

Rules:

- `TransactionPort.transact` opens exactly one DB transaction and provides
  one `TransactionScope` to `body`.
- Every P1 Repository method **requires `TransactionScope`** in `R` and never
  opens its own connection. Repository methods take no raw `sessionId`.
- The adapter issues `BEGIN IMMEDIATE` explicitly (not the driver's default
  deferred transaction) to guarantee write serialization.
- Nested `transact` is forbidden; the adapter detects re-entry by the presence
  of a `TransactionScope` in the environment and rejects it.
- **Every `transact` scope uses `BEGIN IMMEDIATE`** (SQLite), including command
  scopes that append events / allocate the project sequence. This serializes
  writers and makes sequence allocation safe (see `05-event-journal.md`).
  `foreign_keys = ON`, WAL, `busy_timeout` (DID §9.1).
- The transaction is the **only** place `commands` rows, canonical state, and
  `domain_events` are written.

## 3. Sequences

### 3.1 Successful / replay / conflict (single transaction)

For an External request, transport authentication, strict wire-v1 codec,
Handler schema/fingerprint derivation, exact Actor/Principal binding, and the
P12 Resolver visibility check complete in Application/Composition **before**
`TransactionPort.transact` begins. This boundary performs no receipt read.
Once the Gateway opens the transaction, the existing receipt-first sequence
below remains intact: `BEGIN IMMEDIATE` reads and compares the exact receipt
tuple before the final in-transaction authority check. It is the sole receipt
linearization point. The direct-child AssignWork Command/Work/Event/binding/
ActionApproval atomic transaction under DID §6A.16/§9.9 is unchanged.

```text
transact {
  load commands row by command_id
  if row exists (Committed | TerminalRejected):
      if stored.semantic_request_fingerprint == incoming.fingerprint
         AND stored.schema_version == incoming.schemaVersion
         AND stored.fingerprint_algorithm_version == incoming.algorithmVersion:
           return existing Receipt            // no domain re-execution
      else:
           return TerminalRejected(IdempotencyConflict)   // deterministic replay response; the existing row is not overwritten
  if row absent and authority is RetryVerificationReplayOnlyAuthority:
      fail PersistenceCorruption<"CommandStore">  // roll back; no attempt/handler/write
  if ExecutionOrigin:
      fence check   (see §4)
      stop check    (see §4)
  authority exact-match (01 §2A: VerifiedCommandAuthority vs
                         envelope / submissionContext / fingerprint / payload)
      mismatch -> TerminalRejected(AuthorityDenied)   // §3.2 path, no event
  load canonical state (required aggregates)
  preconditions / invariants
  apply domain transition
  write canonical state
  if this is a successful RetryVerification:
      write immutable retry_verification_origins fact in this transaction
  write Committed receipt + result_json
  append Domain Events (Committed only)
  recordResolvingAttempt(Committed)
}
COMMIT
```

The existing-receipt branch precedes the final in-transaction authority check:
an authorized resolution is replayed **without** re-running the authority
predicate (P1-DG-11). External requests have already passed the P12 current
visibility/authorization check before this Gateway transaction begins.
Authority is not part of `semanticRequestFingerprint`. The P8
`RetryVerificationReplayOnlyAuthority` is a narrow exception to the absent-row
continuation only: it is usable on an existing exact receipt, while the
existing-row tuple mismatch still returns `IdempotencyConflict`; an absent
receipt fails closed as `PersistenceCorruption<"CommandStore">` and cannot
fall through to the handler.

For the exact-tuple existing-receipt branch, the Application decoder specified
by `01-command-contracts.md` §3A runs inside this same transaction, after the
tuple comparison. If its result/error JSON or DTO shape fails, the transaction
rolls back and returns the non-command
`PersistenceCorruption<"CommandStore">` failure; the existing row is
unchanged, no handler/canonical/event/receipt write occurs, and no
`recordRetryableAttempt` is written. This failure is not a retryable
`TransactionOperationalFailure` and cannot become a receipt or
`TerminalRejected`. No data repair is attempted.

Atomic: canonical state, optional P8 retry origin (for successful
RetryVerification), Committed receipt, and Events.

**FT-DG-01 OPEN-3 operational successor:** a non-empty Profile CreateProject
also writes its `WorkspaceResourceActivationIntent(Pending)` and
`WorkspaceResourceActivationChanged(Pending)` in this same command scope, in
addition to the unchanged ProjectCreated/WorkspaceCreated v1 events. These
remain committed together; later activation failure is post-commit and cannot
roll back this command or manufacture a second receipt. The separate P11
activation operation resolves the persisted boundary before opening its write
scope, then commits the claim set + Pending→Active CAS + Active event in one
`BEGIN IMMEDIATE` transaction. It does not nest the existing self-transactional
`OwnershipWriteService.resolveAndWrite` call.

### 3.2 Terminal semantic rejection (single transaction)

```text
transact {
  load commands row
  consistent canonical read
  evaluate terminal rejection
  write TerminalRejected receipt + terminal_error_json
  recordResolvingAttempt(TerminalRejected)
}
COMMIT
```

No Domain Event. `terminal_error_json` carries a `CommandRejection`
(DID §6A.15).

No v1 P1 command changes canonical Work owner or Workspace Parent, so the
command-level UnboundLegacy route-move/terminal-rejection branch and its
receipt-commit crash qualification are N/A for v1 only. This does not make the
same-key route helper or future-command invariant N/A. If a future separately
governed P1 command changes the recipient and cannot move the stable Inbox key
in the same command transaction, it uses this ordinary terminal-rejection
path with the existing `AuthorityDenied` (or narrowest existing typed
rejection). The transaction commits the normal `TerminalRejected` receipt and
resolving attempt, while committing no canonical Work/Workspace/owner mutation,
Domain Event, Inbox route mutation or UnboundLegacy disposition mutation. The
same CommandId and tuple replays this receipt; a different CommandId
independently reaches the rejection. A crash before COMMIT leaves neither the
rejection receipt/attempt nor canonical changes; a crash after COMMIT preserves
the receipt/attempt and still leaves canonical/Inbox/disposition state
unchanged. This path enters through Gateway and performs no pre-Gateway receipt
read/rejection. If a future Inbox move can be done, it shares the P1 command
transaction with the canonical owner/Parent change.

The accepted P6 operator rebuild is not an Application Command or online
Gateway transaction. The local operator CLI runs only against the stopped
current schema-48 primary under P39 `MaintenanceExclusive`; it invokes the
existing P6 Inbox repository helper in a single `TransactionPort` transaction
on the same P39 primary SqlClient connection. P39's report sidecar and writer
lock are separate infrastructure files; the JSONL manifest is separate audit.
The operation changes only stable-key Inbox projection rows and never writes a
Command receipt/attempt, Domain Event or canonical owner/disposition row. The
P39 sidecar's pre-permit `wx` creation/validation may persist on lock refusal,
but the primary, P6 rows and JSONL manifest remain untouched.

### 3.3 Retryable operational failure (no authoritative resolution)

```text
transact { ... } ROLLBACK
→ no commands row written / unchanged
→ in a SEPARATE short transaction (outside the failed scope):
     CommandStore.recordRetryableAttempt(commandId, failureKind, startedAt, settledAt)
→ same CommandId may retry with unchanged semantic request
```

`TransactionOperationalFailure` (e.g. `PersistenceUnavailable`, `SQLITE_BUSY`,
`SQLITE_BUSY_SNAPSHOT`) is **not** a `CommandRejection` and never produces a
receipt. The attempt trace write uses its own connection/transaction; it is
non-authoritative and may be lost on crash (see `06-recovery-matrix.md`).
Failure of that best-effort trace must not replace, defect, or otherwise mask
the original typed `TransactionOperationalFailure`.

Only the frozen `TransactionOperationalFailure` class follows this §3.3
retryable-attempt path. A receipt JSON/schema `PersistenceCorruption` is a
non-retryable integrity failure and must not be relabeled as this class or
recorded by `recordRetryableAttempt`.

### 3.4 Concurrent duplicate attempt (commit-conflict protocol)

DID §7.4 requires one authoritative resolution. Protocol:

```text
attempt A and attempt B race on the same command_id
- both begin (BEGIN IMMEDIATE serializes; B waits or gets SQLITE_BUSY)
- winner commits the commands row
- loser, on COMMIT:
    * PK conflict on commands.command_id  OR
    * SQLITE_BUSY / BUSY_SNAPSHOT (operational)
  -> ROLLBACK the loser scope
  -> re-read commands row by command_id
       exists + fingerprint matches  -> return existing Receipt
       exists + fingerprint differs  -> IdempotencyConflict
       absent (winner still in flight / operational) -> bounded retry, new CommandAttempt
```

No blind retry after an authoritative conflict.

## 4. Fence and stop checks (P1 hook; P2 lease)

Two **independent** checks (DID §9.7 / §6A.15):

```text
1) fence validation (ownership/generation)
     invalid -> CommandRejection.FencingRejected
2) stop / quiescence admission
     fence valid but stopRequestedAt != null
     -> CommandRejection.ExecutionStopping   (NOT FencingRejected)
```

The checks must be evaluated separately so the caller can distinguish the
outcomes (exact SQL in `04-sqlite-schema.md` §4). `FencingRejected` and
`ExecutionStopping` are **terminal**: they are persisted via the §3.2 path as
a `TerminalRejected` receipt (no Domain Event), per DID §9.9. P1 provides the
hook; P2 provides lease acquisition/renewal/loss and the generation source. In
P1 all commands are `External`/`System`, so the hook is inert and tested with
a stub.

For DID v1.20 AgentLoopStep takeover this terminality remains per `CommandId`.
`07` freezes the outer logical ledger and permits a new owner to create a new
generation-scoped CommandId only after reading existing receipts and proving
the logical action is still eligible. It is never a retry of the terminal
CommandId and never overwrites its receipt.

> **P2 evolution (DID v1.7 G1):** `FenceStopCheck.check(context, stopAdmission)`
> receives an explicit `StopAdmission` ADT; `QuiescenceControlMutation` is
> admitted after `stopRequestedAt != null` while still being fence-checked. See
> `docs/design/implementation/P2/01-command-contracts.md` §3 and `02` §4.

## 5. Effect channels

```text
TransactionPort.transact
  A = body success
  E = body E | TransactionOperationalFailure
  R = (body R minus TransactionScope)

Repository method
  A = typed result (ADT / Option where absence is a normal alternative)
  E = <RepositoryName>Error        // per-repository semantic error, NOT a catch-all
  R = TransactionScope
```

- There is **no** universal `RepositoryError` (DID §6A.2 / §0A.6). Each
  repository declares its own narrow error (e.g. `ProjectRepositoryError`).
- CAS failures are typed errors of the owning repository (e.g.
  `RevisionConflict`); they are not a generic persistence error.
- Adapter-specific errors (`SqliteError`, …) are translated at the adapter
  boundary and never appear in a port `E` (DID §0A.6).
- `CommandHandlerError` is the closed union of normalized Port failures that
  command handlers may expose. A handler must not convert a declared
  repository failure into a defect merely because that repository was added
  after P1. Such a failure rolls back the transaction and produces no Receipt.

### 5.1 Implementation boundaries

The Application implementation keeps these responsibilities separate while
preserving the public `gateway.ts` export surface:

- `gateway-contracts.ts`: command/gateway Effect contracts and error union;
- `command-handler-registry.ts`: command-type lookup;
- `project-admission.ts`: bootstrap/open/closed lifecycle admission policy;
- `fence-stop.ts`: execution-origin admission service contract;
- `command-receipt.ts`: stored Receipt decoding and Receipt construction;
- `gateway.ts`: transaction orchestration only.

The SQLite adapter separates Project, Workspace, Work and Session repositories
by aggregate. `repositories.ts` is a compatibility barrel only. This is an
implementation boundary; transaction scope, SQL, CAS and Port contracts are
unchanged.

## 6. Open items closed here

- Concrete transaction mechanism (`TransactionScope` Effect service).
- `BEGIN IMMEDIATE` for all write scopes (with `05`).
- Single-transaction command resolution + fingerprint comparison (with `01`).
- Concurrent duplicate-attempt protocol.
- Fence/stop two-check split (with `04`).

## 7. P0 artifact evolution (P1 owns)

P1 evolves these P0 artifacts (P0→P1 contract evolution, not a P0 reopen):

```text
CommandResolution<R>          -> CommandResolution<Result, Rejection>
                                 (Domain instantiates DomainError; Application CommandRejection)
semanticRequestFingerprint    -> SHA-256 canonical v1 (P0 32-bit FNV-1a superseded)
work.assignWork branch        -> RetirePreconditionFailed superseded by TerminalLifecycleMutation
```

## 8. Out of scope

- Lease lifecycle (P2).
- Exact SQL text for fence/CAS (04).
- Offset/projection transaction boundary (05).

## Native OS Sandbox accepted transaction amendment

For exact-scope `GrantPermission`, within one Gateway transaction validate
P12 authority, configured issuer/non-subject, exact Execution target/tenant,
finite expiry and current operator-config revision/digest. Write order is
frozen P1 §3.1:

```text
PermissionGrant
→ SandboxPolicyGrantIssuerProvenanceV1
→ Committed receipt / commands row
→ existing PermissionChanged event (unchanged)
→ SandboxPolicyGrantIssued event (additive)
→ atomic commit
```

The provenance→`commands(command_id)` foreign key is deferred until commit.
Every item is one transaction. A `TerminalRejected` GrantPermission writes
no Grant, provenance or event. Exact command retry returns the receipt and
does not duplicate provenance/event.

For `DecideSandboxPolicy`, after resolver preflight and receipt-first replay,
the Gateway transaction re-reads the current Grant with
`PermissionGrantRepository.findById` plus exact issuer provenance, compares
all bound fields and current P5 config digest, validates canonical
Execution→Project/Workspace/Episode and trusted transaction time, then writes
the next immutable policy revision, the Committed receipt/commands row, and
then `SandboxPolicyDecisionRecorded`, followed by atomic commit. A
`TerminalRejected` decision writes no decision or event. A Grant revoke
racing either command is serialized by the existing Gateway transaction
boundary.

## Accepted AH14 P9 fact and resolution transaction boundary (DID v1.49)

Accepted token `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`,
proposal raw SHA-256
`71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`,
accepted 2026-10-17. The P9 legacy-adoption evidence failure event and
immutable fact share one current-lease-fenced `TransactionScope`: before
commit neither exists; after commit both exist; storage failure claims no
durable Attention. Exact retry returns the same pair, and a conflicting tuple
is a typed invariant failure.

Evidence-driven resolution writes the P9 resolution event/fact atomically
with the ordinary AgentLoopStep adoption/progression it authorizes. The
resolution must prove the entire original non-empty decoded action set and
exact terminal P4 evidence under P9 `07`; partial or conflicting proof commits
neither resolution nor progression. Exact replay returns the immutable
resolution, and a different tuple cannot replace it. This amendment does not
alter `TransactionScope`, `BEGIN IMMEDIATE`, shared transaction semantics, or
authorize implementation/migration.

## Accepted full-chain DecideSandboxPolicy linearization (V21)

For this command, initial receipt lookup is advisory only. Execution order is:
authenticated human + exact P12 CAPA authority/provenance preflight; compute
the frozen P1 semantic fingerprint; advisory prior receipt lookup; if absent,
perform read-only P11 resource/mount and P5 authority/provider preparation
outside the SQLite transaction; then enter `BEGIN IMMEDIATE` and perform the
final receipt lookup, which is the sole linearization point. If an identical
receipt now exists, return it without re-reading or recapturing source state;
different fingerprint is the existing idempotency conflict. If absent,
revalidate trusted GatewayNow, exact live Grant and immutable issuer
provenance, current authority/operator/provider bundle revisions and digests,
Execution/Episode identity and `episode_revision`, workspace/resource/CAS
preconditions, exact current basis and expiry under this transaction. Any
changed expected source is the existing durable TerminalRejected
`StaleSandboxPolicyInputs` receipt, with no decision/event.

Commit the immutable decision row, bounded `SandboxPolicyDecisionCommittedInternalV1`
result in existing `commands.result_json`, exact receipt and
`SandboxPolicyDecisionRecorded` event in the same `BEGIN IMMEDIATE` transaction.
The row `policy_digest` is SHA-256 of the exact canonical full
effectivePolicySnapshot variant carried by the strict result codec;
`decision_command_id` is the join
anchor used to validate the command result/receipt. P9 restart strictly
decodes the same result and checks row identity and digest; mismatch is
corruption/fail-closed. No BlobStore, envelope table, or migration 0051 is
introduced. No P1 transaction holds over provider or filesystem probing.

If read-only preparation fails transiently before transaction, perform a final
receipt lookup before returning: identical receipt replays, different
fingerprint conflicts, and absent receipt yields the existing retryable
`SandboxPolicyPreparationUnavailable` with no Command row/receipt or
TerminalRejected. Trusted authority/grant invalidity remains the existing
TerminalRejected `AuthorityUnavailable`. A pre-commit process crash permits
retry to recapture only if every caller expected revision/digest remains
current; post-commit retry replays the exact persisted receipt. `latestCommittedPolicyRevision`
is the latest row even if expired/superseded (0 only if no decision); the
next request CASes against that value. `expiresAt` satisfies
`now < expiresAt <= exact Grant.expiresAt`, and the Execution must be
nonterminal at commit.

The failure domains stay disjoint: startup source/bundle/high-water/registry
canonical-load errors are SandboxAuthorityLoadErrorV1 and disable command
authority; qualification/evidence missing or invalid during Decide preflight
is durable TerminalRejected(SandboxAuthorityUnavailable), with no decision or
event. Evidence/blob/provider loss after the decision is committed is a P4
typed provider-unavailable outcome and may only then enter the existing P9
fact/queue path. None is converted into another class or TrustedLocal
fallback.

## Accepted V3 sandbox producer inputs at the existing linearization point

On a new DecideSandboxPolicy CommandId, the existing read-only preparation
outside `BEGIN IMMEDIATE` uses one immutable P5 SandboxAuthorityBundleV2
snapshot and P11's complete current ResourceBoundary (not a requested-address
subset). P4 derives ResourceBoundaryDigestV1, object-valued V21
SandboxTargetRefV1 refs, deterministic filesystem mounts/access,
NetworkPolicy digest/broker controls, configured profile limits, and the
closed effective-policy variant. The selected operatorConfig revision/digest
and full V2 bundle revision/digest are carried exactly into the internal
snapshot; no authority config is reconstructed from a default.

The final `BEGIN IMMEDIATE` receipt check and CAS remain the sole
linearization point. It revalidates the existing caller-visible boundary,
Workspace, Execution/Episode, policy, authority-bundle, operator-config and
provider-registry revisions/digests against the snapshot inputs. A changed
source is the existing `StaleSandboxPolicyInputs` receipt; it cannot commit
a decision with a mixed producer snapshot. Same-CommandId receipt replay
returns the persisted result before reading current boundary or operator
configuration, per V21. P1 performs no network, Pref64, process, or filesystem
probe inside the transaction. No additional revision, table, event, migration,
authority field, or transaction is introduced.

## Accepted Option A provider-tuple selection at the V21 linearization point

Under `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A` (proposal
SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`), the
read-only preparation uses the exact OsEnforced selector fields
`providerId,providerVersion,capabilityRevision` to locate one row in the
verified P5 V2 registry, matched against trusted currentHost, profile,
network mode, codec version and enforcement-rule-set digest. The final
transaction rechecks the exact expected authority bundle/operator config and
provider-registry revision/digest CAS as before and only commits the
prepared summary if those source identities remain current. It does not read
the P5 source or probe a provider inside the transaction. A stale source
remains the existing durable `StaleSandboxPolicyInputs` receipt; an absent or
non-Supported exact selector is the existing durable
`SandboxAuthorityUnavailable` rejection, with no decision/event. No schema,
receipt, event, or transaction-order change is made beyond the handler schema
2 identity defined by P1/01.

## Accepted pre-intent P3 Action/approval CAS (2026-10-21)

For the accepted pre-intent CandidateRead source, the existing read-only P1
preparation outside `BEGIN IMMEDIATE` carries the closed P4
`SandboxPolicyPreIntentRequirementV1` for the unique current Pending P3
Executable Action and its exact Pending/unconsumed P4 Executable approval.
This in-memory source tuple consists exactly of the DTO's version,
Project/Workspace/Execution/Episode/episode-revision, pinned ProviderTurn/Step/
LogicalAction/actionIndex/callRef, Action revision/inputHash/toolName/
toolVersion, and approvalId/Pending-state/revision/consumedBy-null/immutable
expiresAt fields. Equality is structural and field-by-field across that exact
typed tuple; it is not encoded, hashed, serialized, persisted, returned by
P10/P13, accepted from the caller, or included in the P1 semantic request
fingerprint. No source-codec version, digest, KAT or source digest field is
introduced.

P1's read-only preparation independently resolves the exact pinned action's
arguments to path-free TargetRefs/access through the existing P11 resolver,
complete current ResourceBoundary and current Workspace ownership, outside
the write transaction. These TargetRefs/access are not serialized into the
pre-intent source tuple. The P1 preparation and final CAS reuse only the
existing `expectedWorkspaceRevision`, `expectedResourceBoundaryRevision`,
selected-profile `expectedSandboxHandleBindingDigest`, and existing P5
authority/operator/provider-registry revision/digest inputs. The P3
inputHash/tool identity pins which request was resolved; the existing P11
ResourceBoundary/handle CAS pins current target/access derivation. No new
TargetRef/target-resource digest or target-source CAS is added. All are
server-derived facts, not command payload fields or public CandidateRead
fields.

At the existing final receipt-first linearization point, P1 re-reads the exact
P3 Action/P4 approval rows through transaction-scoped source ports and
structurally compares every field of the prepared
`SandboxPolicyPreIntentRequirementV1`; it does not open a nested transaction
or perform filesystem/P11 resolution or provider I/O in that transaction.
After the exact P3/P4 source matches, the existing P1 current-preconditions
CAS compares WorkspaceRevision, ResourceBoundaryRevision,
SandboxHandleBindingDigestV1 and P5 authority/operator/provider-registry refs.
P1 compares approval
`expiresAt` with the one trusted GatewayNow for that final transaction, so
time-only expiry is stale even if the persisted approval row has not yet been
advanced by its expiry worker. When both are stale, Action is checked and
reported first; otherwise an approval identity/state/revision/consumption or
expiry mismatch is reported as `ExecutableApprovalRevision`.

A fresh CommandId whose source proof changed commits the existing durable
`TerminalRejected(StaleSandboxPolicyInputs)` receipt with safeDetails field
`ActionRevision` or `ExecutableApprovalRevision`, and no decision/event. This
source check does not consume approval. Same-CommandId committed receipt
lookup remains before source re-read and returns exact prior result bytes;
the source proof is excluded from semantic request fingerprint. No candidate
ID, ActionId, ApprovalId, source digest, safe numeric revision, expiry,
decision payload/result field, table, schemaVersion, migration or new
transaction is introduced. P4's normal first effect-intent transaction
remains the sole approval-consumption boundary.
