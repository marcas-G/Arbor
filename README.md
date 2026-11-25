# Arbor

Arbor 是开源的 Linux 本机单用户 coding agent。它在用户选择的项目目录中使用真实模型完成文件读取和修改、命令执行、构建、测试、验证、审批、停止和恢复。

Arbor 不是只支持对话的应用。对话是进入工作台的入口，真实 Provider、文件边界和进程执行是完成工程任务的必要条件。

## 当前发布状态

当前仓库仍是源码开发形态，尚未提供普通用户可直接下载的正式 Linux 发行物。发布前必须完成：

- Linux x64/arm64 可安装发行物和无需手工环境变量的启动器；
- 首次启动的真实 Provider 配置和连通性诊断；
- Linux 文件/进程执行的发布资格；
- SQLite、Blob、项目目录和备份的统一用户数据目录；
- 从第一个公开版本开始的数据库升级和失败恢复；
- 同一发布源码基线上的完整功能、浏览器、恢复和真实模型验收。

当前源码验证和未完成项见：

- [项目意图](docs/PROJECT_INTENT.md)
- [当前状态](docs/CURRENT_STATE.md)
- [发布收敛进度与实际安装证据](docs/RELEASE_PROGRESS.md)
- [架构](docs/ARCHITECTURE.md)
- [已知问题](docs/KNOWN_PROBLEMS.md)
- [待确认问题](docs/OPEN_QUESTIONS.md)
- [Agent 产品发布方式调研](docs/research/2026-11-14-agent-release-practices.md)

## 从源码运行（开发者）

本地 Linux 预览包自带 Node 和 Web，解压后运行 `bin/arbor`。全新安装会先自动
检查并安装隔离执行环境（约 3 分钟），通过后初始化数据库并打开浏览器配置真实
模型；无需设置环境变量。检查失败会保留诊断并停止本次安装，不会退回无隔离执行。
当前预览包还没有正式发布资格；已有配置和数据库不自动切换执行模式或升级。

Linux 开发环境需要 Node.js 24.21.0 和 pnpm 12.4.2：

```bash
pnpm install --frozen-lockfile
pnpm build
```

源码启动入口：

```bash
node scripts/start-user.mjs open
```

`ARBOR_DB`、`ARBOR_CONFIG`、`ARBOR_PROJECT_ROOT` 和端口参数是测试、高级部署或兼容预设入口，不是普通用户的安装步骤。开发启动时，用户可以在 Web 界面选择项目目录。

## 真实模型配置

普通产品运行必须配置真实 Provider。没有 Provider、凭据无效或模型能力未通过检查时，Arbor 应停在配置/诊断界面，不进入 fake 对话或 fake Work。

首发 Provider 资格范围将覆盖常见真实服务，包括 OpenAI、Anthropic、Google Gemini、DeepSeek、Qwen、OpenRouter，以及通用 OpenAI-compatible 接口。每个公开支持的 Provider/模型组合都必须完成工具调用、结构化输出、流式响应、错误处理和恢复验证。

`adapters/provider-fake` 仅用于测试和开发夹具，不是产品 fallback。

## 项目和工作

启动后，在 Web 界面：

1. 首次使用时配置真实模型，连接检查成功后自动进入工作台；
2. 选择已有项目目录，或在已有父目录下创建项目目录；
3. 从目标创建或分配 Work；
4. 按权限和审批执行文件、命令、构建和测试；
5. 查看独立 Verification，完成人工或 Parent Acceptance；
6. 在重启、Provider 中断或动作失败后按 Attention 提示恢复。

Linux 隔离环境通过精确资格检查后，Project/Workspace 初始化会自动建立当前
Workspace 边界内的 `WorkspaceWrite × Enabled` 基础执行能力；普通 Work 和重启
不要求用户重复授权。该能力不包含 FullAccess、TrustedLocal、跨 Workspace 访问
或敏感外部副作用审批。环境未安装或资格失效时，界面先显示安装/修复状态，不能
退回宿主命令或 fake 执行。

## 数据和升级

schema 57 是 SQLite 的内部格式版本，用户不需要手工设置。正式安装器应自动创建用户数据目录并管理 SQLite、Blob、项目目录登记和备份。

Linux 预览已提供 `arbor backup --to <新目录>`、`arbor verify-backup --from <备份目录>`
和 `arbor restore --from <备份目录> --data-dir <新目录>`；备份前需停止 Arbor。
它们同时保存数据库、内容文件和项目目录登记。项目源码、模型密钥和独立沙箱授权文件
需单独保存。操作和限制见 [备份与恢复](docs/BACKUP_RESTORE.md)。

第一个公开版本建立升级起点。公开版本之后的旧数据库必须先备份，再自动升级；失败时保留原库和恢复入口。内部开发数据库不属于普通用户兼容承诺。

## 发布身份

每个发布物由以下信息唯一标识：

- 版本号和 Git tag；
- 生成该发布物的完整 Git commit SHA；
- 对应平台发行文件的 SHA-256 checksum。

Git commit SHA 用于确认源码版本，artifact SHA-256 用于确认下载文件完整性；这些值由发布流程自动生成，用户不需要选择。

## 验证

```bash
pnpm check
pnpm test:functional
```

这些命令只证明执行时记录的源码基线和覆盖范围。发布资格还需要 clean Linux 安装、真实 Provider、文件修改、进程执行、构建、测试、独立验证、重启恢复、升级和备份恢复证据。

## 许可证

Arbor 采用 [MIT 许可证](LICENSE)。发行物附带项目许可证；捆绑的 Node 和第三方依赖保留各自的许可证。
