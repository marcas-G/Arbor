# F23 P6 Operator UnboundLegacy Inbox Rebuild and v1 Route-Move N/A — Draft

Status: **PROPOSAL ONLY — NOT ACCEPTED; NO IMPLEMENTATION AUTHORITY**

Prepared against `C:\Users\ThinkPad\.codex\worktrees\p4-final-release-fixes\Arbor`
at `HEAD 5724895727c5d7bda180547ba87a603233f469d1`. This document does not
change `docs/design/**`, code, migration registries, or production behavior.

Recommended manual acceptance token:
`ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`

If accepted and landed by the manual governor, implementation still requires
the separate token:
`AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION`.

## Decision requested

The accepted P8/P6 mechanics require durable UnboundLegacy Inbox materialization
and rebuild from permanent dispositions/current canonical route facts. The
implementation-gap audit found no existing P1 command that changes
`works.workspace_id` or `workspaces.parent_workspace_id`, and no production
`rebuildProjection` entry point. Do not weaken the route contract by labeling
the rebuild N/A, and do not invent a v1 route-move command to manufacture a
qualification subject.

This proposal recommends two bounded decisions:

1. **Owner/Workspace Parent route-move command is N/A in v1.** There is no
   canonical owner-mutation command to connect to the same-transaction helper.
   No route mutation or crash claim is made. Any future command that can change
   a Work owner or a Workspace Parent requires separate governance and must
   reuse the existing same-transaction stable-key Inbox route helper; it may not
   introduce an asynchronous route window.
2. **Production rebuild is required, not N/A.** Add a local operator-only,
   offline P6 Inbox rebuild CLI. It runs only with the daemon quiesced, on a
   validated current schema-48 database, under the existing P39
   `MaintenanceExclusive` permit/writer lock. It invokes the existing
   `RetryVerificationOriginRepositoryService.rebuildUnboundLegacyInboxProjections`
   through a `TransactionPort` transaction. It is neither an Agent/Web/model
   tool nor a P10 Attention source.

The first decision removes only the currently nonexistent route-command
qualification row. It does not remove current-route authorization, stable-key
integrity, rebuild, atomicity, or crash/restart requirements.

## Evidence and authority boundary

The route/rebuild gap is recorded in
`planning/results/F23-P6-owner-route-and-rebuild-design-gap.md`. The fixed
implementation plan is
`planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw
SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
The implementation result is
`planning/results/F23-permanent-replay-origin-implementation.result.md`.

Source inventory at the proposal base confirms:

- Work repository updates do not reassign `works.workspace_id`.
- Workspace repository updates do not mutate `workspaces.parent_workspace_id`;
  formation gives a newly created child its initial Parent.
- `rebuildProjection` in `adapters/persistence-sqlite/src/consumer.ts` has no
  `apps/single-workspace/src` production caller. Production P10 is the
  AttentionPoll worker and is not an Inbox rebuild owner.
- The operator helper already exists at
  `adapters/persistence-sqlite/src/retry-verification-origin.ts` as
  `rebuildUnboundLegacyInboxProjections(updatedAt)`. It is transaction-scoped,
  derives route from immutable disposition plus canonical Work/Verification/
  Project/Workspace rows, inserts missing stable keys, moves the same key,
  rejects source/row corruption, and leaves an exact route no-op unchanged.
- Schema high-water is `CURRENT_SCHEMA_VERSION = 48`. P39 supplies
  `runP39SqliteMaintenanceWithPermit`, `MaintenanceExclusive`, protected-path
  checks, and a cross-process writer lock. Its permit can enclose a continuation
  after P39 is already committed; this makes it suitable for an operator task
  without pretending schema migration is occurring.

This recommendation is limited to a new operator rebuild surface and the v1
N/A disposition for a nonexistent owner-mutation command. It does not authorize
code, migration, runtime registration, data access, database rebuild, or release.

## Proposed command and API

Operator command (exact name and argument shape recommended):

```text
pnpm --filter @arbor/single-workspace p6:inbox-rebuild --
  --database <absolute-existing-schema48-database>
  --p39-sidecar <absolute-P39-blocker-report-SQLite>
  --manifest <absolute-new-protected-manifest>

pnpm --filter @arbor/single-workspace p6:inbox-rebuild --
  --database <same-absolute-database>
  --p39-sidecar <same-absolute-P39-blocker-report-SQLite>
  --manifest <same-absolute-manifest>
  --resume
