# FT-DG-01 — UI-created Project has no executable ResourceBoundary

## Status

**OPEN — PRODUCT/DESIGN DECISION REQUIRED**

## User-visible failure

The browser can create a Project and chat successfully. The same freshly
created Project cannot complete an evidence-based Work:

```text
Create Project in UI
→ assign Work
→ independent verifier calls read
→ Denied: workspace filesystem mount is missing or ambiguous
→ no PASS / no acceptance path
```

This was discovered by F14/F15 before the test was separated from its setup.
The production form currently sends:

```text
rootWorkspace.resourceBoundary.addresses = []
```

The runtime correctly fails closed. The defect is that the product offers no
trusted way to bind a local project directory during browser creation.

## Why the test must not patch around it

- A browser-supplied arbitrary server filesystem path is an authority hazard.
- Defaulting silently to the Arbor source checkout confuses Project with
  Workspace and Git worktree.
- Disabling verification would weaken the accepted completion contract.
- A fake in-memory mount would not represent the user's real work resources.

## Decision required

Choose and govern one explicit product path:

1. host-mediated folder selection returning an opaque admitted resource ref;
2. server-configured project root selected during CreateProject;
3. project creation followed by a separate exact resource-admission flow.

The server—not free browser text—must resolve the ref to canonical
ResourceAddress/ResourceBoundary facts.

## Evidence

```text
apps/web/src/commands/forms/CreateProjectForm.tsx
tests/functional/ui/project-conversation.spec.ts
tests/functional/ui/approval-completion.spec.ts
planning/testing/functional/01-functional-journey-catalog.md (F21)
```

F14/F15 remain valid by using the public CreateProject command in test setup
with an admitted temporary directory, then driving approval and acceptance
entirely through the browser. F21 remains release-blocking until this gap is
resolved.
