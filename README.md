# Arbor

Arbor is a local, single-user work system organized around Projects and long-lived Workspaces. The daemon serves the Web app at `http://127.0.0.1:8787` by default.

## Install, start, stop, restart

Use Node.js 24.21.0 and pnpm 12.4.2. Install dependencies and build the operator and application:

```powershell
pnpm install --frozen-lockfile
pnpm build
```

Before the first start, create a schema 42 database with `fresh` (or upgrade an existing stopped database with `copy` as shown below). Then set `ARBOR_DB` to that completed database and start Arbor:

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode fresh `
  --database 'C:\Arbor Data\arbor-v42.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-manifest.jsonl'
$env:ARBOR_DB = 'C:\Arbor Data\arbor-v42.db'
pnpm start
```

Startup requires the selected database to already be exactly at schema 42. The daemon does not upgrade it on startup. `pnpm start` builds the Web client and runs the daemon in the foreground. Press `Ctrl+C` to stop it; run `pnpm start` again to restart. Set `ARBOR_HTTP_PORT` before starting to select another port. Keep the daemon stopped while copying or upgrading its database. For an existing database, stop Arbor and complete the `copy` operation below before pointing `ARBOR_DB` to its upgraded copy and starting.

PowerShell accepts quoted paths with spaces. For example:

```powershell
$env:ARBOR_DB = 'C:\Users\Example User\Arbor Data\arbor.db'
$env:ARBOR_HTTP_PORT = '8788'
pnpm start
```

## Database schema 42

The current runtime requires schema version 42 before startup. It does not apply migrations at startup. An older database must first be upgraded offline; do not start Arbor against a database at any other version.

The examples below assume the repository root is the current directory. For each new `fresh` or `copy` job, use separate, new target, P39 report, and copy-manifest paths. A `resume-copy` job must reuse the exact source, target, report, and manifest paths from its interrupted `copy`; do not allocate replacement paths for a resume. `copy` accepts source schema versions 36, 37, or 38 only. Keep the source daemon stopped and the source database unchanged through completion. Never point the operator at a live database or use the upgraded copy until the command reports success. The command validates the report and manifest chain as part of its operation. The manifest records local path metadata: retain it on the machine where the upgrade ran and redact it before sharing. Keep the original database as the rollback point; on success, explicitly point `ARBOR_DB` at the upgraded copy before restarting Arbor.

First build the CLI:

```powershell
pnpm build
```

For a brand-new empty database:

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode fresh `
  --database 'C:\Arbor Data\arbor-v42.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-manifest.jsonl'
```

For an existing database, stop Arbor first, then create and upgrade a separate copy. Preserve the original file unchanged:

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode copy `
  --source-database 'C:\Arbor Data\arbor-slice.db' `
  --database 'C:\Arbor Data\arbor-v42-copy.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-copy-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-copy-manifest.jsonl'
```

If that copy operation stops partway through, keep the same source stopped and unchanged, then resume with the exact same source, target, report, and manifest paths:

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode resume-copy `
  --source-database 'C:\Arbor Data\arbor-slice.db' `
  --database 'C:\Arbor Data\arbor-v42-copy.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-copy-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-copy-manifest.jsonl'
```

Only after the upgrade reports success, use the new copy:

```powershell
$env:ARBOR_DB = 'C:\Arbor Data\arbor-v42-copy.db'
pnpm start
```

The original remains the rollback point. To roll back, stop the daemon and point `ARBOR_DB` back to the original database. Do not overwrite or delete the original as part of an upgrade.

## Provider configuration

The default provider is deterministic and local. To use a DeepSeek or other OpenAI-compatible endpoint, copy `apps/single-workspace/arbor.config.example.json` to an untracked `arbor.config.json`. The supported fields are `provider.deploymentId`, `modelRef` (`model-openai`), `endpoint`, `wireModelName`, `secret`, and optional `executionPolicyOverrides` / `extraHeaders`. The example is configured for DeepSeek; change the endpoint and wire model name for another compatible service.

The sample uses `secret: { "kind": "env", "ref": "ARBOR_MODEL_API_KEY" }`. Provide the key in the current PowerShell session without placing its value in command history:

```powershell
$env:ARBOR_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Provider API key' -AsSecureString)).Password
pnpm start
```

The supported alternative is a key file: `"secret": { "kind": "file", "ref": "C:\\Users\\Example User\\.config\\arbor\\provider.key" }`. Restrict access to that file to your user. The config file supports env and file SecretRefs; do not put a real key in config, source control, a command argument, shell history, or logs. Keep the key only in the environment or private key file.

On Windows, explicitly set `ARBOR_CONFIG` to the private config file (or keep the untracked `arbor.config.json` at the repository root); do not rely on the `$HOME` fallback. For example: `$env:ARBOR_CONFIG = (Resolve-Path '.\arbor.config.json').Path`. Legacy `ARBOR_MODEL_*` environment configuration is also supported; the standard config file is the preferred source.

## Projects, files, and approvals

Before creating a Project that needs files, expose a host directory using `ARBOR_PROJECT_ROOT`; the path must already exist and be absolute. Optional profile labels are `ARBOR_PROJECT_PROFILE_REF`, `ARBOR_PROJECT_PROFILE_VERSION`, and `ARBOR_PROJECT_PROFILE_NAME`. For example:

```powershell
$env:ARBOR_PROJECT_ROOT = 'C:\Users\Example User\Arbor Work'
pnpm start
```

In the app, open the project switcher and choose **新建项目**. Choose an available project resource and submit the name; a configured host directory is available as a resource profile. To begin work, open the Project's root Workspace and create or assign Work through the available controls. Human approvals are handled in the Project's **待处理** queue at `/p/{projectId}/queue`; open the exact item and approve or reject it there. A Workspace **收件箱** is not the approval queue. A successful Provider verification is not itself human acceptance of the Work.

The current local sandbox binds approved paths/mounts and projects a restricted environment into subprocesses. It is not OS-level process isolation: the current process runs with the user's operating-system permissions. Native OS Sandbox support is accepted in governance but has not been implemented.

## Verification and evidence limits

```powershell
pnpm check
pnpm test:functional
```

`pnpm check` runs lint, TypeScript checks, architecture tests, core tests, and Web package checks. `pnpm test:functional` builds the production daemon and Web client and exercises isolated public-process and browser/restart journeys. They describe the checked source and tested journeys; neither certifies arbitrary user Work, every provider/model combination, or native OS isolation. Review the actual Work and its verification evidence before accepting it.
