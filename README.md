# Arbor

Arbor is a durable, governance-oriented multi-agent work system. A Workspace
holds long-lived responsibility; executions, providers, tools, recovery, and
verification remain separate runtime concerns.

## Local start

Install the pinned toolchain (Node 24.21.0 and pnpm 12.4.2), then run:

```powershell
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the TypeScript workspaces and web client, starts the local
single-user daemon, and serves the app at `http://127.0.0.1:8787`. It creates
an ignored `arbor-slice.db` in the current directory unless `ARBOR_DB` is set.
Set `ARBOR_HTTP_PORT` to choose another port.

The default is a local fake provider. To configure a real provider, copy
`apps/single-workspace/arbor.config.example.json` to the ignored
`arbor.config.json` and provide its required secret by the documented method.

## Verification

```powershell
pnpm check
```

`pnpm check` runs linting, TypeScript checks, architecture tests, core tests,
and the web package checks.
