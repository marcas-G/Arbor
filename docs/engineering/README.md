# Engineering practices

Scope: repository implementation, review and maintenance. Product semantics remain owned by the frozen design chain. This guide complements, not replaces, AGENTS.md, ARCHITECTURE.md and ENGINEERING_HEALTH.md.

Companion documents: [code-organization.md](code-organization.md) (placement and naming rules), [effect-conventions.md](effect-conventions.md) (the E01–E12 Effect development standard), [architecture-evolution.md](architecture-evolution.md) (the sequenced capability-oriented refactor plan and its measurement discipline).

## Module boundaries and code

Use the existing pnpm workspace: packages for domain/ports/application/runtimes/contracts, adapters for replaceable implementations, apps for composition and transport. Do not create a package merely to lower file count. Every materially changed module must have a stated responsibility, owned state and write authority, public API, allowed dependencies, failure/recovery semantics and test boundary. Put that information in the existing architecture map or a nearby module README only if needed; link rather than copy the DID.

Keep pure domain decisions pure; use closed ADTs, branded identifiers and exhaustive matching where appropriate. Preserve narrow Effect A/E/R types and explicit ports/Layers. Decode unknown external data at boundaries. Avoid unsafe casts, hidden mutable globals, service locators, catch-all business failures and nested runtime execution. Use scoped acquisition/release, bounded concurrency, cancellation and retry only when semantics permit. Command identity, idempotency, transaction ownership, fencing, authority and durable evidence are not incidental plumbing. Prompt changes are behavior changes, not ordinary prose edits.

Imports use declared package public APIs; prohibit cross-package relative/deep imports. Maintain the DID package DAG and existing architecture tests. Use the installed Effect version (4.0.0-rc.115 at the audited base); do not mix v3 examples or change dependencies opportunistically. Biome and TypeScript strict configuration are the formatting/type baseline. Keep code understandable; extract coherent responsibilities, not arbitrary line-count chunks. A refactor must preserve public contracts, transaction boundaries, order of side effects, interruption and replay semantics.

### Mandatory source file size limit

Owner direction: handwritten source files, tests and engineering scripts must contain at most **800 physical lines**, including comments and blank lines. The check counts LF, CRLF and CR, without treating a final newline as an extra line. Markdown, lock/config data and build output are not covered by the source-extension check. No new oversized source file, reformatting trick, minification, artificial truncation, or permanent exception is allowed. Split by cohesive responsibility, not arbitrary line ranges.

`pnpm check:source-lines` is the strict repository-wide gate; it reports every over-limit tracked source path and fails until all are at or below 800. It is **not** part of `pnpm check` while its baseline is open (GOVERNANCE requires a validated baseline before a gate becomes mandatory); it remains required on the exact release promotion SHA and CI surfaces it as an advisory step. Existing oversized files are explicit unresolved refactor work; the branch cannot pass the strict gate while they remain.

During staged refactoring, run `node scripts/governance/check-source-lines.mjs --baseline <pre-change-commit>` to reject new oversized files or growth of existing oversized files relative to that specific commit. This transition command is not a replacement for strict qualification. It reports legacy violations and does not certify them. Use the actual parent or reviewed PR baseline, not an arbitrarily older baseline. Run `pnpm test:source-lines` for the rule's tests. Stage new files before running the check because it enumerates the Git index. Do not modify frozen historical evidence to satisfy a source line limit.

## Tests and health

Use the existing proof-level/test manifest strategy. Distinguish pure, port, application, process and public tests. Unit tests do not qualify real providers or native isolation. New tests should express a behavioral invariant rather than mirror implementation details. Include negative, recovery and interruption cases where risk warrants. Preserve historical migration tests and proof fixtures until their consumers and compatibility obligations are understood.

Use existing health metrics as evidence: complexity, duplication, coverage, churn, cycles and change coupling guide hotspot selection, not automatic rewriting. Report both per-function complexity and file-level aggregation when extending the tool. Never lower thresholds, remove tests or relocate code merely to pass a metric. Baseline existing findings and prevent new violations; tighten incrementally. Missing evidence is unknown, not green.

## CI and release

The CI and CodeQL workflows use ephemeral GitHub-hosted Ubuntu 24.04 runners for PRs. The quality workflow retains the Linux local-filesystem preflight and the existing full test sequence, and installs Chromium for functional UI tests. Because this is a public repository, untrusted fork code must never run on a persistent host containing credentials or user data. Environment-specific qualification outside hosted CI must use a reviewed, disposable isolated runner with no persistent credentials/data and strict runner access controls. Require owner review of workflow changes and pin third-party actions to reviewed immutable commits when practical. Do not enable a required check until its execution and failure modes are validated. Do not treat a skipped job as passing qualification. See GitHub's secure-use guidance below.

Maintain the existing check:release contract until an explicitly reviewed replacement exists. A future risk-based CI split may run fast checks on PRs and full qualification on trusted candidate revisions, but cannot waive tests required for safety, recovery, schema changes or release claims.

## Documentation

Current facts live in the existing status documents, design in the existing frozen chain, decisions in decisions records, evidence in verification/planning results. Avoid repeating version numbers or test counts in AGENTS.md. Link to a canonical owner. Use tutorials, how-to, reference and explanation categories for user documentation when needed, without imposing a mass directory rename.

## External precedents

- VS Code source organization: https://github.com/microsoft/vscode/wiki/Source-Code-Organization
- VS Code coding guidelines: https://github.com/microsoft/vscode/wiki/Coding-Guidelines
- Google code review standard: https://google.github.io/eng-practices/review/reviewer/standard.html
- Kubernetes contribution/design process: https://github.com/kubernetes/community/blob/main/sig-multicluster/CONTRIBUTING.md
- GitHub Actions security: https://docs.github.com/en/actions/reference/security/secure-use
- Rust RFCs: https://github.com/rust-lang/rfcs
- Diataxis: https://diataxis.fr/

These sources inform Arbor's practices; none overrides its product contracts.
