# V6 Fresh Execution Registry Drift Qualification

Status: **IMPLEMENTED; QUALIFICATION NOT RUN**

## Scope

The existing P9 terminal proof remains in place. The test now starts a second
public root project and Work after that terminal Step; it does not create a
second ProviderTurn on the terminal Execution. The second Work reaches a
Pending Executable approval, and its public Workspace Detail CandidateRead is
captured before changing the V2 registry source/high-water pair.

The test then kills the daemon, changes the controlled source/high-water pair,
restarts the daemon on the same SQLite database, and expects the fresh
CandidateRead bundle revision/digest and provider registry revision/digest to
advance. A P1 request prepared from the old candidate must return
`StaleSandboxPolicyInputs` without a decision/event. A newly prepared request
from the refreshed candidate keeps the same ReadOnly profile, provider
version/capability revision and Disabled network mode, and commits while the
Executable approval remains Pending and unconsumed. The assertions require no
ToolInvocation, so this case makes no claim that a provider or OS sandbox ran.

## Contract basis

The scenario uses the accepted P10/P1 pre-intent CandidateRead bootstrap,
Option A exact OS tuple selector, and closed ProviderTurnId V2 contracts.
P9 terminal behavior remains unchanged. CandidateRead remains presentation
data; the test submits only the existing P1 payload fields from the selected
candidate and common preconditions. The synthetic D2 manifest/source is test
fixture evidence only and does not establish `OSSupported` or real-provider
qualification.

## Verification status

- Functional process test: **NOT RUN** (requested; main-tree sweep owns test
  resources).
- Typecheck/build/Biome/full gates: **NOT RUN**.
- Static review: reviewed the isolated diff and confirms that it changes only
  the functional test and this result record; no production or design files
  are touched.
- `git diff --check`: PASS.

Pending focused run pattern:

```powershell
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/sandbox-policy-v6-registry-drift-restart.functional.test.ts
```

No design or production files are changed by this qualification patch.
