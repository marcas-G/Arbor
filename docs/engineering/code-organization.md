# Code organization standard

Status: adopted for new code on 2026-11-25. Existing violations are frozen
inventory (see `source-governance-backlog.md`); they are migrated in seams,
not by a big-bang rewrite. This document governs code organization only —
product semantics remain owned by the frozen design chain.

## Why this exists

Independent audits on 2026-11-25 found: 381 test files and 24 production
files named after planning phases (`p39-…`, `ah10-…`); 72 occurrences of the
token `p39` alone inside production identifiers; `apps/single-workspace`
grown to ~38.5k lines — larger than any domain package — with business logic
(authorizers, handlers, rebuilds) at its src root; ~140 phase-numbered test
files flat in `tests/`; 15 vitest configs at the repository root. None of
these are caught by the existing architecture tests, which police package
edges but not placement or naming.

## Rule 1 — Names describe behavior, never planning provenance

A production identifier, file, or directory name must answer "what does it
do", not "which phase introduced it".

- Forbidden in new code: phase/gap/qualification codes in identifiers and
  file names — `p<N>`, `ah<N>`, `rai`, `f<N>`, `s<N>-`, `scrc`, `crac`,
  `capa`, `egp`, `vdc`, and compound forms like `AH19NativeCheckpointRecovery`.
- Acceptable: a stable historical name that has become the product term
  (e.g. the wire/protocol names frozen in design contracts). When in doubt,
  the design-chain term wins; the planning code does not.
- Existing names are not renamed in bulk. A module takes its semantic name
  the next time it is materially modified (the R5 decomposition seam is the
  natural moment). `planning/history/` keeps the code→semantics map as
  modules migrate.
- Tests follow the same rule for new files; the existing `pN-*` inventory
  in `tests/` is frozen until the R5 test-suite pass reorganizes it.

## Rule 2 — Package placement

| Location | Allowed content |
|---|---|
| `packages/domain` | Pure domain transitions (`R = never`), no infrastructure imports (existing hard rule) |
| `packages/<runtime>` | One runtime concern each (agent, tool, execution, projection, provider-runtime, model-context, application orchestration); no composition decisions |
| `packages/ports` | Effect service contracts only; implementations live in adapters |
| `adapters/<infra>` | One infrastructure family each (sqlite, sandbox, blob, environment); adapter errors never cross the port boundary (existing hard rule) |
| `apps/single-workspace` | **Composition only**: wiring, composition root, transport hosting, launcher. New rule: no business decision logic, no authorization policy, no projection query families, no migration logic. A file that would violate this belongs in the owning `packages/` or `adapters/` package. |
| `apps/web` | Presentation only (existing rule) |

Admission test: "if two different compositions could want a different version
of this behavior, it is not composition". Authorizers, handlers, rebuilds,
policy preparation, schema upgrades fail this test today; they are the
migration backlog.

## Rule 3 — State predicates are owned, not spelled out

Every union of AgentLoopStep/Execution/Work states that participates in a
decision (replayable, terminal, pre-settlement, …) must be expressed through
a predicate exported by the owning package — never as a repeated chain of
`state === "A" || state === "B" || …` at use sites. Adding a state must
require touching the predicate module, not every consumer.

## Rule 4 — Directories are organized by semantics

- Test files for a package live in that package's `test/`; cross-package
  and journey tests live under `tests/<concern>/` (`functional/`,
  `architecture/`, `capability/`, `convergence/`, `configs/`). New top-level
  test directories require an entry here.
- Vitest/Playwright configs live in `tests/configs/`, not the repository
  root. The root `vitest.config.ts` is the single deliberate exception:
  Vitest's default config discovery depends on it for bare
  `pnpm vitest run <file>` invocations. Scripts that reference configs by
  root path update in the same change as any config move.
- Runtime evidence, fixtures and generated material never mix with
  configuration directories. Evidence belongs in artifact storage; the
  repository keeps indexes and digests (see GOVERNANCE "Evidence and state").

## Rule 5 — Public surface is deliberate

- No new `export *` barrels re-exporting another barrel.
- A package's `index.ts` exports its public contract; internal modules are
  imported by path only inside the package. Architecture tests may pin a
  package's export list to make surface growth a reviewed event.

## Enforcement

- New code violating Rules 1/2/4 is a review blocker; the reviewer cites
  this file.
- Rule 3 lands as an architecture test (predicate ownership scan) before
  the next seam migration.
- The frozen inventories (phase-named files, app-root business files,
  root-level configs) are listed in `source-governance-backlog.md` and
  shrink monotonically; growth of any inventory is a CI-visible regression.
