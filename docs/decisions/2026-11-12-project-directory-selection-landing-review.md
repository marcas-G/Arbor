# 项目目录选择：落地一致性复核

日期：2026-11-12（Asia/Shanghai）  
源码：`e7065a7c` 加当前工作树；没有创建提交。  
复核方式：实施 Agent 的落地后自检，不冒充独立 Agent 审查。

## 接受依据与固定记录

用户先要求自由选择路径创建项目、借鉴 OpenCode 及展示已有项目操作，
随后明确要求“继续接入”。接受的产品范围记录在
`2026-11-11-project-directory-selection.md`。以下是落地时的文件
SHA-256，用于重现本次记录；不声称用户逐字确认过哈希或每个内部实现细节。

| 文件 | SHA-256 |
| --- | --- |
| `docs/decisions/2026-11-11-project-directory-selection.md` | `aeff4390b3228ad5df0e1681f235016b5505451180a91f8974d1705afbd46bf7` |
| `docs/design/01-scenarios.md` | `a728f222093ca1af6416445dc85e60030e7447b0fe182d95a8ccd752d7043081` |
| `docs/design/02-system-design.md` | `8b78b7a77d8160c71e8a70aacf2c3de527aa1f8ae76ca9eaf173608608d1d7fe` |
| `docs/design/03-detailed-implementation-design.md` | `fbc20a919cb778056db75f1686fe0545d971de43c8d30d5758061f9ff9a8508c` |
| `docs/design/implementation/P1/01-command-contracts.md` | `7b3fad3829c39689532291bf96372cda6ad9513723edd7d533bd475356a764d7` |
| `docs/design/implementation/P1/02-port-contracts.md` | `a0be0fe79039a489cdd8208ee8bdd8509740a66dc0b7ef29154962a3a860be67` |
| `docs/design/implementation/P12/10-transport-shells.md` | `9186da7eae50358ff41137f2697120295168979cef68df631f82c1ba1853c174` |

这些完整文件还包含本工作树此前的设计对齐修改；哈希标识落地后的文件
内容，不代表本次目录接入修改了它们的所有内容。冻结版本号不变，
新增内容以日期增补及 DID §4.1D 标明覆盖范围，AGENTS 已说明此关系。

## 所有者与实现核对

| 接受行为 | 所有者 | 当前实现 |
| --- | --- | --- |
| 选择服务端目录、保留已有文件、新建最后一级目录 | Scenarios 日期增补 | `ProjectFolderPicker`、host `browse` / `prepare` |
| 已有项目显示目录与操作，重复目录打开原项目 | Scenarios、System Design 增补 | `/projects` 的持久边界路径、共享项目列表、准入返回已有 Project |
| host 准入不是模型工具或权限授予 | System Design 增补 | 仅本机人类身份使用目录 API；原资源边界和审批仍约束后续动作 |
| 文件系统检查在 Application 写事务之外 | DID §4.1D、P1 Ports | host 先持久登记；CreateProject 通过内存 Port 解析引用 |
| 不改 CreateProject 封闭载荷与历史回执 | DID §4.1D、P1 Commands | 仍只发送 Profile 引用/版本；receipt-first 在 Gateway 中保留 |
| 并发创建不能重复绑定新登记的目录 | DID §4.1D、P1 Commands/Ports | `isDirectoryLinked` 在创建事务内读取持久根边界；顺序重复及回执重放有真实 SQLite 回归 |
| 已确认目录在重启后可用 | DID §4.1D、P12 transport | 私有逐目录登记、完整同步后原子发布、启动加载相同路径 |
| 旧预设列表兼容且不泄露路径 | P12 transport | `/project-resources` 仍无路径；新能力标记与专用目录接口独立 |

## 验证证据与范围

证据目录：`.test-results/project-directory-research-20261111/`。

- `folder-all-ui.log`：真实 daemon 与 Chromium 的目录相关三条旅程全部通过，
  零重试；覆盖动态目录、文件证据/独立验证、新建第二目录、重复打开、
  重启保留、旧预设验收和原始路径/伪造引用拒绝。Provider 是隔离脚本替身。
- `directory-live-browser.json`：同一构建已在本机 18787 服务生效，
  路径输入/浏览、已有项目管理与继续对话可用，页面无运行时错误。
  未提交创建/修改命令，原 Project 与 schema 55 保留；旧 ConversationOnly
  如实显示未绑定文件夹。`directory-live-home.png` 保存页面截图。
- `final-check.log`：Biome、根 TypeScript 和架构 197 项通过；完整检查在
  核心测试第 7/48 批主动中止，前面批次已通过。该运行不是完整通过记录，
  不作为发布资格。本次改用受影响后端及完整 Web 回归完成接入验证。
- `final-directory-core.log`、`final-profile-catalog.log`：目录持久化、
  创建事务重复保护/历史回执和旧预设接口定向共 22 项通过。
- `final-web.log`：完整 Web 36 个文件 / 289 项通过，含路径复制/搜索、
  准备期间关闭、失败重试同一命令及已有项目操作；Web typecheck 通过。

未重跑完整 `pnpm test:functional`、干净 checkout 或真实 Provider 全旅程。
本次没有数据库迁移，没有修改用户真实 Provider 配置或启用进程执行。

## 保留的边界

1. 目录是服务机器的路径；仅验收本机 Linux 单用户，不声明浏览器文件上传、
   多租户可见性或新的 Windows 文件系统资格。
2. 动态登记加入当前 host；其他已经运行的 daemon 不保证同步获得新引用。
3. 准入使用 realpath 并保留旧规范路径，已测试符号链接别名重新指向时不
   改写旧引用；不扩大为任意后续文件系统替换的完整检测保证。
4. 提交前创建的空文件夹不会自动删除；旧 Project 不自动更换目录，
   ConversationOnly 不自动绑定当前默认路径。
5. 列表展示持久路径，不逐条探测实时可访问性；资源激活失败仍使用既有
   Attention，不伪造项目回滚或成功激活。
6. 事务内重复检查已有回归，未额外声明跨 daemon 并发登记/创建竞争矩阵已通过。

复核结论：本次新增的用户流程、所有者增补与实现相互对应；不能用本次
接入完成替代整个产品的发布资格或扩大原有安全支持范围。
