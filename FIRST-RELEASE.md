# Arbor 首版本机运行说明

这是一版可在本机实际打开和操作的 Arbor 交付，基于源代码提交 `b2a81660a954fa161c7698a5cdab63c81b047eb4`。它提供单机 Web 界面、生产 daemon、真实 Provider 配置引用和独立数据目录。它是首个可用里程碑，不代表 Arbor 的完整目标或全部 S1–S4 场景已经交付。

## 启动

运行环境：Windows、Node.js 24.21.0、pnpm 12.4.2。首次运行先在此目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @arbor/web build
```

启动时必须显式指向本机私有 Provider 配置文件。配置中的密钥留在该文件或其 SecretRef 对应位置，不要复制进本仓库或交付包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-release.ps1 -ProviderConfig 'C:\Arbor\arbor.config.json'
```

启动脚本会确认 Provider 配置有 deployment、model、endpoint 和密钥引用，启动后等待本地服务就绪。浏览器访问 `http://127.0.0.1:8787`。若端口已占用，脚本会停止并保留现有进程；可改用 `-Port 8788`。

停止：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-release.ps1
```

停止脚本会核对 PID 属于此 release daemon 后才发出停止信号。日志位于 `%APPDATA%\ArborFirstRelease\logs`。

## 本机文件位置

- SQLite 数据库：`%APPDATA%\ArborFirstRelease\data\arbor-slice.db`
- 首版授信的项目文件根目录：`%APPDATA%\ArborFirstRelease\workspace`
- daemon PID 和日志：`%APPDATA%\ArborFirstRelease\daemon.pid` 与 `logs`
- Provider 配置：由 `-ProviderConfig` 指定；不会随源码或构建产物复制

首启会在上述目录建立一套新的数据库和空项目文件目录。它不导入或打开 `C:\Arbor` 中的既有数据库、源代码树、用户文件或未提交改动。给 Arbor 的文件访问范围限于首版 workspace 目录。

## 当前范围与限制

- 当前运行方式是单机、单用户、仅监听本机回环地址；不要将服务端口转发或暴露到局域网。
- 模型请求会使用指定的真实 Provider，可能产生 Provider 费用；此交付未以 mock/fake Provider 冒充真实模型。
- 首版覆盖可运行的生产 daemon 与 Web 界面，但不宣称完整支持 S1–S4，也不宣称 AH39–AH42 资格已通过。
- F21、F23 以及 AH7、AH10、AH14 等记录中的待闭合项仍未由此交付消除；P39–P42 未并入此首版。
- 对重要工作仍应由人查看结果和验证证据。源码基线此前的门禁结果不能替代你对实际工作结果的验收。

## 源码与依赖

- 源码基线：`b2a81660a954fa161c7698a5cdab63c81b047eb4`
- 依赖：仓库锁定的 pnpm workspace 依赖，通过 `pnpm install --frozen-lockfile` 安装
- 构建：`pnpm build` 和 `pnpm --filter @arbor/web build`
- 不包含 Provider 密钥、真实用户文件、旧数据库或 P39–P42 实验代码
