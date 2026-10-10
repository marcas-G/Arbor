# F21 Wave A — host Project Resource Profile catalog

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Scope: implement the P1 `ProjectResourceProfilePort` contract and P12 host
startup adapter/read-only local catalog route. This is Wave A only. It does
not change CreateProject payload/handler, the Web form, ownership activation,
or any resource/authority design contract.

## Implementation

- `packages/ports/src/project-resource-profile.ts` defines the Application
  Port's path-free summary and exact ref/version resolver. `list`/`resolve`
  are immutable in-memory reads; the Port has no filesystem capability.
- `apps/single-workspace/src/project-resource-profiles.ts` validates host
  configuration and creates the startup snapshot. The production environment
  adapter intentionally retains the governed single-root `ARBOR_PROJECT_ROOT`
  input (one Profile, with optional `ARBOR_PROJECT_PROFILE_REF`,
  `ARBOR_PROJECT_PROFILE_VERSION`, and `ARBOR_PROJECT_PROFILE_NAME`). The
  generic Port/adapter supports zero/one/multiple entries, but no multi-entry
  environment configuration is introduced in this wave. When no version is
  specified, the adapter derives a stable opaque version from the canonical
  real path. Explicit versions remain host-owned and must be changed when the
  configured resource scope changes.
- Paths must be absolute and contain no lexical `..` segment. Startup resolves
  each directory with `realpath`, checks that it is a readable/searchable
  directory, and stores only the canonical `FileTree` address in the trusted
  Port entry. Missing, non-directory, or inaccessible entries remain visible
  as `available: false`; no filesystem diagnostic or path is returned.
  Invalid/duplicate refs and malformed host configuration fail startup with
  generic path-free errors.
- `GET /project-resources` serves only `{resourceProfileRef, version,
  displayName, available}` plus `conversationOnlySupported`. It follows the
  existing local-single-user directory policy: unauthenticated requests get
  401; authenticated non-local principals get generic 503 until a multi-user
  visibility contract exists. The endpoint never queries the authority
  resolver or reads files. The catalog is passed through the production
  composition Port layer and transport config.
- No GitWorktree is created. The catalog does not activate ownership claims or
  change durable Workspace boundaries.

## Evidence

RED: the first focused Vitest run failed at module resolution because the
profile adapter did not exist (`Cannot find module
../src/project-resource-profiles.js`).

GREEN: `pnpm exec vitest run
apps/single-workspace/test/project-resource-profile-catalog.test.ts` — 1 file,
8 tests passed. Coverage includes zero/one/multiple Port entries, deterministic
ordering and canonical FileTree mapping, malformed/duplicate refs, lexical
path traversal rejection, missing/non-directory/permission-denied
availability without path disclosure, restart-stable derived version and
version change after moving the configured path, environment config parsing,
and the actual HTTP shell's authenticated path-free catalog response.
Permission denial is exercised through the adapter's injected filesystem
boundary; no platform ACL was changed.

`pnpm typecheck` passed (`tsc -b` and test-project typecheck). Targeted Biome
passed for the seven changed source/test files. `git diff --check` passed.
No full test suite, browser test, or full daemon process-restart test was run.

## Wave boundary / remaining work

Wave B still must consume the Port from CreateProject's absent-receipt handler
branch and preserve F23 ordering. Wave C still owns Web form selection and the
F21 browser journey. Ownership activation remains unchanged and is not proven
by this result. FT-DG-01 OPEN-1 Profile-source audit, OPEN-2 historical v1
same-ID successful replay, and OPEN-3 post-commit durable Attention remain
open; F21 is not claimed qualified or closed.
