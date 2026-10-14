# Arbor

Arbor is a local, single-user work system organized around Projects and long-lived Workspaces. The daemon serves the Web app at `http://127.0.0.1:8787` by default.

## Install, start, stop, restart

Use Node.js 24.21.0 and pnpm 12.4.2:

```powershell
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the TypeScript workspaces and Web client, then runs the daemon in the foreground. Press `Ctrl+C` to stop it; run `pnpm start` again to restart. Set `ARBOR_HTTP_PORT` before starting to select another port. The default database is `.\arbor-slice.db`; set `ARBOR_DB` to choose another path. Keep the daemon stopped while copying or upgrading its database.

PowerShell accepts quoted paths with spaces. For example:

```powershell
$env:ARBOR_DB = 'C:\Users\Example User\Arbor Data\arbor.db'
$env:ARBOR_HTTP_PORT = '8788'
pnpm start
```

## Database schema 42

The current runtime uses schema version 42. Ordinary startup applies its current migration sequence, but it does not run the privileged P39 migration or complete an upgrade from an older database. An older database can fail at the P39 prerequisite after earlier compatible migrations have run; stop there and use the offline `schema:upgrade` operator on a stopped, disposable copy.

The examples below assume the repository root is the current directory. They use separate target, P39 report, and copy-manifest paths. Choose new, unused paths for each attempt; keep the source daemon stopped and the source database unchanged through completion, including any `resume-copy` invocation. Never point the operator at a live database or use the upgraded copy until the command reports success. The command validates the report and manifest chain as part of its operation. Keep the original database as the rollback point; on success, explicitly point `ARBOR_DB` at the upgraded copy before restarting Arbor.

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

Config lookup order is `ARBOR_CONFIG`, `.\arbor.config.json`, then `$HOME\.config\arbor\arbor.config.json`. Legacy `ARBOR_MODEL_*` environment configuration is also supported; the standard config file is the preferred source.

## Projects, files, and approvals

Before creating a Project that needs files, expose a host directory using `ARBOR_PROJECT_ROOT`; the path must already exist and be absolute. Optional profile labels are `ARBOR_PROJECT_PROFILE_REF`, `ARBOR_PROJECT_PROFILE_VERSION`, and `ARBOR_PROJECT_PROFILE_NAME`. For example:

```powershell
$env:ARBOR_PROJECT_ROOT = 'C:\Users\Example User\Arbor Work'
pnpm start
```

In the app, open the project switcher and choose **新建项目**. Choose an available project resource and submit the name; a configured host directory is available as a resource profile. To begin work, open the Project's root Workspace and create or assign Work through the available controls. Actions requiring human approval appear in the Queue/Inbox; inspect the specific action and approve or reject it there. A successful Provider verification is not itself human acceptance of the Work.

The current local sandbox binds approved paths/mounts and projects a restricted environment into subprocesses. It is not OS-level process isolation: the current process runs with the user's operating-system permissions. Native OS Sandbox support is accepted in governance but has not been implemented.

## Verification and evidence limits

```powershell
pnpm check
pnpm test:functional
```

`pnpm check` runs lint, TypeScript checks, architecture tests, core tests, and Web package checks. `pnpm test:functional` builds the production daemon and Web client and exercises isolated public-process and browser/restart journeys. They describe the checked source and tested journeys; neither certifies arbitrary user Work, every provider/model combination, or native OS isolation. Review the actual Work and its verification evidence before accepting it.
