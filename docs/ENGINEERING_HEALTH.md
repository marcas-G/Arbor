# Engineering health gate

Arbor uses a hard gate plus a trend snapshot. The snapshot is useful for
finding hotspots; it cannot turn a failed release gate green.

The hard gate is red when any of these fail:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm architecture`
- `pnpm test`
- Web typecheck, build or tests
- `pnpm audit --prod --audit-level high` reports a high or critical vulnerability
- the package dependency graph contains a cycle
- the PR adds a new P0 problem or upgrades an existing problem to P0
- the PR diff contains whitespace errors
- the coverage report is missing
- production-code duplication exceeds 5%
- the required CodeQL SAST job fails; code-scanning findings must be resolved or
  explicitly accepted under the repository's security policy before merge

Every PR records the requested engineering-health metrics in the uploaded JSON
artifact:

| Priority | Metric | Source | Merge behavior |
|---|---|---|---|
| P0 | Build and test status | CI commands | Required check |
| P0 | New severe defects | Known-problem delta plus static checks | A new/upgraded P0 blocks |
| P0 | Severe security vulnerabilities | CodeQL and `pnpm audit --prod --audit-level high` | Required check; high/critical SCA blocks |
| P0 | Complexity distribution | TypeScript AST | Reported; hotspot changes require focused tests |
| P0 | Duplication | jscpd | More than 5% blocks |
| P0 | Coverage | Vitest V8 | Missing report blocks; percentage is reported |
| P1 | Technical Debt Ratio | SonarQube report when configured | Reported; `not-configured` is explicit |
| P1 | Code Churn | Git diff | Reported per PR |
| P1 | Hotspot Risk | Git history plus AST | Reported per changed production file |
| P1 | Circular Dependencies | Package dependency graph | Any cycle blocks |
| P1 | Change Coupling | Git co-change history | Reported per PR |
| P1 | PR Cycle Time | GitHub pull-request event | Reported while the PR is open |

Every pull request and merge queue entry runs the same quality job and computes
all twelve metrics. The quality job includes the manifest checks, the core
suite, coverage, Web checks and the complete functional release journey. The
snapshot is produced by:

```bash
node scripts/ci/health-metrics.mjs > health-metrics.json
```

The PR and merge-queue gate uses `node scripts/ci/health-metrics.mjs --enforce`.
The health step runs even when an earlier quality step fails, so the uploaded
artifact records missing or failed checks instead of making a failed run look
complete. In enforce mode,
a new P0 in `docs/KNOWN_PROBLEMS.md`, a high/critical dependency vulnerability,
a missing coverage report, a package dependency cycle, a duplication ratio over
5%, whitespace errors, or a missing audit report returns a nonzero status and
blocks merge. The total P0/P1 inventory remains visible in the report so
existing release blockers cannot be mistaken as resolved work, but historical
backlog does not make every unrelated PR permanently unmergeable. Complexity,
churn, hotspot risk, change coupling, PR cycle time and SonarQube debt ratio
are always recorded; their current policy is review evidence because the
project has not adopted numeric limits for them. The repository settings must
require the `quality` job and the `analyze` CodeQL job for the protected
default branch; the workflow alone cannot change GitHub branch protection
settings.

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
is repository administration and cannot be changed by a workflow file. Direct
pushes to the protected branch must be disabled; all changes enter through a PR
and its required CI results. The same workflows also run on the default branch
after a merge so a bad merge is visible immediately. The repository settings
must also require the `merge_group` event when merge queue is enabled; otherwise
the required checks are not re-run on the temporary merge ref.

The quality job runs on an authorized Linux self-hosted runner because the P39
SQLite qualification needs the checkout on a canonical, runner-owned local
filesystem. The runner preflight accepts ext2/3/4, XFS, Btrfs, F2FS, exFAT and
FAT and rejects overlayfs, tmpfs, symlinked workspaces, and group/world-writable
workspaces. Configure the runner's workspace on a supported local disk; a
preflight failure is an environment failure and must be fixed before merge.

Complexity and duplication are trend metrics. A reduction is not allowed to
weaken behavior, remove required tests or move logic into a less visible file.
Changes to the four highest-complexity files require focused tests and a full
release gate before merge.
