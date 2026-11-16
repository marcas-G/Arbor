## Change

Describe the user-visible behavior or engineering contract changed by this PR.

## Evidence

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm architecture`
- [ ] `pnpm test`
- [ ] `pnpm test:coverage`
- [ ] Web typecheck, build and tests
- [ ] `pnpm audit --prod`
- [ ] `pnpm health:metrics -- --enforce`
- [ ] The health artifact was reviewed: coverage, churn, complexity, duplication,
      hotspot risk, change coupling, security and known P0/P1 problems.
- [ ] If this PR changes a high-complexity hotspot, focused tests are included.
- [ ] If SonarQube is configured, the technical-debt ratio is recorded; otherwise
      the PR states why the metric remains `not-configured`.

## Scope and safety

- [ ] No direct default-branch push or merge around required CI.
- [ ] Design semantics are unchanged, or the accepted governance landing is linked.
- [ ] Tests cover the changed observable behavior.
- [ ] Unrelated working-tree changes are not included.
