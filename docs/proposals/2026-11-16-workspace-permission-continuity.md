# Workspace permission continuity and bounded delegation

Date: 2026-11-16  
Status: accepted product decisions; implementation qualification in progress

## Authorization

The user accepted both answers recorded in
`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`: workspace
authorization persists across tasks/restarts, and a direct Parent may explicitly
distribute capabilities within its current ceiling to a Child inside the
Child's own boundary. This package applies those decisions; it does not add
human identities or silently grant permissions.

## Owning semantics

1. A durable Workspace permission and an execution policy are distinct facts.
   New Work, new Execution and process restart do not consume a Workspace
   permission. Resource admission, current effective capability, host/provider
   qualification, exact execution/episode policy binding and exact sensitive
   action approval must still be checked at their existing boundaries.
2. Persistence does not authorize capability/resource expansion. Revocation,
   expiry if explicitly selected, retirement, invalid governance or incompatible
   boundary/policy changes make the relevant authorization unusable. Already
   applied external effects are not rolled back by revocation.
3. Parent delegation is explicit and only to a current direct Child of the same
   Project. Effective Child capability is intersected with the current Parent
   ceiling at use time, not just when distributed. Siblings, self-delegation,
   cycles, foreign projects and stale/revoked upstream authority do not confer
   capability. A separate user authorization may independently authorize Child.
4. A Child retains its own responsibility, Session, Work, Inbox and admitted
   resources. Delegating capability does not share a directory or create resource
   ownership. Formation, communication, Verification and Acceptance keep their
   existing contracts.
5. One local authenticated user remains the request/audit source. The host bundle
   proves executor/operator/provider trust; its human issuer list does not decide
   Workspace ownership. The old two-human Native sandbox exception is superseded
   for the target behavior. Historical receipts/provenance remain audit evidence;
   new Workspace authority cannot be fabricated by filling old grant fields.

## First implementation unit: persistent Workspace tool permission

- Keep the existing durable `permission_grants` table and Gateway-only writer.
  Its `expires_at` column already supports SQL NULL; no data/schema migration is
  required for this unit.
- `GrantPermission` schema 2 accepts `expiresAt: null` only for exact
  `WorkspaceAgent` subject + identical Workspace target and a concrete tool
  capability (`fs:write` or `shell:exec`). Other grants keep finite expiry.
  This limited entry point does not change Native sandbox policy authority.
- The resolver must prove authenticated governance membership and an Active
  Workspace in the request Project, and bind its current revision. Gateway
  rereads Workspace/project/lifecycle/revision and trusted time in its transaction
  before inserting the grant and `PermissionChanged` event. Null is explicit;
  absent, blank or invalid expiry never means persistent authorization.
- The ordinary file/command permission UI defaults to “持续有效，直到撤销”; the
  user may still explicitly choose a finite duration. Submitting remains an
  explicit user action. Transport retry preserves the original envelope.
- Schema 1 committed receipts remain replayable with their original result
  codec. Schema 2 retains the existing result shape. Existing finite grants are
  not rewritten or extended.

## Remaining vertical integration

The first unit does not resolve the old Native sandbox permission exception.
Next units must supply auditable Workspace policy authority, explicit bounded
Parent distribution with live upstream checks, fresh per-execution policy
materialization, recovery and user-visible revocation. None may substitute
internal human commands, fake grants or tests for installed product behavior.

## Qualification

For the first unit: reject null expiry for a Human/Execution subject, wildcard,
foreign Workspace target, missing governance, retired/foreign/stale Workspace;
prove durable reopening, a new execution using the same permission, another
Workspace being denied, and revocation being effective. Keep legacy finite
grant and sandbox-grant tests. Check the default UI and transport retry.

Full closure additionally requires a real installed Linux flow with one local
principal, real model, file/command/network work, Child bounded delegation,
resource isolation, stop/restart and independent verification/acceptance.
