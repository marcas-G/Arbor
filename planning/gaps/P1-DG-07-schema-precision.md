# P1-DG-07 — Schema precision: cyclic FKs, table↔domain mapping, root uniqueness

## Status

RESOLVED — P1 contract 04-sqlite-schema.md (4-way review round 4, Blocking=0).

## Resolution

Both DID §9.13 cycles use `DEFERRABLE INITIALLY DEFERRED`; table↔domain mapping
table added; root uniqueness + same-project enforced by the composite
`(root_workspace_id, project_id)` FK; workspace-tree same-project by the
composite `(parent_workspace_id, project_id)` FK.

Authority: DID v1.6 §9.1/§9.3/§9.13; `docs/design/implementation/P1/04-sqlite-schema.md`.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §9.1, §9.3, §9.13, §3.1,
§1.4A, §3.6.

## Symptom

1. Cyclic FKs: §9.13:2964-2971 says "优先使用 deferred FK semantics" for
   `Project.rootWorkspaceId ↔ Workspace.projectId` and
   `Workspace.primarySessionId ↔ Session.workspaceId`, but does not state
   which references are real FKs, whether `DEFERRABLE INITIALLY DEFERRED`
   is used, or what enforces integrity if not. SQLite cannot defer a
   non-deferrable FK. This blocks the `CreateProject` bootstrap migration.
2. Table-name ↔ domain-name mapping is not stated: `work_waits` ↔
   `Dependency` (§9.3:2755 vs §3.7), `work_acceptances` ↔ `Acceptance`
   (§9.3:2756 vs §3.6), plus `agent_execution_state`, `workspace_lineage`.
3. "Exactly one Root Workspace per Project" (§3.1:823, §1.2:333) has no DB
   enforcement; `projects.root_workspace_id` uniqueness is not frozen.

## Evidence

```text
DID §9.13:2964  two creation cycles; "优先" deferred FK
DID §9.1:2723   foreign_keys = ON
DID §9.3:2755   work_waits (table)
DID §3.7        Dependency (domain)
DID §3.6        Acceptance (domain)
DID §3.1:823    一个 Project 恰好一个 Root Workspace
```

## Why planning cannot decide this

Referential-integrity strategy, the authoritative table↔type mapping, and
where an invariant is DB-enforced are **persistence semantics**.

## Required resolution

Freeze: deferred-vs-application FK per cycle; the table↔domain mapping
table; and the unique constraint enforcing exactly one Root Workspace.

## Affected P1 areas

DDL, migration, bootstrap transaction.
