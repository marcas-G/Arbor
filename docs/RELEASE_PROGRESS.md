# Linux 交付目标与实际进度

## 2026-11-20 设计口径更新

负责人已接受 Workspace 初始化默认执行能力：Linux 隔离环境完成精确资格检查后，
新 Project/Workspace 自动建立当前边界内的 `WorkspaceWrite × Enabled` 基础能力；
普通 Work 和 daemon 重启不重复申请，不创建第二个人类身份，也不扩大到 FullAccess、
TrustedLocal 或跨 Workspace 资源。合格 Linux 发行物的进程模式目标默认是
`NativeOsSupportedOnly`；未安装或未通过资格检查时仍必须显示安装/修复状态并
fail-closed，当前 Disabled 只表示这一安全不可用状态、显式停用或回滚。

这是已接受的设计，不是发布完成声明。初始化建账、撤权/用户恢复、Child 边界、
阻塞 Work 的同一 Work 重试，以及同一干净发行物的真实文件/命令/构建/测试/网络/
验证/验收旅程仍未全部通过。提案和决定见
`docs/proposals/2026-11-20-workspace-default-execution-capability.md` 与
`docs/decisions/2026-11-20-workspace-default-execution-capability.md`。

## 2026-11-16 当前工作树增量

晚间最新行为：普通新安装包 `c283c8709076` 已用真实模型和浏览器完成工作区授权、
初始失败测试、实际修复、构建成功、测试成功及公网 HTTPS。后续独立验证器的
命令沙箱绑定缺失，使其停在无结论状态；尚未人工验收。验证器停止记录导致页面
503 的实现缺陷已在新包 `0eb639331a31` 和原验收数据上公开复验修复；旧版验证
等待阻塞新 Work 修订的缺陷已修复；第三个包 `06193bb2acc3` 的公开浏览器
Steer 已恢复新修订执行，停在新的精确命令审批，尚未继续批准。
这是一条已实际执行命令、尚未走完验证/验收的旅程，不是完整发布资格。
负责人已接受独立验证使用隔离临时副本；固定条款已落地到 DID 1.67/P8/P4/P12。
输入副本捕获/清理组件 9 项通过，与恢复修复合批 45 项通过，typecheck 通过。
原项目不可写、当前授权上限、精确执行策略、资格、停止恢复及真实命令接线仍待完成，
不能将文件复制组件当作独立验证交付。精确命令审批的内容全部脱敏问题新增为 KP-018。
最新完整 check 曾在核心 15/51 批因 P14 过时 allowlist 失败；修后定向通过，
未完成全量复跑，也未运行最新完整 release 功能套件。
后续已补独立验证的可信环境准备和源输入重验：canonical 身份/修订、完整权限链、
资源与主机来源前后复查，以及 Scope/失败/停止清理。合批 31 项、typecheck、lint
通过；尚未注册到普通 daemon，也未接通专用持久策略、挂载资格与 P4 命令。
详细包身份、失败、源码检查和实际状态见
`docs/verification/2026-11-16-installed-workspace-command.md`。以下为此前检查点。

最新生产接入：runtime schema57、离线升级/摘要/manifest/维护终态、持久工作区
授权/撤销、自动执行策略绑定及普通浏览器入口已接入。普通人类提交与关闭重开、
撤销/恢复、内部 Parent 分配和公开 codec 合批 63/63 通过；Web 40 文件/298 项及
构建通过；升级/生产启动/Binder 合批 52 通过、6 既有跳过。扩大检查曾发现历史
schema 断言未同步，正在集中复验；不能宣称最新完整门禁通过。

文件工具与环境授权的统一撤权、模型实际 Parent 分配、同一新安装包真实模型
shell/构建/测试和双工作区隔离仍待验收，发布目标继续进行。详细当前证据见
`docs/verification/2026-11-16-workspace-production-integration.md`。
下面记录此前检查点，不覆盖本节最新状态。

本轮修复了两个会破坏“同一发行物真实验收”或 V2 sandbox 恢复的实现缺口：

- 发行物 build identity 从仅检查 `dist` 扩展为覆盖实际启动器、用户运行时脚本、
  内置 Node、部署依赖、应用 source/relay、迁移材料和符号链接目标本身。移动包到
  含空格/中文的目录后身份保持；修改启动器、Native adapter 或 relay 后，启动器拒绝
  启动且不创建数据库。证据：
  `.test-results/portable-runtime-identity-20261116/result.json`，发行物身份回归 6/6。
