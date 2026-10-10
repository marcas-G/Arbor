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
- P13 e2e fixtures and direct P1/P6/P7 project seeds use `ConversationOnly`
  when no file behavior is under test. Direct Gateway
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
- No full functional or full repository test suite was run; focused follow-up
  commands are recorded below.

## Review follow-up — file-backed test seeds

An independent review found four test fixtures that had been classified as
conversation-only despite asserting filesystem-backed behavior. They now use
host-registered Profiles without restoring any client-controlled path or
boundary field:

- `tests/capability/black-box/s1-s4-public-api.test.ts` registers the daemon's
  temporary workspace directory as `ARBOR_PROJECT_ROOT`; S1/S3 selects the
  sole available ref/version through authenticated public `GET
  /project-resources`. It retains child boundary creation and shell-backed
  `BB_VERIFIED` verification.
- `apps/single-workspace/test/p5-slice-acceptance.test.ts`,
  `tests/p12-runtime-safety.test.ts`, and the safety story in
  `tests/p12-acceptance.test.ts` install a test host
  `ProjectResourceProfilePort` for their temporary directory and select only
  its listed ref/version. Existing shell, region/ceiling, and ownership
  assertions remain; ownership claims use the canonical temp root.

Focused evidence after this correction:

- P5 shell vertical slice — 1/1 PASS. A temporary ConversationOnly control
  run was RED: the expected shell invocation count was 0 instead of 1.
- S1/S3 public root/child journey — PASS with Profile; a temporary
  ConversationOnly control run timed out with the public tree still root-only.
  Final S1–S4 file run — 4/4 PASS.
- P12 runtime-safety file — 25/25 PASS; P12 acceptance story 9 — 7/7 PASS.
  These safety-stop scenarios can short-circuit before shell execution, so a
  ConversationOnly control run of story 9 D3 is not a valid RED signal. The
  test still now selects the host Profile to preserve its declared filesystem
  setup and ownership fixture.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS; targeted Biome check —
  PASS after formatting the two changed call sites.

These are focused test-fixture corrections, not F21 qualification or closure.

## Canonical-path consistency follow-up

The P5 and P12 ownership seeds now take `canonicalRoot` from the trusted
Profile Port's resolved `canonicalAddress.path` and use that exact value for
`normalizedRegion` and `sourceAddressSnapshot`. Each fixture asserts the
resolved Profile path equals `realpathSync(dir)`, directly checking agreement
with the host adapter's canonicalization without requiring Windows symlink
creation privileges. No symlink/junction test was added in this environment.
After this follow-up, P5 is 1/1, P12 runtime safety is 25/25, and P12
acceptance story 9 is 7/7; `tsconfig.test` typecheck, targeted Biome, and
`git diff --check` pass.

The production F21 process qualification and its raw-path cases are in a
separately owned, untracked file in the shared worktree; they are excluded from
this commit. Browser form/catalog UI migration is also outside this file
ownership boundary. This result claims only test/fixture TypeScript and Biome
compatibility with the v2 handler shape; it does not claim F21 qualification
or closure.
