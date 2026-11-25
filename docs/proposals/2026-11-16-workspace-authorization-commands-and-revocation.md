# Workspace authorization commands and human revocation

Date: 2026-11-16  
Status: accepted product behavior; staged implementation, not production delivery

## Product authorization

The project owner accepted persistent Workspace permissions, explicit bounded
direct-Parent allocation, and the following additional behavior: when the user
revokes a Child's permissions, a Parent that retains those permissions cannot
grant them back. Only a new explicit human authorization clears that revocation.
This is a user-visible authority rule, not a second human identity or a host
operator role. Existing resource boundaries and exact action approval remain.

## Engineering contract

Two Gateway handlers implement the immutable ledger from the preceding storage
package: `AuthorizeWorkspaceSandbox` and
`RevokeWorkspaceSandboxAuthorization`, receipt schema 1. Their exact result is
`{ authorization: WorkspaceSandboxAuthorization }`; it contains the full selected
scope and cause, rather than just Workspace/revision/state. The store validates
the canonical fact against that exact committed receipt and its Project,
schema/fingerprint version and resolution. Malformed heads or receipts are
corruption; readers never fall back to an older authorization.

Authorization selects ReadOnly/WorkspaceWrite, the logical provider, canonical
network policy, explicit finite-or-null expiry, current resource-boundary and
Workspace-policy revisions, and the expected current authorization revision.
The source selection is Human or Parent. Human identity comes from authenticated
governance membership. Parent identity, originating Execution and source revision
come from the resolver's trusted canonical snapshot, not model-supplied identity.

The Gateway transaction rereads the target Workspace, current head, trusted
clock, direct Parent relationship, originating active Workspace Execution and
complete current source chain. The Parent's exact current revision and capability
ceiling must still hold. A human Revoked head rejects even a fresh Parent request
with the correct expected revision. A new human authorization may replace it.
Parent Execution settlement after allocation does not expire the Child grant;
future use continues to validate the Workspace chain. Parent retirement,
revocation, replacement, expiry, reparenting or invalidated scope denies dependent
allocation. Capability allocation never admits a filesystem resource.

Successful changes append one `WorkspaceSandboxAuthorizationChanged` v1 event,
the immutable fact and the exact command receipt in the Gateway transaction.
The event carries Workspace, authorization revision and Granted/Revoked state.
Authorization revision CAS is independent of general Workspace revision, which
changes during normal tasks. Concurrent database writers serialize through
`BEGIN IMMEDIATE`; stale appends are typed revision conflicts, with SQL successor,
foreign-key and immutable-history constraints as a separate backstop. A missing
deferred command receipt rolls the fact back.

## Explicit staging boundary

The schema57 descriptor and these handlers remain staged. Schema56 is still the
runtime head. The command receipt inventory may decode these internal optional
handlers; the external wire registry and ordinary production composition do not
register them. The new authorization reader/store is not a bypass for the legacy
Native sandbox decision handler. The old two-human policy path remains a release
blocker until execution binding, migration tooling, recovery and ordinary UI
are integrated. No preserved user database has been migrated.

Contract/SQLite tests and architecture checks qualify only their named layers.
They do not prove installed real-provider shell/build/test journeys, native lease
competition or process crash recovery. Those remain in the active delivery goal.
