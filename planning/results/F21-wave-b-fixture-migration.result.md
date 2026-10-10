# F21 Wave B — test fixture migration to CreateProject v2

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Base HEAD: `cad8b9ae3fe2d30d96b5997be96b3a11a75ae746`

## Scope

Only test and fixture files assigned to the fixture-migration task were changed.
No production source, `docs/design/**`, Wave-A host catalog implementation,
production-owned F21 qualification test, or production-owned codec-registry test
was staged or committed. `production-fixture.ts` did not need modification: its
existing `admitWorkspaceDirectory` test-host switch registers the startup
`ARBOR_PROJECT_ROOT` Profile.

## Migration

- `tests/functional/support/public-client.ts` now builds the v2
  `rootWorkspace.resourceSelection`. It defaults to explicit
  `ConversationOnly`; a file-backed case must opt into `Profile`. Profile
  selection reads the public `GET /project-resources` catalog and requires one
  available entry, then sends only its opaque ref/version. The helper's
  `workspaceDirectory` argument is no longer serialized, and no legacy
  `resourceBoundary` or `GitWorktree` address is sent.
- The capability fixture follows the same split. `makePublicProject` defaults
  to `ConversationOnly`; an optional test-host directory is held in a
  `WeakMap`, not in the serializable Project or command payload. The host
  composition registers it through the environment adapter. File-backed
  commands use `publicProjectPayloadFromCatalog`, which reads the endpoint
  using the separate local catalog identity and copies only the returned
  opaque ref/version. Filesystem ownership seeding uses the canonical host
  path, not a client boundary.
- P13 e2e fixtures, S1–S4 bootstrap, and direct P1/P6/P7/P12 project seeds now
  use `ConversationOnly` when no file behavior is under test. Direct Gateway
  CreateProject fingerprints use Handler schema version 2. The obsolete P1
  client-controlled boundary-basis rejection case was removed; v2 no longer
  accepts a client boundary or basis revision.
- Functional shell/read/patch, proof-file, and child-boundary scenarios
  explicitly register the fixture directory at daemon startup and select the
  returned Profile. Conversation/recovery-only journeys remain
  `ConversationOnly`.
- `tests/functional/pending/resource-admission.functional.test.ts` now submits
  a v2 Profile selected from the catalog together with a forbidden legacy raw
  path field. It expects strict HTTP 400, no path disclosure, no provider call,
  and no daemon error; it does not cast the v1 payload to a v2 type.

## Verification

- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- `pnpm exec biome check` on the 47 owned test/fixture source files — PASS.
- No functional or full test suite was run by this migration subtask.

The production F21 process qualification and its raw-path cases are in a
separately owned, untracked file in the shared worktree; they are excluded from
this commit. Browser form/catalog UI migration is also outside this file
ownership boundary. This result claims only test/fixture TypeScript and Biome
compatibility with the v2 handler shape; it does not claim F21 qualification
or closure.
