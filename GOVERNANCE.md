# Arbor repository governance

Status: proposed for owner adoption through review and merge. This document governs repository work, not product semantics. No existing frozen design or accepted decision is superseded by it.

## Authority and ownership

| Asset | Authority and responsibility |
|---|---|
| docs/design/00-problem-goals.md | Canonical problem and product goals |
| docs/design/01-scenarios.md | Canonical observable scenarios |
| docs/design/02-system-design.md | Canonical domain semantics and invariants |
| docs/design/03-detailed-implementation-design.md and owner implementation contracts | Canonical implementation contracts within their respective scopes |
| docs/decisions/ and accepted governance records | Why and how an exact change was authorized; not a second current contract |
| docs/PROJECT_INTENT.md | Product-facing summary; not normative |
| docs/ARCHITECTURE.md | Current implementation map; not normative |
| docs/CURRENT_STATE.md | Current implementation and evidence limits |
| docs/KNOWN_PROBLEMS.md | Current defect inventory, including release blockers |
| docs/OPEN_QUESTIONS.md | Outstanding decisions, not implicit authorization |
| docs/RELEASE_PROGRESS.md | Release progress and exact qualification limits |
| AGENTS.md | Agent entry point and existing hard rules |
| docs/engineering/ | Repository engineering practices; may not change product contracts |
| planning/ and verification records | Work plans, historical decisions and evidence scoped to their revision |

The project owner (marcas-G) retains manual governance authority. Agents propose, implement and verify within authorized scope; they cannot self-authorize product semantics, broaden permissions, waive an invariant, redefine completion, or claim independent human approval. Package ownership describes technical responsibility, not an additional user or security principal.

An unresolved contradiction between authoritative contracts is a Design Gap. Stop the affected slice, identify both exact clauses and their revisions, present a counterexample, and obtain the owner's decision. Do not silently select whichever clause matches the code. An accepted proposal is not implemented until the approved landing is applied, nor qualified until the required evidence exists.

## Change control

Classify changes as defect repair, refactoring, feature/contract change, engineering infrastructure, or documentation. Contract changes require the existing Design Gap/accepted proposal process. Changes within an existing contract use the normal PR path. Changes to repository policy itself require owner review; exceptions are scoped, reasoned, time-limited and recorded in the PR with a tracking item. No exception can bypass a product safety invariant.

One PR should have one coherent intent; split independent work. Integrate frequently into the designated development line and use short-lived work branches. Do not assume a branch is releasable because it contains another branch. The owner selects the integration line, approves branch protections and promotes a release candidate. Do not directly push to the protected default branch or bypass a required check.

## Evidence and state

Distinguish accepted design, implemented behavior, verified behavior and released artifact. Evidence records the commit or artifact digest, command, environment, provider, scope, exit status, failures/skips and limitations. An old result cannot certify a new tree. Preserve failed runs; record a rerun separately. A test fixture, mock, or historical result is not production qualification. Current-state summaries reference evidence rather than duplicating its raw contents.

Use current documents for current facts; use historical records for provenance. Do not rewrite prior results to match new outcomes. Never delete historical evidence merely to reduce repository size; classify and index first, retain required audit material, and move only after reference checks.

## Enforcement

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [engineering practices](docs/engineering/README.md). Existing package DAG, architecture tests, Biome, strict TypeScript, test manifests and CI remain the primary executable checks. The design-chain checker is initially a standalone check, not a replacement for these checks. Enable any new mandatory gate only after its baseline and negative tests are validated. Security restrictions on CI runner access take precedence over convenience.

Review governance on material architecture, release, or team changes; update the owning source instead of adding competing copies.
