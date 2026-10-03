# UI Project Resource Admission — Decision Draft

## Status

```text
State: DRAFT / MANUAL GOVERNANCE REQUIRED
Gap: FT-DG-01
Implementation: NOT AUTHORIZED
Recommended token: ACCEPT_UI_PROJECT_RESOURCE_ADMISSION
```

## Problem

The browser CreateProject flow accepts only a project name and currently sends
an empty Root Workspace ResourceBoundary. This makes the created project usable
for conversation but unable to run evidence-producing filesystem tools.

The browser must not gain authority by sending an arbitrary server path. At the
same time, Project, Workspace and Git worktree remain distinct concepts:

```text
Project                product container
Workspace              long-lived responsibility
ProjectResourceProfile host-admitted resource ceiling
GitWorktree             optional concrete resource inside that ceiling
```

## Decision

Introduce a host-owned `ProjectResourceProfile` reference at the transport /
Application boundary.

```text
Host configuration or native folder picker
→ canonical ProjectResourceProfile
→ opaque resourceProfileRef exposed to UI
→ CreateProject(resourceProfileRef)
→ server resolves exact ResourceBoundary
→ Root Workspace receives the admitted ceiling
```

The browser sees a label and opaque ref, never a free server filesystem path.
The server owns canonical path resolution and authorization.

## V1 implementation

For the local desktop/server product:

1. `ARBOR_PROJECT_ROOT` registers one local profile at startup.
2. A read-only public bootstrap endpoint/view returns:

   ```text
   resourceProfileRef
   displayName
   availability
   ```

3. CreateProject UI selects the available profile (automatic when exactly
   one exists).
4. CreateProject command carries `resourceProfileRef`, not ResourceAddress.
5. Authority Resolver binds the ref to the configured canonical FileTree
   address and derives the Root Workspace ResourceBoundary.
6. Missing/stale/foreign refs fail closed with a typed user-visible problem.

A future native host may register multiple profiles through a folder picker;
the command and Domain semantics remain unchanged.

## Security invariants

- model text cannot create or widen a profile;
- browser text cannot name an arbitrary filesystem path;
- the resolved boundary is within the host-admitted ceiling;
- CreateProject payload cannot override the resolved address;
- secrets and native absolute paths are not exposed unnecessarily in views;
- Workspace child ceilings remain subsets of the Root boundary;
- creating a Project does not create a Git worktree automatically;
- selecting a Git worktree remains a separate resource lifecycle decision.

## Rejected alternatives

### Browser free-text path

Rejected: grants authority from untrusted presentation input and behaves
differently on remote hosts.

### Always use process.cwd()

Rejected: silently binds Arbor's own checkout or launcher directory and hides
the user's resource choice.

### Treat Project as a folder/worktree

Rejected: collapses the accepted Product/Responsibility/Resource separation.

### Allow empty boundary and weaken Verification

Rejected: produces projects that appear functional but cannot meet completion
semantics.

## F21 acceptance contract

The implementation is not complete until this browser-only journey passes:

```text
start Arbor with one host-admitted temporary ProjectResourceProfile
→ open /
→ enter project name and create
→ submit a bounded goal
→ approve exact Work in UI
→ producer uses read on the admitted directory
→ independent Verification records evidence and PASS
→ user accepts in UI
→ Work completes
```

Forbidden test shortcuts:

- no direct `/commands` setup;
- no SQLite reads/writes;
- no internal Layer/Repository access;
- no browser-provided absolute path;
- no pre-created Project/Workspace;
- no skipped/fixme expected failure.

## Owned design surfaces if accepted

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P12/02-authority-resolver.md
docs/design/implementation/P13/**
docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md
```

Implementation must stop until manual governance accepts or replaces this
decision.