- SQLite sandbox decision store、transport receipt projection、Attention provider-
  unavailable projection 和 command-result codec 现在共用严格 V1/V2 解码；V2 Linux
  network policy 能读取和恢复，V1 receipt 不接受 V2 结果。相关定向验证 25/25，
  根 typecheck 和 build 通过。

这两项不等于 Native Supported tuple 或完整 coding agent 发布资格。Workspace-scoped
sandbox authority 仍是 P0 实现阻断：项目负责人已确定权限和授权按 Workspace、
ResourceBoundary、Execution 及既有 Parent/Direct-Child 治理关系计算；旧 Native
OS 特殊授权要求两个不同的 HumanPrincipal，隐藏身份绕过已撤回；当前替代路径已
接入生产，旧记录兼容与完整产品验收分别记录，后者仍未完成。

2026-11-16 授权生命周期增量：用户已接受长期工作区授权和已有权限内的明确
Parent→Child 分配。持久 `fs:write` / `shell:exec` 授权已通过当前外部命令装配保存、
重开、回执重放和撤销；UI 默认“持续有效，直到撤销”。Native 策略授权及 Child
分配的完整实现仍是 P0 后续工作，尚未完成普通安装包真实命令验收。

更新：2026-11-16。目标进行中，尚未发布，尚未完成完整 coding agent 验收。

2026-11-16 数据版本增量：当前源码已推进至 schema 56；修复版本摘要和维护终态
遗漏后，新建、复制升级、只读复核及并发续跑集中验证通过，操作器与兼容边界
21 项通过、6 项既有跳过。历史迁移受影响文件复验 8/8 通过。尚未生成并验收新
版本安装包；原包的文件任务和环境首装结果仍只属于原包。详见
`docs/verification/2026-11-16-schema56-compatibility.md`。

2026-11-16 安装流程增量：新增安装包内真实检查与首装入口，覆盖 22 项隔离、
联网、资源及停止控制；前一包 22/22 后因验收 XDG 目录选在 tmpfs 而拒绝安装。
已提前检查持久目录并加入安装锁恢复；最新 ext4 首装以 exit 0 完成，22/22
通过且包内 doctor 确认 Linux 环境可用，重复安装保持材料不变。详见
`docs/verification/2026-11-16-linux-environment-install.md`。完整产品验收仍开放。

2026-11-16 此前增量：安装包的实际执行文件校验已接入生产，probe 与执行固定到
同一路径；过滤规则内嵌，V2 relay 使用固定安装文件。安装包内 C 编译、npm 安装
及代码断言、HTTPS 和隔离负向检查已有局部证据；GitHub CONNECT 仍失败，当时尚无
普通安装的 Supported 材料；上述后续首装现已有独立结果。doctor 已改为和 admission 共用完整检查。完整功能
批次最终失败（268 通过、1 失败、1 跳过，浏览器未运行），接管场景的 fixture
写锁和过时断言经核对后修正，定向 1/1 通过。不能继承为全量通过。详细记录见
`docs/verification/2026-11-16-installed-linux-artifacts.md`。

验收标准是普通用户从安装开始，配置真实模型、选择真实项目，完成文件修改、真实命令/构建/测试、纠错/停止/恢复、独立验证与验收。脚本模型、测试专用进程能力和内部数据库操作不能替代这些用户流程。

负责人已明确：命令必须严格隔离并联网，不能采用无隔离本机命令，也不能以
断网模式交付。模型接口连接成功不能替代命令环境联网成功。决策记录见
`docs/decisions/2026-11-14-strict-isolation-with-network.md`。

2026-11-15 优先级澄清：隔离首先防止工作区互相任意访问和执行串扰，安全可务实
收敛。首发应证明两个工作区可同时联网开发、文件/服务/停止互不误伤；不以最高
强度网络审查替代这一目标。新方向尚未落地为生产可用能力，见
`docs/decisions/2026-11-15-workspace-isolation-priority.md`。

2026-11-15 当前工作树回归：`pnpm check` 完整通过，包含 lint 1499 文件、架构
198/198、核心 493 文件（保留 1 个既有 expected-fail）、Web 39 文件/294 项、
根/Web typecheck、production build 和启动器检查。该门禁不包含完整
`pnpm test:functional`、package/clean-checkout 或真实 Provider 发布资格。

