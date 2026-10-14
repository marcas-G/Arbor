# Arbor 本机交付与数据库操作

本文说明当前源码树的本机运行、Provider 配置，以及旧数据库升级的安全操作。每次准备交付时，在最终源代码目录记录实际提交，不要在文档中沿用可能过期的候选提交号：

```powershell
git rev-parse HEAD
```

运行环境为 Windows、Node.js 24.21.0、pnpm 12.4.2。首次安装并构建：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

首次启动前，先离线创建 schema 42 数据库，再将 `ARBOR_DB` 指向它并启动 Arbor。已有数据库则按下文 `copy` 操作完成后指向升级副本：

先创建或选择本机父目录。父目录必须已存在，并通过 P39 的本地卷、owner 和 ACL 保护校验。创建目录本身不保证能通过这些校验：

```powershell
New-Item -ItemType Directory -Force -Path 'C:\Arbor Data'
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode fresh `
  --database 'C:\Arbor Data\arbor-v42.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-manifest.jsonl'
$env:ARBOR_DB = 'C:\Arbor Data\arbor-v42.db'
pnpm start
```

daemon 只接受已是 schema 42 的数据库；启动不执行迁移或升级。`pnpm start` 构建 Web 客户端，并以前台方式启动本机 daemon。浏览器打开 `http://127.0.0.1:8787`。按 `Ctrl+C` 停止，重新执行 `pnpm start` 重启。可用 `ARBOR_HTTP_PORT` 更改端口，`ARBOR_DB` 指定 SQLite 文件。PowerShell 路径包含空格时使用单引号。

```powershell
$env:ARBOR_DB = 'C:\Users\Example User\Arbor Data\arbor.db'
pnpm start
```

## Schema 42 与旧库升级

当前启动 gate 精确要求 `PRAGMA user_version = 42`。普通启动不应用迁移。未达到 schema 42 的数据库必须先通过离线 `schema:upgrade` 完成升级，不要直接启动。

升级只能针对停止服务后的本机数据库进行。先正常停止 Arbor，并确认没有其他进程使用源库。先创建或选择目标、P39 报告库和 manifest 所在的本机父目录；它必须已存在且通过 P39 本地卷、owner 和 ACL 保护校验。`New-Item -ItemType Directory -Force` 可创建目录，但不保证目录符合这些保护条件。`copy` 仅支持 schema 36、37、38 的源库。整个复制和续跑期间源库必须停机、只读且保持不变。对于新的 `fresh` 或 `copy` 作业，目标、P39 报告库和 manifest 必须各自是独立的新路径；`resume-copy` 必须复用中断作业原有的源、目标、报告和 manifest 路径。严禁把在线数据库交给升级器，也不要把目标路径指向源库。

先构建升级器：

```powershell
pnpm build
```

新建空数据库时使用 `fresh`：

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode fresh `
  --database 'C:\Arbor Data\arbor-v42.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-manifest.jsonl'
```

升级现有库时使用 `copy`。源库保留为原样回滚点，目标是单独的副本：

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode copy `
  --source-database 'C:\Arbor Data\arbor-slice.db' `
  --database 'C:\Arbor Data\arbor-v42-copy.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-copy-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-copy-manifest.jsonl'
```

若中断，使用 `resume-copy` 并提供完全相同的源库、目标库、报告库和 manifest 路径；源库仍须停机且未改变：

```powershell
node '.\apps\single-workspace\dist\schema-upgrade.js' --mode resume-copy `
  --source-database 'C:\Arbor Data\arbor-slice.db' `
  --database 'C:\Arbor Data\arbor-v42-copy.db' `
  --p39-report-db 'C:\Arbor Data\arbor-v42-copy-p39-report.db' `
  --copy-manifest 'C:\Arbor Data\arbor-v42-copy-manifest.jsonl'
```

升级器在成功返回前会验证 P39 report 的结构与证据、manifest 链和摘要，并确认只读重开的目标确为 schema 42。manifest 含本机路径元数据，只在运行升级的本机留存；分享前先脱敏。命令报错或拒绝时，不要切换数据库；保留源库和诊断文件以便检查。成功后保留原库作为回滚点，再显式切换并启动：

```powershell
$env:ARBOR_DB = 'C:\Arbor Data\arbor-v42-copy.db'
pnpm start
```

回滚时先停止 daemon，再把 `ARBOR_DB` 指回原库并重新启动。不要覆盖或删除原库。不要把新副本用于生产，除非升级器完整成功。

## Provider 密钥与兼容端点

默认 Provider 是本地 deterministic fake。配置真实模型时，将 `apps/single-workspace/arbor.config.example.json` 复制为未跟踪的 `arbor.config.json`。配置字段是 `provider.deploymentId`、`modelRef`、`endpoint`、`wireModelName`、`secret` 和可选的 `executionPolicyOverrides` / `extraHeaders`。示例指向 DeepSeek OpenAI-compatible endpoint；其他兼容服务需填入其 endpoint 与 wire model name。

示例使用环境变量 SecretRef。当前 PowerShell 会话中以隐藏输入设置密钥后启动：

```powershell
$env:ARBOR_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Provider API key' -AsSecureString)).Password
$env:ARBOR_CONFIG = (Resolve-Path '.\arbor.config.json').Path
pnpm start
```

也可把密钥存入仅当前用户可读的私有 key file，并在配置中使用 `{ "kind": "file", "ref": "C:\\Users\\Example User\\.config\\arbor\\provider.key" }`。不要把真实 key 写入仓库、命令参数、shell 历史或日志。Windows 上显式设置 `$env:ARBOR_CONFIG` 指向私有配置文件，或将未跟踪的 `arbor.config.json` 放在仓库根目录；不要依赖 `$HOME` 回退。配置文件密钥应通过 env 或 file SecretRef 提供，不使用 inline secret。

## 项目资源与人工审批

创建需要文件访问的 Project 前，先配置一个现存、绝对路径的目录：

```powershell
$env:ARBOR_PROJECT_ROOT = 'C:\Users\Example User\Arbor Work'
pnpm start
```

可选的项目资源 profile 字段为 `ARBOR_PROJECT_PROFILE_REF`、`ARBOR_PROJECT_PROFILE_VERSION`、`ARBOR_PROJECT_PROFILE_NAME`。daemon 启动时读取该目录；在界面项目切换器中选择“新建项目”，选择可用资源并提交名称。进入项目根 Workspace 后创建或分配 Work。人工审批入口是项目级“待处理”队列 `/p/{projectId}/queue`；打开具体事项并核对后批准或拒绝。Workspace 的“收件箱”不承载审批。Work 的 Provider 验证结果与人对最终结果的验收是两个步骤。

当前 local sandbox 仅将已批准的路径作为 mounts/boundaries 提供，并向子进程投影允许的环境变量；这不是 OS 级隔离，进程仍具有运行用户的操作系统权限。Native OS Sandbox 尚未实现；不要将本地 mount 边界描述成 OS 沙箱。

## 检查与证据范围

```powershell
pnpm check
pnpm test:functional
```

`pnpm check` 覆盖 lint、类型、架构、核心与 Web 检查。`pnpm test:functional` 构建生产 daemon/Web 客户端，在隔离数据库和受控 Provider 边界上运行公共流程与浏览器/重启旅程。两项结果只证明对应源码版本和实际覆盖的旅程；它们不证明全部 S1–S4 已交付，不替代对具体 Work 的验收，也不构成 Native OS Sandbox 的实现或资格证据。
