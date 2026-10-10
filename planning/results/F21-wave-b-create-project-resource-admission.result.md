# F21 Wave B — CreateProject v2 resource selection and durable boundary

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Scope: implement and qualify the accepted FT-DG-01 v3 functional slice from
the trusted P1 Profile Port through CreateProject persistence and post-commit
ownership activation. This is not Web-form / F21-browser completion.

## Contract applied

- `CreateProject` now has Handler schemaVersion 2. The external codec remains
  server-selected wire-v1; the request carries only
  `Profile(resourceProfileRef, version) | ConversationOnly` under
  `rootWorkspace.resourceSelection`. Client `resourceBoundary`, revision,
  address, absolute path, unknown fields, and mixed selector/boundary shapes
  fail the existing closed decoder with HTTP 400.
- The selector identifiers are bounded opaque strings. A `Profile` is
  resolved only by the handler through the immutable
  `ProjectResourceProfilePort`; that code executes only on the Gateway's
  absent-receipt branch. It performs no filesystem I/O. Exact canonical
  `FileTree` boundary and revision 0 are constructed by the trusted handler;
  ConversationOnly creates an explicit empty boundary.
- Missing/forged/stale/unavailable Profiles return the Application-owned,
  non-disclosing `ProjectResourceUnavailable` terminal rejection. Per P1
  receipt semantics, the terminal receipt is retained for that CommandId;
  no Project, Workspace, Session, Domain Event, or ownership claim is written.
  Exact retry replays that rejection; changing selection under the same ID is
  `IdempotencyConflict`, not a repair retry.
- Project + root Workspace + primary Session and their existing ordered
  `ProjectCreated(v1)` / `WorkspaceCreated(v1)` events remain inside the
  existing Gateway transaction. No SQL/DDL/migration or EventVersion change
  was made.
- External ordering and F23 semantics remain unchanged: authenticate → strict
  wire-v1 decode → ID validation → current Handler schema/fingerprint → exact
  Actor/Principal binding → Resolver → Gateway receipt tuple. No external
  receipt pre-read or stored-schema decoder was added. Old raw-v1 payloads
  fail the current codec; a valid v2 request colliding with a preserved v1
  receipt reaches the Gateway and gets non-disclosing `IdempotencyConflict`.
  The old receipt row is not decoded or changed; successful old-v1 same-ID
  replay remains OPEN-2 and is not promised.
- After commit, CreateProject ownership activation re-reads the persisted root
  Workspace through `WorkspaceRepository` and resolves that durable boundary.
  It does not use request payload or reselect a path from the current Profile
  catalog. Restart/exact-receipt replay therefore reconstructs the same
  boundary; a new request with a stale Profile version fails closed. Child
  activation, GitWorktree lifecycle, and ownership authority are unchanged.

## Evidence

RED: the new codec qualification initially failed because the current wire
descriptor rejected `resourceSelection` and still required client
`resourceBoundary` fields. The v2 closed Profile/ConversationOnly selector now
passes while legacy raw-boundary and mixed-boundary shapes remain rejected.

GREEN:

- `pnpm exec vitest run apps/single-workspace/test/external-command-codec-registry.test.ts tests/f21-create-project-resource-admission.test.ts` — 10/10 tests.
  The new five-case SQLite/Application integration suite covers raw/mixed
  payload 400 with zero receipt/state, canonical Profile persistence plus
  ConversationOnly empty boundary and v1 event versions, terminal rejection
  for forged/stale/unavailable Profiles with stable receipt replay and
  same-ID changed-selection conflict, fresh composition restart/replay with
  unchanged and changed Profile snapshots, ownership reconstruction from the
  stored Workspace boundary, and v1 receipt preservation/tuple conflict with
  zero Profile resolution.
- `pnpm exec vitest run tests/p1-create-project.test.ts tests/p12-transport.test.ts tests/p12-production-composition.test.ts` — 16/16 tests.
- Real daemon/public HTTP pending qualification — 2/2 tests: v2 Profile
  CreateProject Committed and exact same-CommandId replay after stopping and
  restarting the daemon with the same registered host directory; plus public
  HTTP rejection of a Profile selector combined with a raw client path. The
  profile catalog stays path-free and no provider call is made.
- `pnpm build`, `pnpm typecheck`, targeted Biome (13 owned source/test files),
  and `git diff --check` passed. The full `pnpm test:functional` suite was not
  run.

## Existing fixture migration impact

The read-only call-site audit found these migration groups; the companion
fixture migration is separate from the production/Wave-B qualification files
in this result:

- Shared P1/P6/P7 gateway seed builders: `tests/support/p1-app.ts`,
  `tests/support/p6-app.ts`, and `tests/support/p7-app.ts`.
- P1/P5/P6/P12 direct acceptance and transport fixtures:
  `tests/p1-create-project.test.ts`, `tests/p1-create-child-workspace.test.ts`,
  `tests/p1-idempotency.test.ts`, `tests/p6-acceptance.test.ts`,
  `tests/p6-formation-governance.test.ts`, `tests/p12-acceptance.test.ts`,
  `tests/p12-production-composition.test.ts`, `tests/p12-runtime-safety.test.ts`,
  `tests/p12-secret-store.test.ts`, `tests/p12-transport.test.ts`, and
  `apps/single-workspace/test/p5-slice-acceptance.test.ts`.
- P13 bootstrap fixtures and functional public helper:
  `apps/single-workspace/test/p13-e2e-fixtures.ts`,
  `apps/single-workspace/test/p13-web-e2e.test.ts`,
  `tests/functional/support/public-client.ts`, and
  `tests/functional/pending/resource-admission.functional.test.ts`.
- Capability public CreateProject callers/helpers include
  `tests/capability/support/public-chat.ts`,
  `tests/capability/support/work-execution.ts`, the S1-S4 public API test, and
  the B03/B06/B07/B12/B13/B14 real-provider journeys. Their filesystem cases
  must select the host Profile; pure-conversation seeds must send
  ConversationOnly. No fixture may preserve an external arbitrary
  FileTree/GitWorktree address.
- The browser `tests/functional/pending/ui-project-resource.spec.ts` and the
  Web CreateProject form remain Wave C. This result does not claim F21 browser
  qualification or move that journey into the default browser gate.

FT-DG-01 OPEN-1 Profile-source audit, OPEN-2 historical v1 same-ID successful
replay, and OPEN-3 durable post-commit Attention remain open. No new Event
version, schema migration, GitWorktree, or Web-form semantics are claimed.