## 已推进的实际行为

| 行为 | 当前结果 | 证据及边界 |
| --- | --- | --- |
| 数据内容跨重启保留 | 手动联合备份/恢复局部验收通过 | 默认 `<database>.blobs`；已补安装包内 backup/verify-backup/restore，真实模型对话和目录登记经新目录恢复、重启后公开读取一致；实际内容字节另有 SQLite 集成验证。自动备份、完整历史搬迁和已删除内容恢复仍未完成 |
| 防止其他网页借本机身份操作 | 已修复 | HTTP/WS 先核对 Host/Origin；真实 Chromium 本机 WS 成功、另一来源 WS 被拒绝。没有宣称它证明了进程执行隔离 |
| 用户打开的是本次构建 | 已补核验 | 源码与构建指纹、`/runtime` 实例/数据库识别；源码或产物变化触发重建，失效 PID 不可停止其他进程 |
| 不安装 Node/pnpm 也能启动预览包 | 本机 Linux x64 通过 | 自带 Node、production 依赖和 Web；解压到中文/空格路径，用 `PATH=/usr/bin:/bin` 启动，实际进程可执行文件位于包内；全新 schema 55 初始化、浏览器页面、停止和重启通过。不是干净 VM/多发行版/arm64 资格 |
| 未配置模型时不能开始任务 | 已实现并验证拒绝 | 独立安装预览中显示模型配置页，提交 `/commands` 返回 503；HTTP/WS 回归验证没有业务分发。新增 host 写路径已获确认并落地，保留精确架构限制 |
| 浏览器配置真实模型并自动重新加载 | 外部真实模型局部验收通过 | 独立 Linux x64 安装包用外部 `gpt-6.1-sol` 完成浏览器配置、自动重载、真实助手回复及重启历史读取。密钥不进入配置 JSON；文件权限 0600。证据 `.test-results/real-install-fixed-20261114/result.json`；包含命令的完整编程任务仍未通过 |
| Linux shell、构建、测试 | 环境首装通过；完整用户任务未完成 | Native POSIX 已实现 systemd+bwrap 执行候选；后续精确绑定、正式 shell 名称与输出溢出清理修复后，本机定向矩阵为 27/27，通过项目写入、主机目录/环境/网络隔离、输出上限和 supervisor 超时分类。后续安装包已完成 22/22 首装并生成一个精确 Supported tuple，doctor 确认环境可用；schema 对齐、普通配置/授权接入及真实模型命令任务仍待完成 |
| 文件型 coding 旅程和升级 | 文件型 coding 旅程已在最终字体包通过；升级未完成 | 同一 source-free 包已完成真实模型、真实项目、文件读写阻断/授权、纠错、独立验证、人工验收和重启保留；shell、构建、测试及升级仍未完成，详见 `docs/verification/2026-11-15-final-package-coding-journey.md` |

## 2026-11-15 手动联合备份与恢复增量

已增加 Linux 安装包内的 backup / verify-backup / restore，复用 SQLite 官方备份
API、现有跨进程维护锁及租约重整函数。独立只读审查指出的“校验和交付摘要被误认作
内容引用”已修复；最终集成 8/8、根 lint/typecheck、启动器检查通过。

新的 source-free 预览包以包内 Node 运行，全新初始化、真实项目目录与公开命令、
外部真实模型回复、运行中拒绝备份、停服备份校验、新目录恢复和普通重启均通过。
恢复后的公开对话条目和目录选择一致。该真实模型场景没有产生 Blob，实际内容字节
另有 SQLite 集成验证；首次配置请求的 TransportFailed 失败记录保留，未称零重试成功。

操作范围见 `docs/BACKUP_RESTORE.md`，精确包身份、证据及限制见
`docs/verification/2026-11-15-user-data-backup.md`。源码/Git/worktree、模型凭据和外置
沙箱授权/审计需单独保存；自动备份、完整历史搬迁、用户内容修复及整体验收仍未闭合。
网络设计待接受、production 联网命令未接通和完整编程任务阻断均保持原状态。

## 2026-11-15 安装包中文字体增量

