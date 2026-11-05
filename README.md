# Arbor

Arbor is a durable, governance-oriented multi-agent work system. A Workspace
holds long-lived responsibility; executions, providers, tools, recovery, and
verification remain separate runtime concerns.

## Local start

Install the pinned toolchain (Node 24.21.0 and pnpm 12.4.2), install the
workspace dependencies, and register the user command once:

```powershell
pnpm install --frozen-lockfile
npm link
```

Start Arbor from any directory with:

```powershell
arbor
```

The same command group also provides `arbor start --no-open`, `arbor status`,
`arbor stop`, and `arbor doctor`. `arbor open` is an explicit alias for the
default behavior.

The command prepares missing build artifacts, starts the local single-user
service, opens the app at `http://127.0.0.1:8787`, and stores application data
in Arbor's managed application directory. Users do not need to choose a
database or data path. `arbor --port <port>` is available when another local
service already uses the default port.

The default is a local fake provider. To configure a real provider, copy
`apps/single-workspace/arbor.config.example.json` to the ignored
`arbor.config.json` and provide its required secret by the documented method.

## Verification

```powershell
pnpm check
```

`pnpm check` runs linting, TypeScript checks, architecture tests, core tests,
and the web package checks.

Release-functional tests build the production daemon and Web client, launch
them against a fresh temporary database and controlled HTTP model boundary,
then drive the public API and a real browser:

```powershell
pnpm test:functional
```

Use `pnpm check:release` to run both the engineering checks and the functional
release gate. On non-Windows machines, install Playwright Chromium once with
`pnpm exec playwright install chromium`.
