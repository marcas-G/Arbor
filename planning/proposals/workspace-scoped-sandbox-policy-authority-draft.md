# Workspace-scoped sandbox policy authority — draft

**Status:** PRODUCT DECISIONS ACCEPTED — complete native execution integration pending

**Date:** 2026-11-16

## Why this draft exists

The Linux single-user flow currently cannot select an OS-enforced sandbox policy
through the ordinary local Web UI. A real local request is authenticated as
`user:local`, but the native sandbox command path requires a configured host
issuer and a second, different `HumanPrincipal` as the decision subject. The
ordinary local composition has neither a second user nor a supported user
configuration step, so `DecideSandboxPolicy` fails with `NoApplicableGrant`.

The intended product boundary is Workspace-scoped: a Workspace owns the
admitted resources, its ResourceBoundary defines what a process may see, and an
Execution is allowed to use only the current Workspace boundary and policy.
The local user identity is needed for request authentication and audit, but it
must not be turned into several internal human identities to make the command
pass.

## Facts established by the current design and implementation

1. `Workspace` already carries the current `ResourceBoundary` and its
   revision. Resource ownership claims are keyed by `workspaceId` and are
   consumed by sandbox candidate preparation and process-policy materialization.
2. The process policy already binds the complete Workspace boundary, ownership
   claims, mount identities, policy revision and Execution identity. It does not
   derive access from a model supplied path.
3. Generic invocation authority already carries `workspaceId`, `executionId`,
   resolved resource regions and a capability ceiling. Workspace and resource
   checks are therefore already the natural execution boundary.
4. `PermissionSubject` already has `WorkspaceAgent` and `Execution` variants.
   Generic grant matching can bind a grant to a Workspace or an Execution.
5. The accepted native sandbox amendment in P12 currently creates a separate
   exception: `DecideSandboxPolicy` requires a CAPA grant whose subject is a
   distinct `HumanPrincipal`, whose issuer is in a host issuer allowlist, and
   whose target is the exact Execution.
6. The Web form was temporarily changed to auto-create that second local
   principal and grant. That change was removed because it changes the
   authorization model and hides a design mismatch behind an internal token.

## Required semantic correction

### Authentication

- Keep one authenticated local principal for the local single-user process.
- Use it to bind the external request, audit actor and transport access.
- Do not create a second local human principal, hidden bearer token or role
  switch for sandbox policy selection.

### Workspace authorization

`DecideSandboxPolicy` must be authorized against the exact current Workspace
and Execution relation:

- the request targets one Project, Workspace and active Execution;
- the Execution belongs to that Workspace;
- the Workspace is active;
- the decision is checked against the current Workspace revision,
  ResourceBoundary revision/digest, ownership claims, policy candidate and
  episode CAS fields;
- the current requester must be authorized for that Workspace by the existing
  Workspace governance/ownership rule;
- a grant or subject belonging to another Workspace, Execution or project must
  not authorize the decision;
- the authority must not be inherited by changing only the authenticated
  principal string.

The exact existing Workspace governance rule that identifies the local user as
the owner/controller of a root Workspace, and the corresponding rule for a
child Workspace, must be named by the owning design document. This draft does
not invent that fact. If the current model cannot express it, the design gap
includes adding an explicit Workspace authority fact to the resolver input.

### Host sandbox trust

The P5 sandbox authority bundle remains necessary for a provider to be
considered Supported. Its provider registry, operator configuration, evidence,
revision and digest continue to protect the host execution mechanism. Its
`issuers` list must not be used as a second user permission system for the
Workspace. Host trust and Workspace authorization are separate checks:

```text
current Workspace authority
  + current ResourceBoundary / ownership
  + current Execution and episode
  + current provider/operator qualification
  -> SandboxPolicyDecisionAuthority
```

The final decision may still record the authenticated actor for audit, but the
actor is provenance. It is not a hidden second decision identity.

## Expected implementation consequences

The implementation change must be governed before code changes are made.
Expected affected owners are:

- P12 `02` — replace the special HumanPrincipal-to-HumanPrincipal sandbox
  grant route with the Workspace-scoped authority fact and define the exact
  resolver input needed to prove Workspace control;
- P4 `03` / P4 `04` — preserve the existing exact policy, resource-boundary,
  provider and process checks while removing the user-permission meaning from
  the host issuer allowlist;
- P5 `01` — keep the host authority bundle as provider/operator trust and
  clarify that it does not select the Workspace user or issue user grants;
- P1 sandbox command contract — keep the existing command payload and CAS
  fields unless the owning governance review proves a new field is necessary;
- Web single-user flow — submit the user's explicit policy selection directly,
  with no automatic `GrantPermission`, hidden token or actor substitution;
- migrations and replay — define how existing sandbox grants/provenance are
  read, ignored, migrated or retired. Existing committed policy decisions and
  their audit evidence must remain decodable.

## Acceptance evidence required after governance

The implementation is not complete until a real installed Linux flow proves,
through public user actions:

1. one local user configures a real model and opens an existing project;
2. Arbor presents the current Workspace policy candidates;
3. the user selects `WorkspaceWrite` with network enabled;
4. the decision commits without setting a second principal or any internal
   environment variable;
5. a process can write only admitted Workspace resources and can use the
   configured network route;
6. a second Workspace cannot read or write the first Workspace's resources;
7. changing the Workspace boundary, ownership, Execution or provider bundle
   makes the old decision stale or denied;
8. restart reuses only the same Workspace-scoped durable facts; it does not
   recreate authority from a hidden token;
9. audit records retain the authenticated actor and exact Workspace/Execution
   binding.

## Alignment with the already frozen Workspace model

The governing relationship is already defined by System Design §8.1–§8.5:

- the User is the final governance source;
- a Workspace Agent is autonomous inside its own Boundary;
- a Parent governs its Direct Children;
- siblings do not Assign, Steer, Stop or change one another's responsibility;
- effective capability is the intersection of delegation ceiling,
  Responsibility Scope, ResourceBoundary, constraints and policy.

Therefore this draft does not ask the product owner to choose a new root/child
role model. It asks P12/P4/P5 to apply that existing model to the native
sandbox decision path, which currently bypasses it with the special
HumanPrincipal-to-HumanPrincipal issuer rule.

## Questions that remain for implementation landing

These are product/design questions, not implementation guesses:

- The product decision is now fixed: the authorization basis is the current
  Workspace and its existing vertical governance relationship. `user:local` is
  authentication/audit provenance only; a second HumanPrincipal is forbidden.
- The implementation landing must name the exact existing root and
  Parent/Direct-Child facts used by the resolver and Gateway. It must not invent
  a new role system.
- Existing `DecideSandboxPolicy` PermissionGrant/provenance rows are historical
  compatibility data. New decisions need a durable Workspace authority basis;
  they must not use a fake grant ID or identity to satisfy the old schema.

The product direction is recorded in
`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`. Code changes
remain blocked only at the concrete persistence/landing boundary: existing
historical rows must stay readable while new rows record Workspace authority
directly.

## 2026-11-16 accepted lifetime and delegation supplement

Q-016 and Q-017 are resolved: workspace permission persists across tasks and
restarts; explicit direct-Parent delegation stays within the current Parent
ceiling and the Child resource boundary. No second human identity is permitted.
See `docs/proposals/2026-11-16-workspace-permission-continuity.md` for the
implementation contract and its phased evidence. This draft's per-execution
checks refer to derived execution bindings, not repeated human authorization.