独立浏览器截图发现缺少中文字库的 Linux 环境把产品文字显示成方框。根因是新加入
的字体 CSS 位于 `/fonts/`，而静态服务只把 `/assets/` 当作文件资源，实际返回了
SPA 的 `index.html`。已复用现有静态资源解析器，加入 `/fonts/` 的安全文件服务和
不可变缓存；路径穿越测试仍保留。Web 构建、39 个文件 / 294 项测试及字体静态资源
定向测试通过。

重新打包后的 source-free Linux x64 预览包：
`/home/lgao/.local/share/Arbor/release-preview-builds/final-font-20261115/arbor-0.0.0-preview-e16c418d47f7-7166d262-linux-x64.tar.gz`，SHA-256
`4aef65ab8ff7a9de13a7c5390928675f43620e020e6ca00e75fbecaae36d2a30`，buildId
`sha256:e16c418d47f7824468fff1a4d901e58fa77e9138967d07ac875ecdfb517dafde`。
包内浏览器确认字体 CSS 返回真实 CSS、Noto Sans SC 已加载、页面中文字正常显示，
无 page error。字体文件及 OFL-1.1 来源清单位于 `apps/web/public/fonts/noto-sans-sc/`。
这解决安装可读性缺陷，但不改变命令执行、联网命令和完整编程任务的发布状态。

## 2026-11-15 最终包真实文件编程旅程

已使用上面同一个字体修复后的 source-free Linux x64 包，重新完成真实模型浏览器旅程：
首次配置并自动重载、选择真实项目、读取和修改文件、无权限时阻断且不重复写入、
重启保留阻断、用户授予限时文件权限、提交补充指导、只追加一次、独立验证、人工
验收，以及完成后再次重启读取结果。该旅程无 page error，证据为
`.test-results/real-final-font-coding-20261115/result.json`。

这把“最终发行物中的文件型 coding agent 能否真实工作”从旧包证据推进到当前包；
命令执行、构建、测试、正式联网命令、并行 Workspace 和升级仍保持未完成状态。

## 2026-11-15 权限拒绝阻断提示复验

BaseLoop asset 已从 v2 更新为 v3，明确要求可由用户处理的权限/资源/终端能力拒绝
进入 `wait(disposition: Blocked)`，不能普通 Yield 或重复尝试。第一次复验因测试场景
同时产生“标记无换行”的初始标准与“标记加换行”的后续指导而未通过；统一输入后，
同一新预览包的真实文件型 coding 旅程已完整通过，包括独立验证、人工验收和完成后
重启读取。该结果仍不包含 shell、构建、测试、正式联网命令、并行 Workspace 和升级。
证据见 `docs/verification/2026-11-15-blocked-prompt-recovery.md`。

## 独立安装发现并修正的缺陷

1. 首个预览包缺 `effect`：源码运行依赖根开发依赖，独立包在初始化前报 `ERR_MODULE_NOT_FOUND`。已为实际导入它的 25 个运行模块补显式依赖并更新 lockfile。
2. 第二个预览包缺迁移 pin 审计输入：初始化在 schema 38 后查找源码工作树中的四份文件，独立目录报 ENOENT。打包器现在包含四份精确审计源文件，保留原 pin 校验，不要求用户拥有完整仓库。
3. 修正后的新预览包在新的隔离数据目录成功初始化、启动、显示配置页和重启。先前失败的数据目录保留作诊断，未删除或升级用户数据库。

打包器：`scripts/build-linux-preview.mjs`。本地预览不上传、不生成正式 tag，不冒充 release candidate。负责人已选择 MIT，仓库及新打包器已补项目许可证；旧包保留原身份不覆盖。

## 首次对话预览身份

- 源码 HEAD：`e7065a7cb06938a045a00d449b5b345f52cff8eb` 加当前工作树修改；不是干净提交资格。
- 已完成外部真实模型局部验收的 buildId：`sha256:3ce57848cef802ccab2168ce3f8c15a5ebc9bd7d635ebeb120dce29b4c17a31f`。
- 该本地文件：`/home/lgao/.local/share/Arbor/release-preview-builds/real-provider-fix-20261114/arbor-0.0.0-preview-3ce57848cef8-3579c175-linux-x64.tar.gz`。
- 该文件 SHA-256：`f05550393d80d891f3a9b6b86055ac7256b0b1dc62a434dd5aa24d56251c0ee6`。
- 该包之后源码已补阻塞正式装配、工具身份和工作详情入口；后续包需单独验收，不能继承前包结论。
- `preview-manifest.json` 明确标记 `releaseQualified: false`。内部运行摘要、源码提交和下载文件摘要含义不同，均不替代行为验收。

