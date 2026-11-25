# Durable Workspace sandbox authorization

Date: 2026-11-16  
Status: engineering landing for the already accepted Workspace lifetime and
bounded direct-Parent allocation decisions; runtime integration incomplete

Product authority is recorded in
`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md` and the fixed
continuity package. This package supplies the durable representation required
by those decisions. It does not add a human identity, hidden token, automatic
grant, resource share, or a new product permission category.

## Domain and storage owner contract

`WorkspaceSandboxAuthorization` is a versioned immutable Workspace fact. Its
identity is Project + Workspace + monotonically increasing authorization
revision; its cause is the exact committed Gateway Command. It contains no Work,
Session or target Execution lifetime. Grant choices are the OS-enforced profile,
logical provider ID and canonical network policy, plus exact resource-boundary
and Workspace-policy revisions. Provider version, current host trust and exact
Execution/Episode remain freshly validated execution-binding facts.

Origin is either the real human authorizer or a direct Parent allocation with
Parent Workspace, exact Parent authorization revision and originating Parent
Execution for audit. The originating Execution is not an authorization expiry.
The authenticated principal remains provenance and cannot substitute for an
admitted Workspace/resource/governance relation.

Revocation appends a new immutable head; it never deletes or edits an old grant.
Replacement also advances the head. Reading a revoked/stale head never falls
back to an older grant. Existing finite grants and legacy human sandbox
provenance are not imported into this ledger.

Effective authorization checks the current same-Project Active Workspace,
boundary/policy revisions, trusted time, the current head and the complete
explicit Parent source chain. Each source must still be the Parent's current
Granted head; Parent replacement, revocation, expiry, retirement, resource/policy
invalidation, reparenting or a cycle denies the dependent allocation. Another
independent user authorization may establish a new head. Child profile, provider,
network destinations and lifetime cannot exceed the source ceiling. Resource
ownership is separate; capability allocation does not share a path.

The SQLite adapter stores canonical JSON plus indexed exact identity/cause
columns. It returns facts only joined to an exact committed command receipt
with matching Project/Workspace/revision/state. Unknown versions, extra fields,
malformed IDs or contradictory columns/receipts are corruption, not absence.
All inserts require TransactionScope and remain Gateway-only writes.

## Integration order and qualification boundary

Build domain evaluation, the port and strict durable adapter first. Additive
schema 0057 must require 56 and must be integrated with the offline upgrader,
schema signatures, maintenance continuation and manifest before runtime head
promotion. It must not rewrite preserved user databases.

Next, wire explicit user/Parent commands, exact execution policy binding,
revocation, recovery and the ordinary UI. The old policy-decision table's
human-grant fields must not be filled with fake values; its legacy read contract
and inbound unavailable-fact foreign keys must be preserved during that change.

Until these consumers are wired and installed behavior is verified, this ledger
does not unblock shell or constitute delivery. Qualification must include
durability/reopen, independent target Executions, immutable history, revoked-head
no-fallback, exact receipt binding, Parent revocation/replacement/expiry, stale
resource scope, sibling/foreign-project denial and concurrent head CAS. Final
acceptance still requires the same source-free Linux package and real model/UI
journey in the active goal.