```

`--p39-sidecar` and `--manifest` are required and are distinct artifacts with
different owners and formats. `--p39-sidecar` is the P39 blocker-report SQLite
passed as `P39SqliteMaintenanceCommandOptions.sidecarFilename`; it uses the
existing P39 report database schema/application id and is not the operation
audit. P39 currently opens/creates it through `SqliteClient.layer` and
initializes an empty database transactionally; this is not an exclusive
filesystem `wx` reservation, so the accepted operator contract must explicitly
allow that bounded pre-lock P39 side effect. `--manifest` is the protected
append-only P6 JSONL operation ledger. The CLI rejects aliases among primary
DB, P39 sidecar, JSONL manifest, P39 writer lock, SQLite sidecars and protected
application DBs. Resume binds both sidecar and JSONL manifest identities to the
original operation.

The package command is local and operator-invoked. No daemon HTTP route,
WebSocket message, browser affordance, model-visible tool, AgentAction,
Application Command, or P10 event/Attention type is added. The application
entry point should be named `runP6UnboundLegacyInboxRebuild`; it is not
registered as an online runtime service. It validates the database and
operator manifest, obtains the existing P39 maintenance permit, and invokes
the adapter repository rebuild once inside one `TransactionPort.transact`.

The CLI accepts only the current primary database as an existing canonical
absolute path, a P39 sidecar path (new empty or already-valid P39 report DB),
and a distinct new manifest path (or the exact existing manifest with
`--resume`). Reject relative paths, symlink/reparse components, aliases,
non-local/unsupported filesystem profiles, protected-store collisions,
database sidecars used as evidence, missing primary files, and schema versions
other than 48. Never open the primary in a way that initializes or upgrades its
schema. The CLI does not take `--force`, a project/workspace/recipient
override, a receipt/event source, or partial selection; the unit of work is all
durable P6 UnboundLegacy dispositions in that database.

## Execution and authorization contract

1. Require explicit offline operator invocation and the same supported local OS
   identity/profile enforced by P39 protected-path checks. The operator must
   stop the daemon first. First validate canonical paths and aliases for the
   primary, JSONL manifest, P39 sidecar and P39 lock (validate a new manifest's
   parent/absence without creating the file); then the existing P39 adapter
   validates and opens `--p39-sidecar` **before** writer
   lock acquisition. If the sidecar is a new empty file, P39 may initialize its
   blocker-report SQLite schema transactionally before attempting the lock. If
   any RuntimeShared holder keeps `MaintenanceExclusive` unavailable, fail
   after the established bounded wait. P39 may also initialize its separate
   rollback-journal writer-lock database before trying `BEGIN EXCLUSIVE`; it
   contains only the P39 lock identity row. These P39 infrastructure-file
   initializations are the only allowed pre-permit persistent effects: the
   primary DB must not be opened, the JSONL operation manifest must not be
   created or appended, and no P6 Inbox/canonical row may change. A valid initialized
   sidecar may remain for retry; never auto-delete it. If report-sidecar
   validation/initialization fails, close its connection, fail before lock/JSONL
   manifest/primary, preserve any created artifact for review, and retry only
   when the P39 validator accepts the exact report schema. If a failed/crashed
   initialization left a sidecar the validator rejects, preserve it; after
   operator inspection, a new attempt may name a different new sidecar path.
   Do not rename/delete/repair it automatically or claim the JSONL audit
   manifest covers this pre-permit side effect. Likewise, a valid
   `p39_writer_lock` file/schema may remain after permit-acquisition failure;
   it is P39 infrastructure, not an application or P6 write.
2. The existing P39 adapter next constructs (but does not yet open) its primary
   service, acquires `MaintenanceExclusive`, then invokes `beforeMaintenance`
   under that exact permit. First validate target identity, schema version 48,
   current descriptor/schema-prefix signature, required F23 relations/Inbox
   columns, `PRAGMA foreign_key_check`, and canonical-input digest. Only after
   these checks may the operator create/validate the JSONL manifest header and
   append `Prepared`. A schema/prefix refusal must leave the JSONL manifest
   untouched. Return “P39 already committed” only after both validation and
   manifest preparation. Do not run a schema migration or the legacy P39 gate
   against schema 48.
3. Hold the permit through manifest validation/reconciliation, the P6
   transaction, same-connection postcondition checks, JSONL Committed append,
   primary connection close, and permit release. For this existing P39 API path,
   do not supply `afterPrimaryClosedNoOp`: its schema-48/P39-already-committed
   branch returns before the continuation and would skip the rebuild. The
   operator continuation must run and verify the operation before returning;
   P39 then closes its own primary service and releases the permit.
4. The P39 continuation receives only its `P39MaintenanceSqlClient primary`
   callback value. That object is the exact underlying primary `SqlClient`
   service opened by P39 (the adapter constructs it by mapping `SqlClient` to
   the P39 callback type). At the type boundary, provide that same object as the
   `SqlClient` service, then provide both `makeTransactionPortLive()` and
   `RetryVerificationOriginRepositoryLive` from that one layer. Obtain
   `TransactionPort` and `RetryVerificationOriginRepository`; call
   `tx.transact(repo.rebuildUnboundLegacyInboxProjections(operationTimestamp))`
   exactly once. `TransactionPort.transact` issues the one `BEGIN IMMEDIATE`,
   provides `TransactionScope` to the repository operation, and owns commit or
   rollback; the helper's SQL uses that same primary SqlClient instance. Do not
   call `primary.withTransaction` around the port, manually inject a second
   TransactionScope, create another `SqliteClient.layer`, `DatabaseSync`,
   `layer({ filename })`, or primary connection, or issue `BEGIN` outside the
   port. This preserves one connection, one scope and one atomic transaction
   for all P6 row changes.

   Wiring shape (the casts adapt only the callback's type; they must preserve
   the same service object):

   ```ts
   const primarySql = Layer.succeed(
     SqlClient,
     primary as unknown as SqlClient.Service,
   );
   const txLayer = Layer.provide(makeTransactionPortLive(), primarySql);
   const originLayer = Layer.provide(
     RetryVerificationOriginRepositoryLive,
     primarySql,
   );
   const operatorStores = Layer.mergeAll(txLayer, originLayer);
   // In the provided operatorStores scope:
   const tx = yield* TransactionPort;
   const origins = yield* RetryVerificationOriginRepository;
   const count = yield* tx.transact(
     origins.rebuildUnboundLegacyInboxProjections(operationTimestamp),
   );
   ```
5. Do not duplicate the helper's route SQL in the CLI. Route derives only from
   immutable disposition plus canonical source Work/Verification/Project/
   Workspace facts. P12 human visibility is still recomputed on every read
   from current authenticated principal/governance facts; the operator rebuild
   never confers authority.
6. The transaction may only insert a missing
   `retry-verification-unbound:<commandId>` `Governance` row at revision 1 or
   move that same key to the canonical current Root/direct-Parent workspace,
   preserving `admitted_at`, incrementing revision exactly once and setting
   `updated_at` from the one operation timestamp. Exact route match is a no-op.
   Any foreign/mismatched source, duplicate key, consumed/conflicting row,
   unavailable recipient, or unsupported disposition aborts the whole
   transaction. Do not delete, consume, acknowledge, widen, or rewrite entries.
7. Canonical Projects, Work, Workspace, Verification, Commands, Events,
   `retry_verification_origins`, and `retry_verification_legacy_dispositions`
   are read-only inputs and must be byte/logically unchanged by the operation.
   Only the `inbox_entries` rows for exact immutable dispositions may change.
   Do not decode receipt JSON or rely on retained Events.
8. After the transaction commits, use the same P39 callback primary connection
   in autocommit/read-only queries while the permit is still held. Verify schema
   48/prefix, foreign keys, canonical-table fingerprints unchanged, every
   disposition has exactly one valid stable-key/current-route Inbox row,
   revision/admission-time invariants, and the projection counters/digest. Only
   then append the manifest `Committed` record and report success. P39 closes
   the primary connection and releases the permit when the continuation returns;
   permit release failure is not success.

“Authorization” is intentionally split: the OS/P39 maintenance gate authorizes
the operator process to mutate the offline local database; it does not create
an Arbor human principal, P8 governance decision, P1 receipt, or per-entry
application permission. The operator surface is outside user/model request
handling. If a deployment needs a separate OS identity or remote administration
profile, that requires separate governance and is refused by this v1 scope.

## Manifest and audit contract

Use a dedicated append-only JSONL format
`arbor-p6-unbound-legacy-inbox-rebuild-manifest/v1`, following the existing
P39/schema-upgrade manifest's protected path, file-identity, nonce,
canonical-JSON, hash-chain, exclusive-create, full-write, and fsync discipline.
Do not reuse a schema-upgrade manifest by fabricating migration records.

Each record carries sequence, previous hash and hash. The Created header binds:
random 256-bit nonce, operation name, canonical target and P39 sidecar file
identities, schema version 48, exact schema-prefix signature, initial logical
DB digest, manifest identity and creation time. `Prepared` binds the operation ID,
pre-write DB digest/prefix, a digest/count of dispositions and current route
inputs, and the same target identity. `Committed` binds before/after logical
digests, unchanged canonical-table digest, schema prefix, inserted/moved/no-op
counts, final key-route digest, and commit timestamp. Store no receipt JSON,
event JSON, summaries, credentials, host/path details beyond the protected
target identity, or arbitrary SQL errors in public diagnostics.

The P39 blocker-report sidecar and this JSONL manifest have separate
authorities: only the P39 adapter initializes/validates/writes the P39 report
SQLite, while only the operator command appends the JSONL operation chain. At
schema 48 the `beforeMaintenance` callback validates P39 is already committed
and returns true, so the legacy P39 migration gate and its blocker-report
writer are bypassed. The P6 rebuild operation must not append a P39 blocker
report. A valid preexisting P39 sidecar's rows remain unchanged; a new one may
be initialized as the explicitly allowed pre-lock side effect above.

The manifest is outside SQLite and cannot be made atomically durable with the
Inbox transaction. Recovery therefore relies on this rebuild being
transaction-atomic and idempotent:

- Crash after P39 sidecar validation/initialization or writer-lock DB
  initialization but before permit acquisition: either P39 infrastructure file
  may remain (with exact P39 schema), but the primary was not opened and the
  JSONL manifest is absent/unchanged; retry validates/reuses the infrastructure
  files.
- Crash after lock acquisition but before `Prepared`: no DB write started; the
  operator manifest header may or may not exist depending on whether its
  `Created` append was durable. Resume accepts only a valid hash-chain prefix
  bound to the same target/sidecar; torn records fail closed without primary
  writes.
- Crash after `Prepared` but before the DB transaction: resume validates the
  exact target/prefix/input binding and executes the rebuild.
- Crash during the SQLite transaction or before its commit: SQLite rolls back;
  resume observes the original digest and safely reruns.
- Crash after DB commit but before `Committed` is durable: resume acquires the
  same P39 permit, validates the prepared target/schema and the digest of all
  canonical F23 inputs (dispositions plus source Work/Verification/Project/
  Workspace route facts), then reruns the helper. Existing correct keys/routes
  are no-ops, so revisions are not incremented twice. It verifies one exact
  current row per disposition and records the observed final state as
  Committed. If the canonical-input digest changed, it refuses resume; the
  operator must inspect and start a new audited run.
- Crash/retry after `Committed`: resume never re-enters the mutating path. It
  verifies target identity, schema-48 prefix and the committed F23 input plus
  projection digest. If canonical inputs changed since that run, it reports
  that the record is superseded and requires a new manifest; it does not move
  rows based on the old operation.
- A different target identity, schema prefix, manifest chain, or unexplained
  canonical-input change fails closed and requires operator review; no
  `--force` continuation is provided. The manifest records the DB digest at
  each observed boundary and the unchanged canonical-input digest; a resumed
  completion records the actual post-resume digest rather than claiming the
  external manifest write was atomic with SQLite.

## TDD and qualification matrix (required before implementation closure)

All fixtures are newly created disposable schema-48 databases. Run the operator
CLI in real child processes for process/lock/crash cases. Never use retained or
online databases; no deployment/release qualification is implied.

| Layer | Required RED/PASS cases |
|---|---|
| Contract/API | CLI exposes only the operator command; no HTTP/WebSocket/model/AgentAction/Application Command; no P10 Attention writes; repository helper is the sole route implementation. |
| Path/authority | Absolute canonical DB, explicit `--p39-sidecar`, and protected JSONL `--manifest`; cross-aliases among all three, P39 lock and protected stores refuse. Report-sidecar and P39 writer-lock DB validation/initialization occur before exclusive permit and are attested by their exact P39 schema/identity (not by the JSONL operation manifest). If RuntimeShared blocks the exclusive permit, either infrastructure file may remain initialized but primary DB and JSONL manifest are byte-identical/uncreated and no P6 row changed; no P39 blocker row is written. Initialization failure occurs before primary/manifest; no automatic deletion. |
| Schema boundary | Exact current schema48 signature succeeds; versions 47/49, hand-edited version48 with wrong signature, FK violation or missing F23 relation fail closed with no DB/audit committed mutation. |
| Projection facts | Empty/missing stable row inserts once; exact row no-op; stale route moves same key once preserving `admitted_at`; Root and active direct-Parent route derive from current canonical rows; no receipt/event dependency; no human authorization copied into row. |
| Integrity | Source Work/Verification/Project mismatch, inactive/missing Parent, malformed/unknown disposition, duplicate key, wrong kind/summary/correlation/admitted time, consumed row, or preexisting route conflict aborts whole transaction; canonical rows and all Inbox rows remain unchanged. |
| Atomicity | Instrument the continuation to assert P39 `primary`, `RetryVerificationOriginRepositoryLive`, and `TransactionPort` all use the same primary SqlClient/connection; exactly one `TransactionPort.transact` supplies one TransactionScope/BEGIN/COMMIT boundary. Inject failure after at least one candidate insert/move but before commit; verify all Inbox changes roll back. Snapshot canonical Projects/Workspaces/Works/Verifications/Commands/Events/origins/dispositions before/after and require exact equality. |
| Crash/restart | Kill child after P39 report-sidecar initialization and after writer-lock DB initialization but before permit acquisition; require only exact P39 infrastructure effects, unchanged primary, absent JSONL manifest. Also kill at permit-acquired/pre-Prepared, after `Prepared`, before transaction, mid-transaction, immediately before SQLite COMMIT, immediately after COMMIT before audit acknowledgment, and after `Committed`; resume only with same target/sidecar/manifest identities. Require no duplicate key, no double revision increment, exact same final key-route digest, and correct single Committed record. |
| Competition | Two independent operator processes target same DB: one obtains P39 exclusive permit, the other waits/fails bounded with no primary/JSONL writes (while allowing only the separately stated P39 sidecar init); a RuntimeShared process cannot enter while maintenance is held. Verify lock release and a subsequent fresh-process read-only check. |
| Audit | Hash-chain/tamper/truncate, wrong identity/nonce, short/zero write, fsync error, target replacement/TOCTOU, missing manifest on resume, changed DB/prefix/input, unresolved commit acknowledgment all fail closed or reconcile by the stated cases; safe diagnostics contain no SQL, secrets or receipt/event payloads. |
| Read-after-rebuild | Public current root/direct-Parent human reads the one typed entry; foreign human/Agent remains denied; read does not consume/ack/clear; no ProviderTurn, Execution, Event, receipt, canonical write or Agent admission is produced. |
| Gates | P45/current build/typecheck/lint/architecture/core gates plus the full approved operator crash/competition matrix; report exact commands/counts and do not infer release readiness. |

The v1 owner-route command row is explicitly N/A, supported by the inventory
above. The operator rebuild is not N/A and cannot be closed by the existing
adapter test alone. If a future owner-mutation command is separately accepted,
its acceptance must add command-level old/new recipient, ordinary P1 rejection,
same-transaction helper use, and before/after receipt-commit crash cases.

## Manual landing package requested if accepted

Acceptance requires a human-governed landing in the owning frozen documents,
then an independent consistency review. The recommended landing scope is the
DID summary plus P6 `00` contract index, P6 `02`/`06` and P1 `03`/`04`: explicitly mark owner/Parent
route-move command qualification N/A for v1 while retaining the future-command
same-transaction constraint, and assign the required offline rebuild to the
P6 operator surface with its schema-48/P39/sidecar/manifest/atomicity contract. P1 `01`
and P8 `01` should be checked for references that imply a v1 owner-move command;
edit them only if needed to make the accepted contract internally consistent.
P10 remains unchanged and does not gain an Attention source. None of these
manual document updates or implementation steps is authorized by this draft.

## Explicit exclusions

- No changes to `docs/design/**` are authorized by this proposal. Manual
  acceptance must land the accepted semantics in their owning documents before
  code authorization.
- No new schema migration or high-water change; this is current schema 48 only.
- No general-purpose database repair, arbitrary Inbox cleanup, receipt repair,
  Event replay, P10 Attention, or historical owner inference.
- No online daemon operation, preserved/dogfood DB access, deployment, or
  release claim.
- No P1 owner/Parent route-move command in v1; future command semantics are
  separately governed.