## 2026-11-14 验证检查点

- 根 lint、根 TypeScript、Web TypeScript、启动器 4 项通过。
- 受影响后端 10 文件 / 51 项通过；完整 Web 38 文件 / 292 项通过。
- 当前架构门禁：38 个文件、198/198 通过。首次配置固定方案已获确认并落地，提案/决策记录为 `docs/decisions/2026-11-14-first-run-model-setup.md`，方案 SHA-256 为 `a4ce27ecdeadcb040a1f98052b7af87f9ac2b323f66c2b9254757f7eb18f0dbf`。
- 当前 smoke 发布套件通过：5 个文件、48/48；覆盖 S1–S4 公共流程、纠错、恢复/拒绝、输入校验和 production daemon handshake。完整 `pnpm test:functional` 本轮在 AH19 长恢复矩阵中途停止，不能当作完整 release 通过。
- Native POSIX 本机定向矩阵通过 27/27（含真实 systemd+bwrap 用例）；包含项目写入、主机目录/环境/网络隔离、输出限制和 systemd supervisor 超时分类。该证据仍不足以生成 production Supported tuple。
- 原始本机证据：`.test-results/release-foundations-20261114/`，包括 `browser-boundary.json`、`installed-preview.json`、页面截图和 `provider-connectivity.json`。早期浏览器依赖缺失的启动失败，后以已有本地库路径解决；没有把失败重跑写成零重试成功。
- 此检查点尚未完成完整核心、完整 release 功能套件、所有崩溃边界或干净 Linux VM；后续核心完整运行见下方 2026-11-15 增量，不能把定向验证扩大成完整发布结论。


## 本轮文件任务闭环

独立安装包 `arbor-0.0.0-preview-5211ac38ba34-3579c175-linux-x64.tar.gz`，
SHA-256 `aa77ce6ca2904bb286917709f594ee346e05eaf8cd04aec80a0b8715bfb8727b`，
通过外部真实 `gpt-6.1-sol` 的浏览器旅程：首次配置 → 选目录 → 读文件 → 写入拒绝 →
可见阻塞 → 重启 → 当前分工限时文件授权 → 新指导 → 实际追加且仅一次 → 独立验证通过 →
人工验收 → 完成工作 → 重启后文件及验收仍在。没有使用脚本 Provider 或内部命令代替操作。
证据：`.test-results/real-permission-resume-fixed-20261114/result.json`；详细分段结果与失败记录见
`docs/verification/2026-11-14-linux-install-real-model.md`。此包后续只有许可证和发行说明变化；
不把旧包的身份或局部验收继承为新包的完整发布资格。

当前含 MIT 的预览包为
`arbor-0.0.0-preview-42c53f7f94d6-7166d262-linux-x64.tar.gz`，
SHA-256 `be9ee5cc9a37cf609e218b77e783d8e4a3e8fd85ec588442ec13f0d9e0b99cad`。
项目许可证与仓库一致，Node 许可证保留；对比的 992 个代码、Web 资源及 Node
可执行文件与上述真实模型文件验收包一致。它仍不是正式发布，见
`docs/decisions/2026-11-14-mit-license.md`。

## 接下来

下一步先完成 Linux 沙箱内开发工具的受控联网，再完成完整资格矩阵、受信
production 装配和普通安装包中的命令执行；随后用同一安装包走包含命令的完整
编程任务，再完成公开发布、升级和备份产品化。MIT、首次配置和严格隔离联网均已
确定；不再让负责人选择内部执行模式名。

## 网络基础实现与累计回归

新增内部 HTTPS 地址过滤、下载编排及 RFC7050 正向答案解析，三文件 102/102
通过；有界下载、取消、超时、混合 DNS、重定向及地址变化均有针对性用例。
编排使用注入传输，真实 socket 实现尚未通过沙箱资格；还没有子进程网络通道，
不能称 npm/git/curl 已可联网。模块位于应用 transport，未削弱架构边界。

