# P1-DG-05 — CreateProject bootstrap paradox and undefined root contents

## Status

RESOLVED — DID v1.5.

## Resolution

DID §12.11/§4.1 freeze the `CreateProject` bootstrap contract: caller
preallocates `projectId` / `rootWorkspaceId` / `primarySessionId`; payload
provides root Workspace/Project inputs; a single transaction creates Project
+ Root Workspace + `WorkspacePrimary` Session; events
`ProjectCreated → WorkspaceCreated`; **no** Session Domain Event (the §5.3
catalog has none); authority failure → `DomainError.AuthorityDenied`.

Authority: DID v1.5 §4.1, §12.11, §9.13.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §4.1, §3.1, §3.2, §12.11,
§9.13.

## Symptom

Every `CommandEnvelope` requires `projectId` (§4.1:1084-1093), but
`CreateProject` is what creates the Project (§12.11:3575, "creates Project +
Root Workspace + Primary Session atomically"). None of the bootstrap values
are defined:

- Root Workspace requires `ResponsibilityDefinition`, `ResourceBoundary`,
  `agentBinding`, `workspacePolicy`, `primarySessionId` (§3.2).
- Project requires `projectPolicy`, default configuration, `environmentRef`
  (§3.1).
- Authority/precondition for `CreateProject` is unspecified ("valid
  root/bootstrap transaction"); no rejection tag is defined.
- Whether root creation emits `WorkspaceCreated` / `ProjectCreated` and in
  what order is unstated.

## Evidence

```text
DID §4.1:1084   CommandEnvelope.projectId required
DID §12.11:3575 CreateProject → creates Project + Root Workspace + Primary Session atomically
DID §3.1:805    Project fields (policy, config, environmentRef)
DID §3.2:827    Workspace fields (responsibility, boundary, agentBinding, policy, primarySession)
DID §9.13:2967  Project.rootWorkspaceId ↔ Workspace.projectId cycle
```

## Why planning cannot decide this

The bootstrap contract (how `projectId` exists before the project; what the
root Workspace/Session contain; authority; emitted events) is **domain /
command semantics**.

## Required resolution

Freeze: `CreateProject` payload (client-preallocated vs generated IDs, or an
envelope exception); required root Workspace/Session/Policy inputs;
authority rule and rejection tag; and the emitted-event set/order.

## Affected P1 areas

`CreateProject` command contract, DDL, cyclic-FK migration.
