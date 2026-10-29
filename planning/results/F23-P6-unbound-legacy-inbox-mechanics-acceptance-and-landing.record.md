# F23 P6 UnboundLegacy Governance Inbox Mechanics — acceptance and landing record

Date: 2026-10-17
Accepted token: `ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`
Accepted proposal: `planning/proposals/F23-P6-unbound-legacy-inbox-mechanics-draft.md`
Proposal raw SHA-256: `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`
Design version: DID v1.47 (from v1.46)

The fixed package lands P6's existing `Governance` Inbox kind and stable
`retry-verification-unbound:<commandId>` key; typed
`RetryVerificationUnboundLegacy` content is derived from the immutable
disposition and canonical Work/Workspace facts. Current Root-local or exact
direct-Parent human authorization is re-evaluated for reads and routing. Reads
do not consume the entry. Owner/Parent route changes and same-key Inbox route
moves are atomic in the P1 command transaction. If the move cannot be atomic,
the command follows the existing Gateway terminal-rejection receipt/attempt
path, with no canonical Work/Workspace/Event/Inbox/disposition mutation.
Rebuild does not read/decode Command receipts or depend on Event retention;
UnboundLegacy replay remains generic current Resolver denial. No new Inbox
kind or P10 Attention source is introduced.

The owning contract updates are in DID v1.47 and:

- `docs/design/implementation/P6/00-contract-index.md`
- `docs/design/implementation/P6/02-communication-protocol.md`
- `docs/design/implementation/P6/06-acceptance.md`
- `docs/design/implementation/P8/01-verification-commands.md`
- `docs/design/implementation/P8/06-acceptance.md`
- `docs/design/implementation/P1/01-command-contracts.md`
- `docs/design/implementation/P1/03-transaction-model.md`
- `docs/design/implementation/P1/04-sqlite-schema.md`
- `docs/design/implementation/P12/02-authority-resolver.md`
- `docs/design/implementation/P12/10-transport-shells.md`

The semantic route transition is fixed, but the current Inbox DDL has no
`revision`/`updated_at` columns. Their physical representation, initial
revision seed and migration ID/name are explicitly deferred to a separately
authorized implementation package in P1 `04`. This landing does not authorize
production code, DDL, migration registration/execution, tests, or online
database upgrades.