本轮分段完成既有 484 个核心文件回归：完整检查的前 380 文件，续跑的前 90
文件，以及修复旧 SSE 假 reader 后最后 14 文件均通过；新增网络文件另验。
SSE conformance 44 项、最后 14 文件 145 项通过；Web 39 文件 / 294 项通过。
根 TypeScript、架构 38 文件 / 198 项通过。此前依赖清单断言及 SSE 测试夹具
失败保留在日志，不能称为一次干净的 `pnpm check` exit 0，也没有获得本轮
完整 `pnpm test:functional` 或真实联网命令验收。

后续实验通道进一步验证了真实 curl + TLS + 专用 Unix socket + bwrap 独立
网络空间；上游和 discovery 仍是 T2 夹具，不能冒充真实网络开发任务。增加
正向 RFC7050 当前网络查询；本机 ENODATA 仍拒绝自动生成 NoDns64 证明。
四文件 119/119、根 TypeScript、架构 198 项通过。初次架构复验发现证书
代码新增直接进程启动；已改为显式可信签发依赖，测试夹具提供真实 OpenSSL
签发，production 尚未装配。未修改架构门禁或资格判定。

负责人最新指示是先梳理网络使用需求。已形成 `docs/NETWORK_REQUIREMENTS.md`，
把模型调用、依赖、仓库、项目内部测试、预览、主机/内网、代理、发布和安装更新
分开讨论。固定治理补充仍待确认；没有据此修改冻结设计或开放生产命令。

## 2026-11-15 文件工具与核心回归增量

本轮新增 `write@1`、`glob@1`、`grep@1` 的真实 Tool Runtime 集成核对，并修复
当前 schema 55 下非幂等写入恢复路径直接写旧 settlement ledger、缺少 P40
observation evidence 的问题。恢复现在复用既有 evidence ledger，已获准但未完成的
写入进入 `OutcomeUnknown`，不会再次执行或覆盖用户后续修改。集成测试使用真实
SQLite、ownership admission、挂载目录、recovery binding 和 evidence 服务；6/6
通过。验证细节见 `docs/verification/2026-11-15-filesystem-runtime.md`。

定向文件工具、tool-runtime、工具目录和 P4 harness 合计通过；完整架构 38 文件
198/198、Web 39 文件 294/294、根 typecheck/lint 通过。核心 492 文件分 50 批
继续回归，50/50 批完成；其中一个历史测试保留 1 个 expected-fail 标记，未被
改写为成功。此前 `pnpm check` 在第 35 批发现旧依赖断言、在第 40 批发现旧工具
清单断言，均已修正并在后续批次通过；因此本记录不把首次中断的 `pnpm check`
说成一次零失败完整运行。

本轮仍未完成普通生产路径的联网命令、npm/git/curl、受控预览、Native Supported
tuple、真实模型完整 coding 任务或正式发行资格。文件工具的部分 ownership
准入已补上精确目标路径检查，但仍未在安装包和真实模型完整 coding 任务中验收。

## 2026-11-15 标准代理与真实联网命令增量

已按负责人“优先使用成熟组件”的要求，将新通道改为标准 HTTP CONNECT、Node
HTTP/TLS/stream 与 `@peculiar/x509`/WebCrypto，移除自定义握手、手写 HTTP 解析和
transport 直接调用 OpenSSL。辅助程序归 transport，仅在沙箱内转发字节。

真实 systemd+bwrap 候选完成 curl 公网请求、Git v2 查询（含 POST）、npm 安装依赖、
运行使用该依赖的项目测试，同时直连公网 IP 被拒绝。网络核心五文件 151/151、功能
两文件 14/14、根/test TypeScript、架构 198 项及修正后的 manifest 检查通过；初次库
载入、模块边界和 inventory 失败均保留说明。

这使用显式 T2 capability/discovery，而非普通用户装配。factory 已登记，但普通
production Supported gate 仍为 false。真实负 discovery、完整重定向/网络合同、
Provider 运行中的公共 StopExecution 取消链路已补齐并通过挂起 HTTP 请求验证；Native
副作用停止/恢复、跨命令服务、并行工作区及普通安装包仍未资格，不能关闭发布阻断。
最新证据和限制见 `docs/verification/2026-11-15-standard-network-proxy.md`；前文
“没有子进程网络通道/尚无公网依赖试验”仅代表此前检查点，已由此增量更新。

## 2026-11-15 停止与网络超时增量

