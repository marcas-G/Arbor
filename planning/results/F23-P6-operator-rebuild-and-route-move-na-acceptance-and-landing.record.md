# F23 P6 operator rebuild and v1 route-command N/A — acceptance and landing

Status: **Accepted design package landed; operator rebuild implementation remains unauthorized.**

## Decision and provenance

- Acceptance token: `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`.
- Accepted proposal: `planning/proposals/F23-P6-operator-inbox-rebuild-and-route-move-na-draft.md`.
- Accepted proposal raw-byte SHA-256: `B6A542973768D1C0D7C8ACB644988D1C957B7020F73206C335D73FF7FE0C833E`.
- Accepted and landed: 2026-10-18.
- Landing baseline: `3b94d7a55f68622ee324dfce67b0fee79dadd241`.
- This acceptance is design authority only. The distinct implementation token
  `AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION` has not
  been granted. No code, migration, tests, database operation, deployment or
  release was authorized or performed by this landing.
- Independent post-landing review: **pending**. The operator rebuild must not
  be implemented until that review and the separate implementation
  authorization are complete.

## Accepted decisions

1. **Owner/Parent route-move command-level qualification is N/A in v1 only.**
   Source inventory found no P1 command that mutates canonical
   `works.workspace_id` or `workspaces.parent_workspace_id`; formation only
   assigns a Parent when creating a child. This N/A covers the absent command
   journey and its command/process crash cases only. It does not remove the
   existing same-key same-transaction route helper, its adapter qualification,
   current-route human visibility, old/new recipient rule, or any future
   command constraint. A separately-governed future route-mutating command
   must update canonical route and the stable Inbox key in one P1 transaction,
   preserve old/new visibility, and use the ordinary P1
   `TerminalRejected(AuthorityDenied)`/zero-canonical-mutation path when the
   move cannot commit. P8's frozen old Verification owner snapshot and
   successor-current-owner semantics are unchanged.
2. **Production rebuild is required, not N/A.** The accepted operator-only
   offline command is `pnpm --filter @arbor/single-workspace
   p6:inbox-rebuild -- --database <absolute-schema48-db> --p39-sidecar
   <absolute-P39-report-sqlite> --manifest <absolute-protected-jsonl>`;
   `--resume` binds the same database, P39 sidecar, and manifest identities.
   It requires a stopped daemon, exact current schema 48 and the P39
   `MaintenanceExclusive` permit. It must use the existing
   `rebuildUnboundLegacyInboxProjections` helper in one `TransactionPort`
   transaction on the same P39 primary SqlClient connection. It changes only
   exact stable-key Inbox projections; canonical dispositions, Work,
   Verification, Project, Workspace, Command, receipt and Event facts remain
   read-only. No Application Command, Agent/Web/model tool, online service,
   P10 Attention source, new schema migration or high-water change is added.
3. The P39 blocker-report SQLite sidecar and operator JSONL audit manifest are
   distinct artifacts and authorities. P39 may atomically win creation of an
   absent report sidecar with `openSync(..., "wx", 0o600)`, then initialize or
   validate its report schema before acquiring the maintenance permit. The
   `wx` operation arbitrates file creation only; it is not the maintenance
   permit. The P39 writer-lock database is also infrastructure. If
   `RuntimeShared` prevents permit acquisition, those P39 infrastructure
   files may remain, but the primary database, P6 projection and JSONL
   operation manifest remain untouched. Sidecar winner/loser, empty/partial
   crash, retry, and no-auto-delete semantics are part of the accepted
   qualification contract.

## Owning-document landing

| Owner | Landed semantics |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | DID v1.52 records route-command-only v1 N/A, required offline operator rebuild, exact P39/sidecar/manifest boundary, acceptance token and separate authorization boundary. |
| `docs/design/implementation/P6/00-contract-index.md` | Adds v1.52 ownership and distinguishes route-command N/A from still-required route/helper/rebuild semantics. |
| `docs/design/implementation/P6/02-communication-protocol.md` | Clarifies no current v1 recipient-changing command; preserves same-key same-transaction/future-command constraints; assigns schema-48 offline rebuild to the P6 operator boundary. |
| `docs/design/implementation/P6/06-acceptance.md` | Story I marks only absent command-level route move/crash qualification N/A; retains helper/future command invariants and adds operator rebuild, audit, lock, crash/restart, and read-after-rebuild cases. |
| `docs/design/implementation/P8/06-acceptance.md` | Story H cross-owner route clause receives the same narrow N/A; P8 current authorization and frozen old/successor owner semantics remain unchanged. |
| `docs/design/implementation/P8/01-verification-commands.md` | Cross-reference clarifies route-command qualification N/A while preserving P8 authorization-before-Gateway and future same-transaction obligations. |
| `docs/design/implementation/P1/01-command-contracts.md` | 3C treats only the nonexistent current owner/Parent command rejection qualification as N/A; future Gateway rejection semantics remain. |
| `docs/design/implementation/P1/03-transaction-model.md` | Separates future P1 command transaction/rejection semantics from the offline operator transaction using one P39 primary connection. |
| `docs/design/implementation/P1/04-sqlite-schema.md` | Records current schema-48 Inbox revision fields, v1 route-command status, no new migration, and operator-only projection mutation boundary. |

P10 documents and behavior remain unchanged; the operator rebuild is not an
Attention source. The landing does not invent a route-mutating command.

## Planning status and remaining gates

The prior design-gap disposition is resolved at the design level by this
accepted proposal. Implementation is **not authorized**. Before implementation
may begin, an independent reviewer must verify the landing matches the exact
accepted proposal at raw SHA-256 above, all owning-document cross-references are
consistent, route-command N/A remains narrow, rebuild remains mandatory, and
the P39 sidecar/primary/JSONL manifest boundaries are explicit. Then the manual
governor must issue the separate implementation token. The full TDD/process
crash/competition matrix in the accepted proposal remains required; this
acceptance is not release readiness.
