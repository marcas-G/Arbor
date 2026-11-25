# GAP-TOOL-01: registered project tools are model-visible but never executable

Status: DRAFT — for manual governance adjudication. No implementation
is authorized by this draft. Evidence record:
`docs/engineering/audits/tool-capability-ownership-2026-11-25.md`.

## Observed behavior

A committed project tool registration is unioned into the model-visible
catalog (`packages/tool-runtime/src/catalog.ts:360-371`,
`Builtins ∪ CommittedRegisteredProjectToolDefinitions`), but the
execution path consults only the builtin definition store: a call to a
registered project tool misses in `ToolDefinitionStore`, and the denial
surfaces as `InvocationAuthorityDenied`
(`packages/tool-runtime/src/runtime/invocation-setup.ts:61-70`; even with
a definition present, executor lookup fails at `:103-104`). No component
compares the two sets; the failure message attributes to authority what
is actually "no executor".

## Why this is a gap, not a bug fix

Whether "registration without execution" is intended product semantics
(an intentionally read-only advertisement surface from the P12 era), or
an unfinished seam (registration should eventually reach the executable
set), is a product-semantics decision. The architecture-evolution plan
explicitly stops at such decisions. Three coherent resolutions exist:

- **A. Intended**: registration is advertisement-only for this release.
  The catalog should exclude unexecutable entries (or mark them), and
  the denial path should say "tool not executable" instead of
  `InvocationAuthorityDenied`.
- **B. Unfinished**: registered tools are meant to execute through a
  project-supplied executor route that P12 scoped out. Then the gap
  stays open with an explicit KP entry until that route is designed.
- **C. Remove**: `RegisterProjectTool` is retired until execution
  support exists (visibility follows executability).

## Evidence to gather for adjudication

- Whether any real usage registers a project tool today (dogfood
  records, qualification fixtures).
- The P12 contract text covering project tool registration intent.

## Handling regardless of outcome

The misleading denial classification (authority vs no-executor) is an
implementation-quality issue within existing contracts and may be
repaired once the semantics decision lands; the catalog/execution set
divergence itself awaits the owner's choice among A/B/C.
