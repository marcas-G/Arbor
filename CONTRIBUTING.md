# Contributing to Arbor

Start with [AGENTS.md](AGENTS.md) and the [governance map](GOVERNANCE.md). Read the owning design clauses, current state, known problems and affected module before changing behavior. Do not load all historical planning documents by default.

## Standard change lifecycle

1. Identify the problem, user-observable outcome or engineering invariant, and the affected files/modules. Link a tracking issue or existing design gap where one exists.
2. Classify the change. If existing design cannot answer a required semantic question, stop the affected slice and follow manual governance; do not let implementation choose the answer.
3. Create a focused branch from the agreed integration line. Record the baseline SHA. Coordinate concurrent edits by module/file ownership.
4. For behavior changes, reproduce the failure or write the requirement test first. For refactors, pin the existing externally observable behavior, including failure and recovery behavior.
5. Implement the smallest coherent change. Keep unrelated formatting, dependency upgrades, migrations and test changes out of the same PR unless required and explained.
6. Run the relevant focused tests and the existing applicable quality gates. Record commands, results, skips and exact source/artifact identities; never mark unrun checks as passing.
7. Submit a reviewable diff. Explain why, design clauses, risk, alternatives where material, tests, rollback and changes to current knowledge. Review code and evidence against the existing contract.
8. Obtain owner review where required and merge only through the configured integration process. Update current-state/known-problem records only to the extent proved; retain the historical evidence.

## Checks

The current package scripts are the executable reference:

    pnpm lint
    pnpm typecheck
    pnpm architecture
    pnpm test:manifest
    pnpm test
    pnpm --filter @arbor/web typecheck
    pnpm --filter @arbor/web build
    pnpm --filter @arbor/web test
    node scripts/governance/check-design-chain.mjs
    node --test scripts/governance/check-design-chain.test.mjs

The last two commands are new standalone checks. They do not change the existing required CI. Follow AGENTS.md and docs/ENGINEERING_HEALTH.md for complete gates; use pnpm check:release, packaging and real-provider qualification when claiming release readiness. Test on a clean, authorized environment; never test migrations or destructive operations against preserved user data.

## Review

Review semantic correctness, responsibility and dependency direction, error/interrupt paths, transaction and recovery behavior, authority/secret boundaries, tests and truthful documentation. Avoid approving changes simply because line counts or aggregate health scores improve. Refuse scope creep, duplicated authority and evidence inflation. Report existing defects even when they block a release; do not punish disclosure as though it introduced the defect.

PR quality and CodeQL use ephemeral GitHub-hosted Linux runners. Public fork code must not execute on a persistent self-hosted runner. Environment-specific qualification outside hosted CI requires an authorized isolated environment and separate evidence. See [engineering practices](docs/engineering/README.md).

## References

- Google Engineering Practices: https://google.github.io/eng-practices/review/
- Small changes: https://google.github.io/eng-practices/review/developer/small-cls.html
- Rust RFC process: https://github.com/rust-lang/rfcs/blob/main/README.md
