# Arbor Linux 首发交付合同

本文定义 Arbor 首发应当对普通 Linux 用户提供的行为。它不把开发者运行源码的命令伪装成正式安装方式。

## 首发产品

Arbor 是本机单用户 coding agent，首发平台为 Linux。普通用户应能：

1. 下载安装包或运行官方安装命令；
2. 启动 Arbor，浏览器打开本地工作台；
3. 在首次启动配置一个真实模型并完成连通性检查；
4. 选择已有项目目录或创建新项目目录；
5. 让 Agent 读取、修改和验证文件，执行构建和测试；
6. 在权限、审批、停止、Provider 中断和进程重启后继续工作；
7. 升级 Arbor 后保留项目、历史、验证记录和附件。

当前仓库还没有满足上述合同的正式发行物，因此不能把当前源码树称为已发布版本。

## 发行物和安装

发布物至少需要提供：

- Linux x64 和 arm64 的可运行发行物；
- 不要求用户预先安装 Node.js 或 pnpm 的启动方式；
- 首次启动自动创建用户数据目录、SQLite 数据库、Blob 存储和配置入口；
- `arbor status`、`arbor stop`、重启和诊断命令；
- 版本、commit SHA、平台和 artifact SHA-256 的发布清单。

普通用户不应通过 `ARBOR_DB`、`ARBOR_PROJECT_ROOT`、`ARBOR_CONFIG` 或内部端口参数完成正常安装。

## 真实 Provider

未配置真实 Provider 时，界面只提供配置和诊断，不允许开始真实对话、Work 或工具执行。fake Provider 只留给自动化测试和开发夹具。

首发支持矩阵应包含常见服务：OpenAI、Anthropic、Google Gemini、DeepSeek、Qwen、OpenRouter 和通用 OpenAI-compatible 接口。发布清单必须列出每个实际通过资格的 Provider/模型组合；“协议兼容”本身不能当作已支持证明。

## 用户数据、Blob 和数据库升级

schema 57 是当前 SQLite 内部格式版本。用户不需要理解或手工操作 schema。

正式用户数据目录必须统一保存：

- SQLite 数据库；
- 对话、验证、附件和 Artifact 等持久 Blob；
- 项目目录登记；
- 备份和升级报告。

持久 Blob 不得使用 `/tmp`。数据库和 Blob 必须一起备份、恢复、迁移和卸载。

第一个公开版本建立升级起点。升级安装前自动备份；公开版本之后的旧数据库自动迁移到当前 schema；迁移失败时保留原数据库并显示恢复入口。未公开的开发 schema 不属于普通用户兼容范围。

## Linux coding agent 能力

生产组合必须启用经过资格验证的 Linux 文件和进程执行边界，覆盖：

- 项目目录内文件读取、创建、修改和删除；
- shell、构建、测试和编译器调用；
- 网络、环境变量、资源限制和子进程树；
- 停止、超时、进程崩溃和重启接管；
- 权限、审批、审计和 fail-closed。

没有通过资格的运行组合必须拒绝执行，不能回退到测试用 TrustedLocal，也不能用 fake 结果冒充真实完成。

合格 Linux 隔离环境安装并通过精确资格检查后，Project/Workspace 初始化自动建立当前
Workspace 边界内的 `WorkspaceWrite × Enabled` 基础能力；普通 Work 和重启不重复要求
用户授权。环境未安装、资格失效或边界/撤权不再有效时，必须在可执行 Work 之前显示
安装/修复或阻断状态。该默认能力不包含 FullAccess、TrustedLocal、跨 Workspace 访问
或敏感外部副作用审批。

## 发布验收

同一个候选 Git commit 必须完成：

```bash
pnpm check
pnpm test:functional
```

并在干净 Linux 环境完成安装、首次配置、真实模型任务、文件修改、进程执行、构建/测试、Verification、Acceptance、重启恢复、数据库升级和备份恢复。每份证据必须记录候选 commit SHA、Provider/模型、平台、是否重试和最终结果。
