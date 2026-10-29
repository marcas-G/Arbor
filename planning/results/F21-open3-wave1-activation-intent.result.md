# F21 OPEN-3 Wave1 — durable activation intent

Date: 2026-10-10

Base: `549caac096734d79c1256a44e64d1f1295ffea8d`

Scope: implement only the P1 committed activation intent, its transaction-bound
SQLite store/migration, and `WorkspaceResourceActivationChanged` EventVersion 1
catalog entry under the reviewed level-triggered owner contract. P10 source
reconciliation, P11 Pending→Active ownership transition, and P12 startup scan
are not implemented here. This result does not claim OPEN-3 or F21 closure.

## Changes

- `CreateProject` inserts one `Pending` intent only for the already host-resolved
  non-empty Profile boundary. The insert and `WorkspaceResourceActivationChanged`
  v1 event are returned through the same Gateway handler transaction as
  Project/Workspace/Session, the unchanged `ProjectCreated(v1)` and
  `WorkspaceCreated(v1)` events, and the committed receipt. ConversationOnly
  writes neither intent nor status event.
- Added the P1-owned `WorkspaceResourceActivationStore` Port and SQLite
  adapter. The exact identity is
  `(projectId, workspaceId, resourceBoundaryRevision)`; reads are
  transaction-scoped and ordered. Active CAS is present for the later P11
  owner to use but is not called by this Wave1.
- Added forward-only migration 35 after current `user_version=34`. As required
  by P1 `04` / P10 `04`, it creates both the intent table and the P10
  `workspace_resource_activation_attention_rows` schema/FK/index. This is
  schema only: no P10 reconcile/query/consumer code is included.
- Production migration wiring now uses P35. Existing P34 migration consumers
  remain available for their phase-specific fixtures.
- The event schema/catalog permits only workspace id, boundary revision, and
  `Pending|Active`; it contains no Profile/path/filesystem detail.

## Evidence

Initial RED, before the implementation: the focused F21 Profile journey failed
with `no such table: workspace_resource_activation_intents` after adding the
expected event/intent postconditions.

Final targeted run:

```text
pnpm typecheck                                      PASS
Biome check (15 changed TS files)                   PASS
Vitest: 4 files, 12 tests                           PASS
  tests/p1-create-project.test.ts                   includes pre-commit rollback injection
  adapters/persistence-sqlite/test/p35-...test.ts   pre-intent v2 no-backfill
  tests/f21-create-project-resource-admission.test.ts Profile/ConversationOnly/replay/v1 preservation
  tests/architecture/mac-p4-convergence.test.ts     current migration wiring
git diff --check                                    PASS
```

The rollback test lets the handler, intent store, journal, and receipt path run
inside a transaction, then injects a pre-commit transaction failure. It verifies
Project, Workspace, Session, receipt, event, and intent counts are all zero
after rollback. This is transaction rollback evidence, not an exact OS-process
kill qualification. The migration test seeds a committed pre-intent v2 receipt,
canonical Workspace with an old path boundary, and original v1 events before
applying P35; all remain unchanged and no intent is synthesized. The public
F21 test separately verifies same-id receipt replay leaves exactly one intent
and no duplicate status event, and historical v1 requests remain tuple-conflict
/ preserve-only.

The same public journey also asserts the exact path-free activation event
payload/aggregate binding and exact Pending intent row.

No full `pnpm check`, full functional suite, or runtime crash/restart gate was
run. No files outside this task were staged; `C:\Arbor` was not accessed. No
push or merge was performed.