真实反例发现 Native fiber 中断返回后后台子进程仍写文件，已按既有进程树停止合同
修复。现在中断等待精确 systemd unit 和 broker 清理，返回时 cgroup 已空；两个
不同目录的隔离调用中停止 A 不影响 B。公共 StopExecution 到挂起 Provider 的取消
链路已由真实 daemon、SQLite 和公开命令定向通过；这不代表 Native 副作用停止恢复
或两个正式 Workspace 的完整验收。

公网回归曾两次出现 Git 请求失败，保留错误及 Node ETIMEDOUT 诊断；新增 TCP/TLS
握手期限与可读 504，并验证持续流转和上游错误。修复后公网 curl/Git POST/npm/项目
测试再次通过，不将这说成首次零失败或证明所有网络波动已解决。Native 36/36、
streaming 11/11、公网候选 5/5、根 TypeScript、架构 198 项、lint 通过。production
资格与完整安装包目标仍未完成。详情见 `docs/verification/2026-11-15-native-cancellation.md`。

## 2026-11-15 补充指导与重复提交修复

文件运行链路的越界写入断言对齐后，一次完整 `pnpm check` exit 0：核心 492 文件的
50 批完成，架构 198、Web 294 及构建/类型/启动器检查通过。之后完整功能批次在
长会话场景失败，追查发现真实使用缺陷：任务等待人工输入后，补充指导已经提交，
Agent 却没有继续；独立 F07 同样复现。

现复用既有 HumanIntervention 和 Inbox 消费状态修复：补充指导恢复目标任务，
同一命令重复提交不会误唤醒后续等待，重启后重试仍保持原回执且不多调用模型。
受影响核心 5 文件/22 项、公开指导/关键纠错/停止 3 项、最终指导重启重试与原失败
长会话场景 2 项、根 TypeScript、架构 198 和修改文件 lint 均通过。最终长会话复测
只选择原失败项，其他 43 项为显式过滤，不是完整矩阵。

完整检查通过时尚未包含这次唤醒修复；最终源码没有完整 release 通过结论。普通
安装包的隔离联网命令、并行正式工作区、完整 coding 任务和发布资格仍未完成。
复现、失败与验证边界见 `docs/verification/2026-11-15-human-steer-wake.md`。

## 2026-11-15 普通命令装配阻碍与固定设计包

本机已有 bubblewrap 0.12.0 和正常运行的 systemd 用户服务，但直接调用普通
production probe 仍为 Experimental；真实 `ipv4only.arpa` AAAA 为 ENODATA，当前
production discovery 返回 null，不能通过现有 broker 的严格要求。因此不能靠
打开 Supported 布尔值打通联网命令。

已准备按工作区隔离优先、标准代理及端到端 TLS 收敛的固定设计包，并明确 IPv4
出站及 CONNECT 域名授权的范围。13 份 owner 补丁在副本应用、摘要和版本检查通过；
该准备检查点当时未修改冻结设计。后续当前设计文件已包含 V2 supplement，但
配套 proposal manifest 仍为 PREPARED_NOT_ACCEPTED；接受及 landing 审计需要核对，
不能把这段旧准备状态作为当前设计文件未变的事实。命令仍未正式启用，普通服务
复用/预览及全量安装验收没有因此关闭。材料见 `docs/proposals/2026-11-15-linux-workspace-network-v2.md`，
实际结果见 `docs/verification/2026-11-15-linux-production-network-gap.md`。

## 2026-11-16 工作区授权、Parent 分配与安装包复验

持久工作区授权已接入 schema57、生产 Gateway、内部自动策略绑定和浏览器。
Parent 模型分配动作已接通；SQLite 集成证明人工撤权阻断新的 Parent 分配，旧
回执重放不恢复权限，只有用户显式恢复才可再次分配。相关五文件 48 项通过、
2 项 Windows 跳过；Binder 真实编号生成器及策略存储两文件 19 项通过。

真实新安装包验收发现并修复 Linux V2 bundle 误判、daemon 失败隐藏、P4 之前
提前返回等待造成重复动作，以及内部绑定命令编号不合法。最新包正在重新验收；
此前包虽完成首次模型配置及浏览器授权，随后服务退出，没有通过命令、构建或
测试。根类型检查通过，但最新源码没有完整 check/release 通过结论。详细证据、
包摘要及验收边界见 `docs/verification/2026-11-16-installed-workspace-command.md`。
