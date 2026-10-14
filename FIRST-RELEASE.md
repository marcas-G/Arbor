# Arbor 本机交付与数据库操作

本文说明当前源码树的本机运行、Provider 配置，以及旧数据库升级的安全操作。每次准备交付时，在最终源代码目录记录实际提交，不要在文档中沿用可能过期的候选提交号：

```powershell
git rev-parse HEAD
```

运行环境为 Windows、Node.js 24.21.0、pnpm 12.4.2。首次安装并启动：

```powershell
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` 会构建工作区和 Web 客户端，并以前台方式启动本机 daemon。浏览器打开 `http://127.0.0.1:8787`。按 `Ctrl+C` 停止，重新执行 `pnpm start` 重启。可用 `ARBOR_HTTP_PORT` 更改端口，`ARBOR_DB` 指定 SQLite 文件。PowerShell 路径包含空格时使用单引号，例如：

```powershell
$env:ARBOR_DB = 'C:\Users\Example User\Arbor Data\arbor.db'
pnpm start
```

## Schema 42 与旧库升级

当前运行时目标为 schema 42。普通启动不会替旧数据库执行 P39，也不会完成到 42 的完整升级；schema 39 是受控维护迁移。较旧数据库可能先应用其余兼容迁移，再因缺少 schema 39 而失败。遇到失败应停止启动尝试，改用离线升级器处理停机副本。

升级只能针对停止服务后的本机数据库进行。先正常停止 Arbor，并确认没有其他进程使用源库。整个复制和续跑期间源库必须停机、只读且保持不变。升级器会拒绝与应用数据库及相关文件冲突的路径；仍须由操作员确保目标、P39 报告库和 manifest 都是独立的新路径。严禁把在线数据库交给升级器，也不要把目标路径指向源库。

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

升级器在成功返回前会验证 P39 report 的结构与证据、manifest 链和摘要，并确认只读重开的目标确为 schema 42。命令报错或拒绝时，不要切换数据库；保留源库和诊断文件以便检查。成功后保留原库作为回滚点，再显式切换并启动：

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
pnpm start
```

也可把密钥存入仅当前用户可读的私有 key file，并在配置中使用 `{ "kind": "file", "ref": "C:\\Users\\Example User\\.config\\arbor\\provider.key" }`。不要把真实 key 写入仓库、命令参数、shell 历史或日志。`ARBOR_CONFIG` 可指定配置文件；默认查找 `.\arbor.config.json`，然后 `$HOME\.config\arbor\arbor.config.json`。配置文件密钥应通过 env 或 file SecretRef 提供，不使用 inline secret。

## 项目资源与人工审批

创建需要文件访问的 Project 前，先配置一个现存、绝对路径的目录：

```powershell
$env:ARBOR_PROJECT_ROOT = 'C:\Users\Example User\Arbor Work'
pnpm start
```

可选的项目资源 profile 字段为 `ARBOR_PROJECT_PROFILE_REF`、`ARBOR_PROJECT_PROFILE_VERSION`、`ARBOR_PROJECT_PROFILE_NAME`。daemon 启动时读取该目录；在界面项目切换器中选择“新建项目”，选择可用资源并提交名称。进入项目根 Workspace 后创建或分配 Work。需要人工授权的具体动作会出现在 Queue/Inbox；打开并核对目标动作后批准或拒绝。Work 的 Provider 验证结果与人对最终结果的验收是两个步骤。

当前 local sandbox 仅将已批准的路径作为 mounts/boundaries 提供，并向子进程投影允许的环境变量；这不是 OS 级隔离，进程仍具有运行用户的操作系统权限。Native OS Sandbox 已有接受的治理设计，尚待实现；不要将本地 mount 边界描述成 OS 沙箱。

## 检查与证据范围

```powershell
pnpm check
pnpm test:functional
```

`pnpm check` 覆盖 lint、类型、架构、核心与 Web 检查。`pnpm test:functional` 构建生产 daemon/Web 客户端，在隔离数据库和受控 Provider 边界上运行公共流程与浏览器/重启旅程。两项结果只证明对应源码版本和实际覆盖的旅程；它们不证明全部 S1–S4 已交付，不替代对具体 Work 的验收，也不构成 Native OS Sandbox 的实现或资格证据。
