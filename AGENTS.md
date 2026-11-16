# Arbor — Agent Guide

Arbor is a Linux-first, single-user coding agent organized around long-lived
Workspaces and Work items. Read `docs/design/00-problem-goals.md` before
changing product behavior; the remaining frozen design documents explain the
system contracts.

## Sources of truth

The frozen design chain owns product and implementation semantics:

- `docs/design/00-problem-goals.md` — purpose, goals and success criteria.
- `docs/design/01-scenarios.md` — observable end-to-end scenarios.
- `docs/design/02-system-design.md` — domain semantics and invariants.
- `docs/design/03-detailed-implementation-design.md` — executable contracts,
  ports, persistence, package DAG and phase boundaries.

For the current executable state and release limits, use:

- `docs/PROJECT_INTENT.md`
- `docs/CURRENT_STATE.md`
- `docs/ARCHITECTURE.md`
- `docs/KNOWN_PROBLEMS.md`
- `docs/OPEN_QUESTIONS.md`

Planning results are historical evidence for the exact revision they name. They
must not override the maintained current-state documents.

## Design governance

`docs/design/**` is manually governed source of truth. Coding and planning work
must not silently edit it or invent new product semantics. If implementation
finds a semantic gap, stop that implementation slice and record a Design Gap
with failure evidence for manual governance. Codex may apply only the exact
landing package of a proposal the user/manual governor has already accepted;
the proposal hash, decision record and consistency review must remain auditable.

## Current product constraints

These are constraints for the current Linux single-user release target:

- Runtime schema is 57. The offline copy upgrader accepts disposable
  qualification sources 36–38 and 44–57. Preserved user databases remain
  unsupported until their migration and recovery contract is qualified.
- Production process execution defaults to `Disabled`; no ordinary production
  composition may claim a Native OS `Supported` tuple without the required
  qualification evidence.
- Workspaces are the authorization and resource boundary. Workspace grants
  persist across tasks and restarts. A Parent may allocate only within its own
  current ceiling; a user revocation remains in force until the user reverses
  it.
- Independent verification uses the accepted temporary-copy design. It must
  bind the exact Verification, Execution, Work revision, input set, authority
  revision and sandbox policy; test-only or trusted-local shortcuts are not
  release evidence.
- The first-run model setup surface accepts a real provider configuration,
  checks the connection, saves it locally and reloads into the workbench.
  Missing or failed model configuration must not start a task.
- The Web UI uses Tailwind utilities, project-owned shadcn-style primitives
  and Radix primitives. Keep Arbor tokens, reset and reduced-motion support;
  do not reintroduce CSS Modules or hand-written modal focus traps.
- Fake and test-echo providers, test-only environments and harnesses are for
  tests. They must not be used to claim real-provider or release behavior.

## Package and architecture rules

The package graph is a directed acyclic graph enforced by
`tests/architecture/**`. Package boundaries represent real dependency or
replacement boundaries; do not create one package per object and do not merge
replaceable adapters merely to reduce the directory count.

Allowed direct internal dependencies are:

| Package | Allowed direct dependencies |
|---|---|
| `domain` | none |
| `ports` | `domain` |
| `application` | `domain`, `ports` |
| `model-context` | `domain`, `ports` |
| `agent-runtime` | `domain`, `ports`, `application`, `model-context` |
| `execution-runtime` | `domain`, `ports`, `application`, `agent-runtime` |
| `provider-runtime` | `ports` |
| `tool-runtime` | `domain`, `ports` |
| `projection-runtime` | `domain`, `ports` |
| `api-contracts` | `domain` |
| `adapters/*` | `domain`, `ports` |
| `testkit` | test-only dependencies |
| `apps/*` | composition root; required packages and adapters |

Additional rules:

- `domain` has no infrastructure imports and uses `R = never` for domain
  transitions.
- Runtime packages depend on ports, never concrete adapters. Adapters never
  depend on application or runtime packages.
- Application commands own canonical semantic mutation. Projections never
  decide authority.
- `Effect<A, E, R>` keeps success semantics, narrow typed failures and exact
  capabilities visible. Do not introduce a global service locator, broad
  `Error` algebra or catch-all error handling.
- Do not deep-import another package. Export public package contracts through
  its `index.ts` and declare the dependency in `package.json`.
- Do not reintroduce legacy names as new-write semantic authority. Legacy
  codecs and records are read-only compatibility, audit or fail-closed paths.
- Keep transport code under `apps/*/src/transport`; packages, adapters and
  tests must not acquire transport responsibilities.
- Keep verification input copying and cleanup in the sandbox adapter; the app
  only prepares the binding and composes the service.

## Development and verification rules

- Work from observable user behavior and the frozen contract. For a behavior
  change, write the failing requirement test before implementation.
- Run the narrowest relevant checks while iterating, then run the complete
  release gate before claiming completion:

  ```text
  pnpm lint
  pnpm typecheck
  pnpm architecture
  pnpm test
  pnpm --filter @arbor/web typecheck
  pnpm --filter @arbor/web build
  pnpm --filter @arbor/web test
  pnpm check:release
  ```

- The CI source of truth is the repository workflow. It may use an authorized
  local/self-hosted Linux runner, but every result must be attached to the
  exact commit and recorded as reproducible evidence.
- Missing tooling or dependencies are not completion evidence. Install the
  required tool in the authorized workspace and continue. Report actual test
  failures, security findings and unresolved product decisions separately.
- Do not claim coverage, release qualification or real-provider behavior from
  a fake provider, an internal API call, a test-only environment, a stale
  `dist`, or a historical result.
- Preserve unrelated user changes. Never use `git reset`, `git clean`, forced
  checkout or broad generated-file replacement to make a test pass.
- Keep changes small enough that one agent can review the behavior and its
  evidence. Before parallel work, define ownership by files or package and
  merge only after the same checks pass on the resulting tree.
- Develop on a branch and deliver changes through a pull request. Do not push
  directly to the protected default branch or merge around required CI checks.
  Every PR must run the health snapshot, security audit and relevant tests on
  the self-hosted Linux runner; fix failures before merge.

## Core vocabulary

```text
Workspace   long-lived responsible identity, not a folder/session/process
Work        phase outcome requirement: Open, Completed or Cancelled
Execution   recoverable execution episode; one active main execution per Workspace
Agent       runtime execution role, not a persisted long-term entity
Verification PASS != Parent Acceptance != Work Completed
```

When a package or feature appears to violate these rules, first update the
architecture/current-state analysis with concrete evidence. Do not hide the
problem by renaming a package, adding a barrel export, weakening a test, or
turning a missing capability into a mock.
