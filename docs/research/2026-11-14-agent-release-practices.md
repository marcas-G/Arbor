# Agent 产品发布方式调研

更新日期：2026-11-14

本文记录对 OpenCode 公开仓库和发布页的核对结果，用于 Arbor 的产品化发布设计。它不修改 `docs/design/**` 的冻结语义。

## OpenCode 的可核对做法

OpenCode 的公开 README 提供 Linux 安装脚本、npm 包管理器、Homebrew、Arch/AUR、mise 和 Nix 等安装入口；Linux 还提供 x64、arm64、musl 和 baseline 变体的预编译包。安装脚本检测操作系统和 CPU，下载对应版本的包，安装到用户目录并配置 PATH。普通用户不需要先进入源码目录，也不需要手工设置数据库环境变量。

OpenCode 的 CLI 把数据库放在用户数据目录，并按发布渠道区分数据库文件名。项目、会话、消息、凭据和大对象由运行时统一管理。会话附件不把完整数据直接塞进每条消息，而是以内容哈希引用数据库中的 Blob；读取时再恢复附件，Blob 丢失时显示明确的不可用占位内容。

OpenCode 的 Provider 体系由 Provider、凭据、模型目录和模型解析器共同组成。模型解析会检查 Provider 包、凭据、模型能力和变量；配置缺失或模型不支持时返回配置错误，而不是把测试替身当成真实模型。配置层支持全局、项目和环境来源，并保留凭据的独立管理。

OpenCode 的发布版本使用 Git tag，例如 `v1.19.5`；tag 指向完整 Git commit。GitHub Release 同时发布按平台区分的二进制文件，并为下载资产提供 SHA-256 digest。这里有两个不同用途：commit SHA 证明源码版本，artifact SHA-256 校验下载文件没有损坏或被替换。

## 对 Arbor 的落地结论

1. Arbor 首发应提供 Linux 用户可直接使用的安装物。用户只需要安装命令或下载包，不需要手工组合 `ARBOR_DB`、`ARBOR_PROJECT_ROOT`、`ARBOR_CONFIG` 和端口参数。
2. Arbor 是 Linux 本机单用户 coding agent。单用户描述的是部署和权限边界，不是功能范围；文件读写、进程执行、构建、测试、验证、停止和恢复都属于产品能力。
3. 没有真实 Provider 配置时，产品应停在配置引导/诊断界面，不能进入 fake 对话或 fake Work。fake adapter 只保留给自动化测试和开发夹具。
4. SQLite、Blob、项目目录登记和安装状态需要有清晰的用户数据目录布局，并纳入备份、升级、恢复和卸载说明。临时文件可以放在临时目录，但持久 Blob 不能放在 `/tmp`。
5. 数据库 schema 是用户数据格式的内部版本。Arbor 公开首发后，升级程序必须能够把受支持旧版本安全升级到当前版本，并在升级前自动备份、失败时保留恢复路径。内部开发数据库不需要被承诺为公开兼容版本。
6. 每个 Arbor 发布物由版本号、Git tag、完整 commit SHA、构建平台和 artifact SHA-256 组成。生成和填写这些值由发布流程自动完成，不需要用户参与决策。

## 参考

- OpenCode README（安装与平台包）：<https://github.com/anomalyco/opencode/blob/dev/README.md>
- OpenCode installer：<https://github.com/anomalyco/opencode/blob/dev/install>
- OpenCode session Blob 实现：<https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/blob.ts>
- OpenCode database path：<https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/database-path.ts>
- OpenCode provider/model resolution：<https://github.com/anomalyco/opencode/tree/dev/packages/core/src>
- OpenCode release `v1.19.5`：<https://github.com/anomalyco/opencode/releases/tag/v1.19.5>
