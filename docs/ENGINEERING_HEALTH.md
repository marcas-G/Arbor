# Engineering health gate

Arbor uses a hard gate plus a trend snapshot. The snapshot is useful for
finding hotspots; it cannot turn a failed release gate green.

The hard gate is red when any of these fail:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm architecture`
- `pnpm test`
- Web typecheck, build or tests
- `pnpm audit --prod` reports a high or critical vulnerability
- the package dependency graph contains a cycle
- the maintained problem list contains an active P0 release blocker
- the PR diff contains whitespace errors
- the coverage report is missing
- production-code duplication exceeds 5%
- the required CodeQL SAST job fails; code-scanning findings must be resolved or
  explicitly accepted under the repository's security policy before merge

The repeatable snapshot is produced by:

```bash
node scripts/ci/health-metrics.mjs > health-metrics.json
```

The PR gate uses `node scripts/ci/health-metrics.mjs --enforce`. In that mode,
an active P0 in `docs/KNOWN_PROBLEMS.md` or a package dependency cycle returns a
nonzero status and blocks merge. The repository settings must require the
`quality` job for the protected default branch; the workflow alone cannot
change GitHub branch protection settings.

It records the commit, dirty-tree state, PR base, changed lines/churn, AST
branch complexity, large-file count, production-code duplication, coverage,
package count/cycles, changed-file hotspot risk, Git change coupling, PR cycle
time and the current P0/P1 problem counts. The audit result is included in the
same JSON report. Tests and build results remain separate required CI steps
because they are executable checks rather than source metrics.

The current working tree is intentionally not a release baseline: it contains
pre-existing uncommitted work. A baseline may be adopted only from a clean
commit. Until then, the numbers are diagnostic and must not be presented as a
quality trend.

SonarQube technical-debt ratio remains `not-configured` until a SonarQube
server and report are supplied as CI secrets/artifacts; no local estimate is
substituted. PR cycle time is measured on pull-request events, while merge
queues report it as unavailable because a merge-group event has no single PR.

The `quality` job must be configured as a required status check on the protected
default branch, together with the `analyze` CodeQL job. GitHub branch protection
is repository administration and is deliberately not silently changed by a
workflow file. Direct pushes to the protected branch are disabled; all changes
enter through a PR and its required CI results. The same workflows also run on
the default branch after a merge so a bad merge is visible immediately.

Complexity and duplication are trend metrics. A reduction is not allowed to
weaken behavior, remove required tests or move logic into a less visible file.
Changes to the four highest-complexity files require focused tests and a full
release gate before merge.
