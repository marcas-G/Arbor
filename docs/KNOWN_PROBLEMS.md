# 已知问题

更新日期：2026-11-25
范围：只记录当前仍成立、能由源码或现有门禁复现的问题。历史上已经修复的问题保留在 `planning/results/**`，不在此重复列为当前缺陷。

当前发布口径已明确：Arbor 是 Linux 本机单用户 coding agent，必须可安装、必须使用真实 Provider，文件和进程能力属于首发范围。fake Provider、ConversationOnly 和未资格化环境中的 Disabled 只能作为测试、显式停用或安全失败状态，不能作为合格 Linux 首发的普通产品行为。2026-11-20 的设计决定要求：资格通过后，Workspace 初始化自动建立当前边界内的 `WorkspaceWrite × Enabled` 基础能力；源码初始化链路已落地，但安装资格、真实命令旅程和发布资格仍未完成。

## KP-000：当前没有普通用户可安装的 Linux 发行物

**问题编号**
KP-000

**现象**
根 npm 包仍标记 `private: true`、版本 `0.0.0`；这不是仓库可见性声明。`npm pack` 会打包大量源码、测试和内部材料，不包含可独立运行的发布 `dist`；`pnpm test:package` 的 clean-checkout 安装还依赖本机离线缓存。目前已有供本地审阅的 Linux x64 预览包，独立初始化/启动/重启通过；外部真实模型配置和对话已通过；真实文件任务已完成拒绝/授权/恢复/独立验证/验收和重启；命令执行、构建、测试、升级和正式发布渠道仍未完成。预览包不能当作正式交付。

**复现步骤**

1. 查看 `package.json` 的 `private`、`version` 和 `bin` 字段。
2. 执行 `npm pack --dry-run`，检查内容包含源码和测试且没有完整发行物。
3. 在无完整 pnpm 离线 store 的 clean checkout 执行 `pnpm test:package`。

**影响范围**
所有首次安装用户、发行渠道、升级、卸载和问题复现。

**可能原因**
正式发布渠道和完整安装资格尚未完成；许可证已由负责人确认为 MIT 并落入仓库与新打包器。当前启动器与本机预览包已管理默认用户数据目录，无需手工设置内部环境变量；源码开发入口仍需构建环境。

**涉及文件**

- `package.json`
- `scripts/start-user.mjs`
- `scripts/start-release.ps1`
- `scripts/testing/`
- `README.md`
- `FIRST-RELEASE.md`

**优先级**
P0 — 发布阻断。

**建议修复方式**
提供 Linux x64 和 arm64 的可运行发行物及安装脚本；发布物自带运行时和 Web 资源，首次启动自动创建用户数据目录、数据库和配置入口，不要求用户手工设置 Arbor 的内部环境变量。发布流程同时生成版本、Git commit 和 artifact checksum 清单。

**验证方式**
在干净 Linux x64/arm64 环境从下载地址安装，启动 Web 界面，配置真实 Provider，创建项目并完成一次真实模型任务；重启和升级后数据库、Blob、项目目录和历史仍可读。

HTTP/WS 来源检查缺口（KP-010）已修复：当前代码在业务路由和 upgrade 前核对 Host/Origin，拒绝非 loopback Host、错误端口、跨站及 opaque Origin，保留无 Origin 的原生客户端。真实 Chromium 本机/另一来源 WS 检查通过，见 `docs/RELEASE_PROGRESS.md`；这不是 Linux 进程执行已交付的证据。

## KP-011：已补手动联合备份，完整历史迁移和缺失内容恢复仍未交付

**问题编号**
KP-011

**现象**
新写入使用数据库旁的持久 Blob 目录；Linux 已增加数据库/内容文件/目录登记的手动联合备份、校验和新目录恢复入口。仍缺自动备份、设置页入口、完整历史搬迁和缺失内容的用户恢复界面。尚未被读取的历史内容可能仍只在旧临时目录，已被清理的旧内容无法恢复；备份遇到实际内容引用缺失会失败。符号环境快照只保留和报告标记，不声称恢复其内容。

**复现步骤**

1. 写入一个需要 Blob 的模型/验证/Artifact 记录。
2. 检查 `<database>.blobs` 中的内容。
3. 对仍只存在旧临时目录的历史内容，清理其文件后运行联合备份。
4. 观察备份拒绝完成，或重新打开原记录时内容不可用；当前没有面向用户的内容修复入口。

**影响范围**
历史对话、验证证据、Artifact、恢复、备份和升级。

**可能原因**
持久存储和手动联合备份已补齐一部分；引用枚举覆盖当前已识别的内容生产路径，但源端已删除的字节无法重建，历史搬迁和用户恢复界面仍未完成。

**涉及文件**

- `adapters/blob-local/src/index.ts`
- `packages/ports/src/**blob**`
- `apps/single-workspace/src/composition.ts`
- `scripts/start-user.mjs`
- `apps/single-workspace/src/user-data-backup.ts`
- `apps/single-workspace/src/user-data-restore-guard.ts`
- `docs/BACKUP_RESTORE.md`

**优先级**
P0 — 在公开保存用户历史前必须关闭。

**建议修复方式**
保留手动联合备份、按引用复制旧内容、实例隔离和原子写入；继续补历史搬迁、用户缺失内容恢复入口、备份计划及升级/卸载的数据协同。独立安装验证和准确限制见 `docs/verification/2026-11-15-user-data-backup.md`。

**验证方式**
写入真实 Blob 后执行完整数据目录备份、删除原目录、恢复到新目录并重启；历史、验证和 Artifact 字节内容与引用保持一致，单独删除 Blob 时系统可诊断且不伪造成功。

项目目录选择问题已于 2026-11-12 修复并通过浏览器旅程，从当前问题清单移除；原限制、接受的改造方案和验证范围见 `docs/research/2026-11-11-project-directory-selection.md`、`docs/decisions/2026-11-11-project-directory-selection.md` 和 `docs/USER_JOURNEY_ACCEPTANCE.md`。

## KP-001：当前整合头缺少同基线发布级功能复验

**问题编号**
KP-001

**现象**
当前 `e7065a7c` 整合了发布候选之后的治理、功能、schema 55 和 Web 变更。本轮已经有完整 `pnpm check` 通过记录，但没有当前整合头的完整 `pnpm test:functional`、clean-checkout 和真实 Provider S1–S4 资格记录。

2026-11-15 一轮完整 `pnpm check` 在人工指导唤醒修复前通过；随后完整功能批次
在 AH19 长流程失败，并由 F07 独立复现“补充指导已保存但任务不继续”。修复还发现并
处理了重复 SteerWork 回执会唤醒后续新等待的问题。最终源码仅有受影响范围的定向
验证，不能继承修复前完整检查为同基线资格。完整功能失败报告为
`.test-results/2026-11-14T21-07-27-364Z-553645/`，详细复现和修复边界见
`docs/verification/2026-11-15-human-steer-wake.md`。

2026-11-16 后续完整功能批次最终失败：268 passed、1 failed、1 skipped，浏览器
未运行，报告为 `.test-results/2026-11-15T22-08-38-493Z-1139599/`。接管 fixture
写锁和前 P40 的过时断言已核对修正，定向 1/1 通过；这不替代整合源码完整发布
资格。同期执行组件和安装包已变化，不能把长批次当作最终包同基线验证。详见
`docs/verification/2026-11-16-installed-linux-artifacts.md`。

**复现步骤**

1. 在当前工作树执行 `git rev-parse HEAD`。
2. 检查 `planning/results/S1-S4-current-candidate-pause-checkpoint-20261026.result.md`，其资格 SHA 是较早候选。
3. 当前工作树的 `pnpm check` 已通过（核心 493 文件、架构 198/198、Web 294 项），
   但它不包含完整功能/Playwright/package/clean-checkout/真实 Provider 发布组。
4. 当前头需要另行执行 `pnpm test:functional`、package/clean-checkout 和明确的真实 Provider gate。

**影响范围**
发布声明、崩溃恢复、浏览器旅程、当前 schema 55 夹具和真实 Provider 行为。

**可能原因**
后续分支合并和 schema 变更发生在最后一次正式发布候选资格之后。

**涉及文件**

- `package.json`
- `scripts/testing/run-suite.mjs`
- `vitest.functional.config.ts`
- `planning/results/S1-S4-current-candidate-pause-checkpoint-20261026.result.md`

**优先级**
P0 — 发布前阻断。

**建议修复方式**
冻结一个当前候选 SHA，从干净 checkout 运行 `pnpm check`、`pnpm test:functional`、`pnpm test:package` 和约定的真实 Provider 旅程；结果必须记录执行文件、继承文件、重试、平台、Provider 和最终 exit code。

**验证方式**
同一候选生成 exit 0 的完整结果 manifest，且 `completeCoverage=true`；真实 Provider 证据引用同一个可执行源码基线。

## KP-002：保留用户数据库升级不受支持

**问题编号**
KP-002

**现象**
当前源码 Runtime 只接受 schema 57。离线 `copy` / `resume-copy` 已接入 schema 36–38 和 44–57 的独立副本，本轮资格仍在验证；当前发布文档明确禁止把它当作保留用户数据库的升级支持。

**复现步骤**

1. 将 `ARBOR_DB` 指向 schema 57 以外的数据库并启动当前源码 daemon。
2. 启动会拒绝并要求离线升级。
3. 阅读 `README.md` 或 `FIRST-RELEASE.md` 的数据库说明。
4. 可看到离线复制只用于可丢弃资格夹具，不授权用户数据升级。

**影响范围**
已有安装升级、用户数据保留、回滚、发布运维。

**可能原因**
累计迁移、P39 目录/锁/sidecar 证据和真实用户数据恢复矩阵尚未形成发布支持策略。

**涉及文件**

- `apps/single-workspace/src/schema-upgrade.ts`
- `apps/single-workspace/src/schema-upgrade-manifest.ts`
- `adapters/persistence-sqlite/src/migrations.ts`
- `README.md`
- `FIRST-RELEASE.md`

**优先级**
P0 — 公开发行必须能安全升级已安装版本。

**建议修复方式**
首发以第一个公开版本为升级起点：对公开版本之后的旧数据库自动备份并升级，失败保留原库和恢复入口；内部 schema 36–56 夹具继续用于资格验证，但不向用户承诺从未发布的开发数据库升级。升级器、manifest、README、安装器和 clean-checkout 必须使用同一份支持清单。

**验证方式**
在声明支持的每个源版本上完成复制升级、manifest 校验、只读复核、schema 57 启动、关键数据读写、重启和回滚演练；全过程不修改源库。

## KP-003：Linux 隔离环境已可首装，普通完整命令任务尚未交付

**问题编号**
KP-003

**现象**
晚间最新增量：`c283c8709076` 安装包已实际完成主任务修改、构建、测试及公网
HTTPS。完整旅程尚未完成的具体原因是 KP-017 的独立验证命令绑定缺口；双工作区、
完整停止恢复及正式发布资格仍未通过。以下描述保留较早检查点，不再解释为完全
没有普通安装命令成功记录。

Native POSIX adapter 现在已有 systemd 用户单元 + bubblewrap 的真实执行路径：
它会建立私有 namespace、只读系统工具链挂载、项目挂载、超时/输出限制和
进程树停止；本机真实定向矩阵已覆盖项目写入、主机目录/环境/网络隔离、输出上限
和 supervisor 超时分类；后续精确资格绑定、正式 shell 名称及输出溢出进程组清理
修复后为 27/27。修复及反例见 `docs/decisions/2026-11-14-native-posix-execution-review.md`。它仍不会自行生成 Supported 资格，production composition 仍把
`nativeOsSupportedTupleAvailable` 已改为从用户级受信 authority registry 派生；本机默认
用户目录尚未安装材料，因此当前实际模式仍是 `Disabled`。这属于未资格化环境的安全
状态，不是合格 Linux 首发的目标默认；后续独立安装包已取得下述首装
结果；普通完整 shell、构建及测试任务尚未验收。

联网也是该阻断项的一部分。负责人要求严格隔离同时支持网络；当前 Linux
策略计划在未绑定 broker 时拒绝 Restricted/Enabled 为 `NetworkBrokerUnavailable`。
新标准 CONNECT/Unix socket 候选已接入 factory，并在显式测试资格与 discovery 下
通过真实 curl、Git POST、npm 下载安装和项目测试；production Supported gate
仍为 false。尚不能据此声称普通用户的依赖安装已可用，见
`docs/verification/2026-11-15-standard-network-proxy.md`。

2026-11-15 停止增量：已修复 Native fiber 中断返回后后台仍写文件的真实反例；
中断现在等待进程组和 broker，两个不同目录调用中停 A 不影响 B。公共 StopExecution
到挂起 Provider 的取消链路已由真实 daemon、SQLite、公开命令和挂起 HTTP 请求通过；
Native 运行命令的副作用取消/恢复矩阵、跨调用服务和两个正式 Workspace 仍未验收。公网回归
出现过 Git 失败，新增建连期限及可读错误后重跑成功，不能扩大为完整网络可靠性。
Native 36/36、streaming 11/11、公网候选 5/5 及根检查通过，production 资格仍缺失。
详见 `docs/verification/2026-11-15-native-cancellation.md` 和
`docs/verification/2026-11-15-public-stop-cancellation.md`。

2026-11-16 普通路径复核：本机已有 bubblewrap 0.12.0 和运行中的 systemd 用户
服务。实际 production host probe 检测到 namespace/cgroup/seccomp 前置条件，
打开 V2 broker 后仅因缺失资格证据而保持 Experimental；先前不带 runner 的低层
probe 不应作为宿主检测结论。旧 V1 DNS64/Pref64 失败仍是旧通道事实，V2 候选
使用普通 IPv4 CONNECT。当前设计文件已有 V2 supplement，而 proposal manifest
仍为 PREPARED_NOT_ACCEPTED，接受/landing 记录需要审计核验；未凭此启用命令。见
`docs/proposals/2026-11-15-linux-workspace-network-v2.md` 和
`docs/verification/2026-11-15-linux-production-network-gap.md`。

本轮发现并修复候选执行器通过项目挂载中的 pathname Unix socket 连接宿主的
真实反例。命令过滤、只读 proc、嵌套 namespace 限制现已接入；真实 socket 拒绝、
子进程继承、内部 TCP 和 V2 HTTPS 检查通过，但命令自身的 pathname Unix socket
也被限制。尚无正式资格/安装装配。扩展 Git 场景在 Git 阶段以 CONNECT 504 失败；
独立 npm 安装和 C 编译候选已通过；宿主直连 GitHub 超时、现有本地代理请求 TLS
EOF 的原因仍未确定，不能宣布开发联网通过。V2 资格执行器现已额外绑定准确的
profile/网络模式/证据引用和 validated limits；这仍不产生 Supported row。
证据和精确限制见 `docs/verification/2026-11-16-native-command-isolation.md`。

2026-11-16 安装产物校验已接入生产：八个角色读取实际完整文件，固定可执行路径，
过滤规则内嵌执行器，relay 运行安装包中的同一份文件。相关源文件已纳入打包；
doctor 与 admission 共用完整检查。独立资格生成/安装、schema 顺延及普通用户
完整命令任务仍未完成，不能将这次接线称作 Supported 能力已交付。新增包、真实
编译/npm 局部证据和失败边界见
`docs/verification/2026-11-16-installed-linux-artifacts.md`。

2026-11-19 已关闭 provider 升级后的重新资格化死路：安装包新增
`reinstall-environment`，真实 22/22 Linux 隔离检查通过，新 authority
`linux-bwrap-v2-49d25075afe4ba40` 已发布，旧 authority 保留在带时间戳目录。
首次 `install-environment` 仍保持不覆盖已有材料的保护语义。

2026-11-16 首装增量：安装包内 `install-environment` 已在独立 ext4 用户目录
完成真实 22/22 控制和受保护材料安装；同包 doctor exit 0，Linux 环境可用。
内存超限曾导致 swap 增长，现已通过 MemorySwapMax=0 / OOMPolicy=kill 修复并
实测；CPU、停止/超时清理通过，重复安装保留已有材料。独立检查不授予项目
权限或动作审批；实际 schema 顺延、普通启动/配置路径及真实模型命令/双工作区
任务仍未关闭。原始失败和最终包证据见
`docs/verification/2026-11-16-linux-environment-install.md`。

**复现步骤**

1. 使用尚未安装执行环境材料的默认用户目录，在 `arbor.config.json` 设置 `runtime.processExecutionMode` 为 `NativeOsSupportedOnly`。
2. 使用普通 production composition 启动。
3. 发起需要进程执行的动作。
4. 动作在 spawn 前以 unavailable/denied 结果 fail-closed。

**影响范围**
shell、构建、测试、编译器和其他依赖本机进程的 Work。

**可能原因**
Linux 的离线首装现已写入精确 provider/version/capability/OS-build/profile/network 资格，并通过生产探测；尚缺 schema 顺延、普通模式/配置接入、完整开发工具兼容、服务生命周期和真实用户任务。仅修改资格布尔值不能补齐这些缺失能力。

**涉及文件**

- `apps/single-workspace/src/composition.ts`
- `apps/single-workspace/src/provider-config.ts`
- `packages/tool-runtime/src/catalog.ts`
- `packages/tool-runtime/src/runtime.ts`
- `adapters/sandbox-native-posix/**`
- `adapters/sandbox-windows/**`

**优先级**
P0 — Linux coding agent 首发能力。

**建议修复方式**
保留现有离线真实检查、精确资格和受保护材料安装，完成 schema 顺延、普通启动/配置/授权接入及同包真实模型任务。不要扩大当前单个 WorkspaceWrite × Enabled 元组的资格范围；服务复用和预览仍需独立合同与验收。Shell、构建、测试和文件修改不得回退到 TrustedLocal 或 fake 路径。

**验证方式**
production composition 在目标 OS build 上通过完整 T3/发布矩阵；不匹配 tuple 继续 fail-closed，且不能回退到 TrustedLocal。用普通安装包、真实模型和浏览器实际完成联网依赖下载、构建与测试，同时证明主机越界及直连绕过失败；断网正例和网络单元用例均不能替代它。

## KP-004：多主体远程 Project 可见性未实现

**问题编号**
KP-004

**现象**
Command 和普通 view 有可替换 Authenticator，但跨 Project 的 `/projects` 与 `/project-resources` 仍是本机单主体 bootstrap 接口。源码明确要求多主体部署提供后续 visibility resolver。

**复现步骤**

1. 查看 `apps/single-workspace/src/transport/server.ts` 的 local project directory 和 resource profile 路由。
2. 配置非本机/多主体 Authenticator。
3. 这些路由没有完整的按主体 Project 可见性模型可供使用。

**影响范围**
远程访问、多用户、项目列表和主机资源元数据隔离。

**可能原因**
当前产品范围是本机单用户，身份验证扩展点先于多主体可见性模型存在。

**涉及文件**

- `apps/single-workspace/src/transport/auth.ts`
- `apps/single-workspace/src/transport/server.ts`
- `apps/single-workspace/src/composition.ts`

**优先级**
P2 — 当前本机单用户不阻断；远程部署为 P0。

**建议修复方式**
不要直接放开监听地址。先定义主体到 Project/Workspace 的可见性和资源目录规则，再实现 resolver，并对所有 bootstrap、view、progress 和 WebSocket 路由做一致鉴权。

**验证方式**
两个互不授权的主体无法通过任何列表、view、progress、错误详情或缓存观察对方 Project；授权主体只看到明确授予的范围。

## KP-005：首次模型配置已落地，真实 Provider 发布支持矩阵未完成

**问题编号**
KP-005

**现象**
普通可执行入口未配置模型时已显示首次配置页，并阻止业务 API、WebSocket 和
后台任务；不再使用 fake Provider 回答用户。首次兼容 OpenAI 配置、连接检查、
私有凭据保存及自动重载已实现，独立安装包的外部真实模型配置、真实助手回复
和重启历史读取已通过。剩余缺口是完整编程任务，以及常见 Provider 的工具调用、
结构化输出、流式和恢复支持矩阵。早期 DNS/TLS 失败是历史观察，不是当前阻断。

**复现步骤**

1. 在隔离数据及配置目录启动安装包，确认首次配置页可见。
2. 未配置时请求 `/commands`，得到 503，不能进入工作流程。
3. 使用已授权外部模型地址连接，可配置并获得真实回复；再尝试修改文件，观察
   当前权限及阻塞恢复流程，详见 KP-012。
4. 检查实际 Provider registry：不能据 OpenAI-compatible 接口就宣称已经具备
   Anthropic/Gemini 原生协议或全部模型的发布资格。

**影响范围**
首次真实模型使用、Provider 支持声明和完整 coding agent 发布资格。

**可能原因**
原生协议和各模型能力矩阵尚未实现及验收完成。一次兼容 OpenAI 模型的成功
不代表所有模型或原生协议已获支持。

**涉及文件**

- `apps/single-workspace/src/model-setup.ts`
- `apps/single-workspace/src/main.ts`
- `apps/single-workspace/src/registry.ts`
- `apps/web/src/pages/ModelSetupGate.tsx`
- `adapters/provider-openai/src/index.ts`

**优先级**
P0 — 同发行物命令/构建/测试任务及公开支持矩阵尚未完成。

**建议修复方式**
保留首次配置门禁及错误安全处理；对可用的外部模型完成配置、对话、工具调用
和恢复验收，再按实际能力发布支持矩阵。测试中的显式 fake 注入不能成为产品
fallback。

**验证方式**
同一安装包从浏览器配置外部真实模型，经自动重载完成真实任务；未配置、连接
失败和凭据失效不能伪造成功。每个支持组合提供明确的模型和能力证据。

## KP-012：文件阻塞与授权恢复已修复，命令任务仍待验收

**问题编号**
KP-012

**现象**
独立预览包使用真实模型后，读取 README 成功，修改被 `InvocationAuthorityDenied`
拒绝。旧包未形成持久工作阻塞，模型随后反复报告失败；文件没有改变。旧设置中的
高级授权要求填写内部 capability、分工标识、目标 ID 和 ISO 过期时间；现在工作
详情提供当前分工的限时文件授权入口。文件闭环已通过真实验收，进程命令任务
仍未完成。

**复现步骤**

1. 从 Linux x64 预览包首次配置真实模型，选择含 README 的真实目录。
2. 请求读取并追加一行，批准创建工作；不额外预授文件写入权限。
3. 旧包会拒绝 patch，随后 Blocked wait 也失败；查看文件仍未修改。
4. 当前源码已补正式装配和调用记录身份，并补分工页进入工作详情的入口。
   公开进程回归证明阻塞记录跨重启保留且停止请求模型。此前字体修复包的独立安装包
   真实模型浏览器旅程已通过：受阻后授权、新指导、实际修改、独立验证、人工验收及
   重启。随后 BaseLoop v3 的新预览包复验确认拒绝、可见阻断、重启保留、授权和实际
   写入、独立验证、人工验收和完成后重启读取均通过。第一次复验的失败由验收标准
   同时要求“标记无换行”和“标记加换行”造成；统一输入后的第二次真实旅程已通过，
   但这不包括命令/构建/测试。详情见
   `docs/verification/2026-11-15-blocked-prompt-recovery.md`。

**影响范围**
首次编程任务、写入权限申请、工作阻塞、模型调用消耗和人工恢复。

**可能原因**
已确认正式装配遗漏 WorkBlockerStore、处理器依赖和 Inbox sequence；编译器生成的
可执行工具 manifest 缺少证据校验要求的稳定身份。底层单测中手写完整依赖和
manifest，无法覆盖此正式装配差异。P4 的既有 `(name, version, hash)` 身份已用于
新调用记录；没有为缺失身份的旧记录猜测补写。SteerWork 正式装配也已接入
阻塞存储，使新指导更新旧阻塞并推进 Inbox sequence。真实证据见
`docs/verification/2026-11-14-linux-install-real-model.md`。

**涉及文件**

- `apps/single-workspace/src/composition.ts`
- `apps/single-workspace/src/control-actions.ts`
- `apps/single-workspace/src/registry.ts`
- `packages/agent-runtime/src/agent-loop-driver.ts`
- `packages/model-context/src/compiler.ts`
- `apps/web/src/pages/workspace/WorkspacePage.tsx`
- `apps/web/src/commands/forms/GrantPermissionForm.tsx`
- `apps/web/src/commands/forms/WorkspaceFilePermissionForm.tsx`
- `tests/functional/process/recovery-verdicts.functional.test.ts`

**优先级**
文件分支已修复并验收；P0 的命令/构建/测试阻断另见 KP-003。

**建议修复方式**
保留既有精确权限和证据校验；补齐正式启动路径，提供以项目、分工名称和
用户可理解的操作及有效期为单位的授权入口。真实受阻后经普通界面授权、
提供新指导、完成修改及验证，不可由验收脚本代办 grant。

**验证方式**
同一独立安装包与外部真实模型经浏览器完成读取、拒绝、可见阻塞、重启、明确
授权和恢复；确认拒绝时文件不变，受阻时不持续调用模型，授权不扩大目录或
授予对象。再完成真实修改、独立验证和人工验收。

## KP-006：仍有功能测试留在默认发布清单之外

**问题编号**
KP-006

**现象**
`tests/functional/pending/**` 中仍保留多项真实进程测试。默认 `vitest.functional.config.ts` 只选择 `process/**` 和 `package/**`，因此 pending 文件不会进入 `completeCoverage=true` 的默认 release profile。

这些文件不等于全部仍失败；问题是它们的当前处置没有在一个机器可检查的清单中统一为“已被其他测试覆盖”“仍待产品决策”“仍待实现”或“应提升到默认门禁”。

**复现步骤**

1. 列出 `tests/functional/pending/*.test.ts`。
2. 查看 `vitest.functional.config.ts` 的 include。
3. 运行 `pnpm test:manifest`，默认 inventory 不包含 pending 目录。

**影响范围**
发布覆盖声明、恢复边界、资源接入、审批和敏感读取。

**可能原因**
历史 gap 测试、实现完成后的未提升测试和仍待决策的负向用例混在同一目录。

**涉及文件**

- `tests/functional/pending/**`
- `vitest.functional.config.ts`
- `scripts/testing/check-manifest.mjs`
- `scripts/testing/resume-utils.mjs`

**优先级**
P1。

**建议修复方式**
为每个 pending 文件建立唯一 disposition：Promote、Superseded、GovernanceQuestion 或 HistoricalRed。默认发布清单必须能机器检查所有 Promote 文件，Superseded 必须指向替代测试，其他两类不得被描述为已覆盖。

**验证方式**
仓库中不存在无 disposition 的 pending 文件；manifest 检查验证默认清单和 disposition 索引一致。

## KP-007：历史证据容易被误读为当前状态

**问题编号**
KP-007

**现象**
`planning/results/**` 和 `planning/history/`（原根目录会话文件）保存了多个时间点的 schema、测试数量、开放问题和失败结论。它们是审计证据，但搜索时容易命中已经被后续实现替代的 present-tense 语句。

**复现步骤**

1. 搜索 `schema 52`、`AH10 remains open` 或旧测试数量。
2. 可以同时找到历史失败记录和当前实现/关闭记录。
3. 若不看日期、SHA 和状态，容易把历史结论当成当前事实。

**影响范围**
开发决策、发布判断、Agent 调研和负责人沟通。

**可能原因**
项目保留了大量不可改写的治理与验证证据，但过去缺少维护型当前状态入口。

**涉及文件**

- `planning/results/**`
- `planning/proposals/**`
- `planning/history/findings.md`
- `docs/CURRENT_STATE.md`
- `docs/KNOWN_PROBLEMS.md`

**优先级**
P1。

**建议修复方式**
保留历史文件不改写；所有 README、AGENTS 和当前入口统一链接本目录五份维护文档。新增审计记录必须写清日期、SHA、是否当前、是否被后续记录 supersede。

**验证方式**
新 Agent 只读取 README、AGENTS 和本目录五份文档即可得到一致的 schema、功能和开放问题口径；历史结果仍可按引用追溯。

## KP-008：Web 单 chunk 体积警告（已修复，2026-11-14）

**问题编号**
KP-008

**现象**
此前 Web production build 成功，但初始 JavaScript 集中在一个超过默认 500 kB 阈值的 chunk，产生 Vite 警告。当前已采用页面动态导入，入口 chunk 为 487.09 kB，构建无该警告。

**复现步骤**

1. 执行 `pnpm --filter @arbor/web build`。
2. 当前应看到多个按路由拆分的页面 chunk，无默认 chunk-size warning；旧单包现象已不可在当前实现复现。

**影响范围**
原问题涉及单包下载/解析和跨页面缓存粒度。共享 preload 与当前页面仍需加载，本修复未证明首屏总传输量或真实设备加载耗时达到任何性能目标。

**可能原因**
此前 AppRouter 静态引入全部业务页面，导致页面、表单和视图集中进入初始 chunk。

**涉及文件**

- `apps/web/src/pages/AppRouter.tsx`
- `apps/web/src/shell/AppShell.tsx`
- `apps/web/vite.config.ts`

**优先级**
原 P3；当前已修复。

**建议修复方式**
已按页面采用 React lazy，并将 Suspense 限定在内容区域；继续保持默认构建警告阈值。

**验证方式**
production build 无默认 chunk-size warning；Web 路由/交互回归和浏览器直接加载、刷新与导航验收。后续真实加载性能需另行测量。

## KP-009：核心实际场景已修复通过，整合后的完整发布资格仍待补齐

**问题编号**
KP-009

**现象**
2026-11-11 首次验收中，S2 被中止，S3 超时，页面和公开烟测失败。修复配置隔离、响应拦截、首次实时连接刷新和协作输入后，真实模型纠错/关键纠错/停止 3/3 通过，真实父子协作完整通过；公开流程定向 5/5、恢复/拒绝/交付等 13/13、页面 7/7、Web 279/279 通过。本项保留为当前整合源码的完整发布资格缺口，不能继续描述为上述用户流程均已失效。

**复现步骤**

1. 配置 `~/.config/arbor/arbor.config.json` 指向可用的 OpenAI-compatible Provider。
2. 设置 `ARBOR_RUN_REAL_PUBLIC_S2=1`，运行 `tests/capability/real-provider/public-s2-supervision-steer-stop.test.ts`。
3. 设置 `ARBOR_RUN_REAL_PUBLIC_S3=1`，运行 `tests/capability/real-provider/public-s3-collaboration.test.ts`。
4. 运行 `pnpm test:functional:smoke` 和浏览器场景套件。

**影响范围**
最初错误验收结论夸大了已证实的产品缺陷。核心纠错、停止、协作和页面流程现有本轮通过记录；整合头的完整发布资格仍不能仅引用这些定向结果。

**可能原因**
已确认测试配置指定文件不存在导致回退读取 HOME 的真实模型；响应拦截器扣住 HTTP headers，旧 S3 有 62 次 ConnectTimeout；页面首次实时连接不刷新旧缓存存在失败回归。协作输入还把“临时等待、禁止读取”写入独立验证风险约束；已明确临时指令和持续约束的适用范围。重启后的响应记录路径已显式携带，陈旧连接重置只以同一 Command envelope 有界重试一次。上述修复均有定向结果。旧恢复测试的 25 毫秒延迟不能证明成功已提交，现已改为提交前/后精确边界并分别检查 NeedsAttention/唯一恢复答案。不能据原始超时直接推断模型或未知 Runtime 缺陷。

**涉及文件**

- `tests/capability/real-provider/public-s2-supervision-steer-stop.test.ts`
- `tests/capability/real-provider/public-s3-collaboration.test.ts`
- `tests/capability/real-provider/public-s4-recovery.test.ts`
- `tests/capability/real-provider/provider-fetch-capture-hook.mjs`
- `tests/capability/real-provider/public-real-journey-support.ts`
- `tests/functional/support/provider-config-isolation.ts`
- `tests/functional/support/production-fixture.ts`
- `apps/web/src/providers/AppProviders.tsx`
- `tests/functional/ui/project-conversation.spec.ts`
- `tests/functional/ui/approval-completion.spec.ts`
- `tests/functional/ui/f21-project-resource.spec.ts`
- `tests/functional/ui/completed-work-visibility.spec.ts`
- `docs/USER_JOURNEY_ACCEPTANCE.md`

**优先级**
P1 — 核心受控用户旅程已通过，完整发布套件资格尚未补齐。

**建议修复方式**
保留原始失败证据和更正说明。按修正后的可执行任务输入串行重跑真实协作，核对独立验证、Parent Acceptance、文件和依赖事实；重启后继续记录同一 Provider 的真实请求。随后在 Linux 资格化进程执行开启后补齐当前源码完整发布资格，不把页面脚本 Provider 验证扩大为真实模型浏览器全旅程。

**验证方式**
真实 S2 三条分支、真实 S3 父子依赖闭环、S4-A/B 的适用边界以及全部浏览器用户流程在同一当前源码基线分别产生可审计结果；公共烟测和完整功能套件 exit 0。




## KP-013：coding agent 工具面仍缺少完整编辑与联网能力

**问题编号**
KP-013

**现象**
当前内置工具已有 `read@2`、`list@2`、`patch@2`、`write@1`、`glob@1`、`grep@1`
和 `shell@3`。`write`、`glob`、`grep` 已通过真实 schema 55、SQLite、ownership
admission、实际挂载目录和 evidence ledger 的 Tool Runtime 集成验证；中断后的非幂等
写入不会自动重执行。它们仍未在同一普通安装包、真实模型和真实项目的完整用户旅程
中验收。仍没有独立 `edit`、`delete`、
`move`、`websearch`、`fetch` 或浏览器工具。`patch` 仍只能对一个目标使用 unified
diff；它不能表达删除或移动。

**复现步骤**

1. 查看 `packages/tool-runtime/src/catalog.ts` 的 `BUILTIN_TOOLS` 和
   `packages/tool-runtime/src/tools/index.ts` 的 `BUILTIN_EXECUTORS`。
2. 查看 `tests/p12-filesystem-runtime.test.ts`，确认当前 schema、ownership、挂载、
   evidence 和恢复链路的集成验证范围。
3. 尝试让 Agent 进行删除/移动、在线网页读取或浏览器操作；目录中没有相应的
   独立工具定义和用户旅程资格。

**影响范围**
真实 coding 任务中的完整编辑、删除/移动、在线文档查询和网页读取。shell 当前
仍无生产 Linux Supported tuple；用 shell 代替专用工具也会丢失专用工具的参数
校验、来源、权限和恢复语义。

**可能原因**
P4 冻结的是最小工具集合；P12 允许通过通用 ToolDefinition/ToolExecutor 接缝
增加工具。首轮已经增加 write/glob/grep，但编辑结构、删除/移动、网页读取和
浏览器仍没有形成产品级工具合同或完整验收。

**涉及文件**

- `packages/tool-runtime/src/catalog.ts`
- `packages/tool-runtime/src/tools/index.ts`
- `packages/tool-runtime/src/tools/patch.ts`
- `packages/tool-runtime/src/tools/`
- `packages/ports/src/tool.ts`
- `docs/research/2026-11-14-coding-agent-tool-surface.md`

**优先级**
P0 — 独立 `write`、代码定位工具会直接影响真实 coding agent 能否完成常见任务；
websearch/fetch 是否纳入首发则还要按网络需求和产品范围分别确认。

**建议修复方式**
继续在普通安装包、真实模型和真实项目中验收 write/glob/grep 的模型调用、权限、
重启和独立验证；随后决定是否增加 edit/delete/move，并为 websearch/fetch 分别
定义目标、凭据、网络权限、结果来源、大小/超时和重定向合同。所有工具继续使用
同一 Tool Runtime 的 authority、approval、resource admission、sandbox 和
settlement，不通过 shell 绕过。

**验证方式**
用真实模型和普通安装包创建嵌套配置文件、覆盖已有文件、重启后重放并独立读取；
验证路径穿越、符号链接、越界父目录和并发覆盖被拒绝。对 grep/glob 验证真实
大型项目定位。对未来 websearch/fetch 验证真实网络服务、来源、重定向、主机/内网
拒绝、取消、大小限制和无凭据失败。当前调研证据见
`docs/research/2026-11-14-coding-agent-tool-surface.md` 和
`docs/research/2026-11-14-network-tool-surface.md`。

## KP-014：网络工具和扩展没有生产级执行边界

**问题编号**
KP-014

**现象**
当前工具目录含 read/list/patch/shell 和新增 write/glob/grep 源码候选。没有内置
`websearch`、`fetch`、Agent 浏览器或 MCP 执行器，也没有生产级统一处理它们的
执行地点、目标检查、凭据范围、页面子请求、远程副作用、停止和重启恢复。已有
网络代码包含旧 HTTPS GET/Unix socket 实验和新标准 CONNECT 候选；后者已注册
factory，但普通 production 仍无资格，且不是 websearch/fetch/MCP 执行器。
模型 Provider 的网络成功不能替代这些工具的资格。

2026-11-15 增量：新候选已补 HTTP CONNECT、一般方法、上传和响应流；真实
Git POST/npm 下载及 T2 分段上传通过。完整认证、跨连接重定向次数、DoH/隧道
语义、跨命令服务和普通安装包仍未资格。预览页面在用户浏览器执行；项目内容
外发和 HTTP 业务副作用不能仅凭 origin/IP/方法识别，冻结设计本轮未改变。

负责人随后明确：首要目标是工作区之间不任意串扰，出于安全考虑可不用那么苛刻。
修复优先证明真实多工作区文件/进程/服务边界及普通联网开发；TLS 正文审查、
识别全部应用层隧道或绝对内容防泄漏不自动成为本问题的首发修复条件。旧强合同
要显式对齐，不能通过改一个资格布尔值宣称已完成。

**复现步骤**

1. 查看当前 `packages/tool-runtime/src/catalog.ts`、`src/tools/index.ts`，确认
   没有 websearch/fetch/browser；旧 2026-11-14 inventory 仅代表当时四类工具。
2. 查看 `apps/single-workspace/src/transport/network-broker.ts` 和
   `network-socket-broker.ts`（旧 GET 实验）以及 `network-proxy-broker.ts`（新 CONNECT
   候选），确认 factory 登记后仍未通过 production Supported gate。
3. 在普通生产路径尝试要求 Agent 搜索网页、读取网页、操作浏览器或调用 MCP，
   没有对应的工具定义和可观察执行链路。
4. 检查 `network-socket-broker.ts` 的 method/Upgrade/CONNECT 拒绝及统一响应，
   对照新候选的真实 `POST .../git-upload-pack` 证据，区分旧 GET 限制与新候选已补
   能力；继续核对新通道未资格的 discovery、重定向及服务生命周期。证据见
   `docs/verification/2026-11-15-standard-network-proxy.md`。

**影响范围**
实时资料查询、网页读取、动态网页操作、远程扩展、依赖下载、开发预览、外部
服务调用和停止/重启后的副作用恢复。

**可能原因**
网络候选先验证了地址、TLS、重定向和隔离通道的基础能力，但工具级产品范围、
数据外发、凭据、浏览器子资源、MCP 传输和远程写入恢复尚未形成完整执行合同；
新增文件工具源码不解决网络工具缺口。

**涉及文件**

- `packages/tool-runtime/src/catalog.ts`
- `packages/tool-runtime/src/tools/index.ts`
- `apps/single-workspace/src/transport/network-egress.ts`
- `apps/single-workspace/src/transport/network-broker.ts`
- `apps/single-workspace/src/transport/network-socket-broker.ts`
- `apps/single-workspace/src/transport/network-proxy-broker.ts`
- `apps/single-workspace/src/transport/network-proxy-helper.ts`
- `docs/research/2026-11-14-network-tool-surface.md`
- `docs/research/2026-11-15-network-contract-audit.md`

**优先级**
P0 — 如果首发目标是完整 coding agent，至少项目命令的联网和明确承诺的网页/
扩展能力必须在普通安装包中真实可用；未纳入首发的能力必须明确显示为不支持。

**建议修复方式**
先由产品范围决定首发的网页搜索、网页读取、浏览器和 MCP 能力，再为每类工具
分别定义执行地点、目标/凭据范围、内容和副作用、取消、记录和重启语义。随后把
工具接入现有 Tool Runtime、权限、Sandbox、Observation 和 settlement 管线，并
用普通安装包、真实 Provider、真实目标服务完成正反向验收。项目命令的网络通道
必须和 Provider 及受信工具网络分开装配，不能用无隔离或主机网络回退。

**验证方式**
对每个已承诺工具执行真实网络正例和越界反例：公开 HTTPS、重定向、DNS rebinding、
主机/内网拒绝、凭据隔离、大小/超时/取消、停止、进程重启和远程写入未知状态；
对 MCP 分别覆盖 stdio 与远程传输（若纳入）；对浏览器覆盖子资源、WebSocket、
登录态、上传和提交（若纳入）。结果必须与同一发布包和同一源码基线绑定。
还需证明真实 smart HTTP 拉取、请求体/响应头/TLS 信任兼容、预览与控制台的
origin/凭据隔离，以及未知远程副作用的恢复；不能以 GET-only 夹具结果代替。
主要验收还必须包含 A/B 同时运行、不能任意读写未分配资源、同内部端口不串服务、
停止 A 不误停 B，以及经明确交付共享结果。最新产品决策见
`docs/decisions/2026-11-15-workspace-isolation-priority.md`。

## KP-015：Child 通信设计已明确，但跨层实现资格尚未完成

**问题编号**
KP-015

**现象**
P6/P7 已将 Child 定义为独立 Workspace/责任/通信区域：它有自己的 Session、
Work、Context、Inbox、Verification 和 Acceptance，Parent 通过 Assign、Message、
Deliverable、Dependency 和治理路径协作。当前 S3 资源层却使用 Parent `allow`
加 `exclusions_json` 的 carve-out 来表达已接受的物理写入所有权。设计层已经明确
两者不是同一层；最新产品方向也明确允许明确共享、可追溯交付和接收。剩余缺口是
生产执行/联网/并行工作区/服务生命周期/停止恢复的统一真实验收尚未完成，容易把
局部资源测试误报成完整 Child coding 能力。

**复现步骤**

1. 查看 `docs/design/03-detailed-implementation-design.md` v1.64 的 S3
   ownership supplement。
2. 查看 `adapters/persistence-sqlite/src/p53-canonical-ownership-carveouts-migration.ts`，
   确认 `exclusions_json` 和 delegation provenance 被作为 schema 53 的正式字段。
3. 查看 `adapters/persistence-sqlite/src/ownership.ts` 的
   `activateDelegatedOwnership` 与 `reclaimDelegatedOwnership`，确认激活更新
   Parent exclusion，回收移除 Parent exclusion。
4. 查看 `packages/domain/src/resources.ts` 的 `OwnershipRegion`、
   `addOwnershipExclusion` 和 `removeOwnershipExclusion`。

**影响范围**
Parent/Child 的形成、通信、文件工具、命令执行、未来网络工具、资源共享、回收、
重启恢复和用户对 Child 区域的理解。当前 P6/P7 通信测试不能证明资源层共享/回收
语义；当前 carve-out 测试也不能证明完整的独立 Workspace 用户旅程。

**可能原因**
2026-10-26 的治理包在物理资源写入层引入了 canonical ownership carve-outs；
通信语义和资源语义虽已分别落入设计，但当前发布链仍缺少把两者、进程执行、联网、
服务和恢复放在同一真实用户旅程中的资格证据。

**涉及文件**

- `docs/design/01-scenarios.md`
- `docs/design/02-system-design.md`
- `docs/design/03-detailed-implementation-design.md`
- `docs/design/implementation/P1/04-sqlite-schema.md`
- `docs/design/implementation/P4/05-resource-admission.md`
- `packages/domain/src/resources.ts`
- `packages/application/src/formation-consumer.ts`
- `packages/application/src/ownership-wiring.ts`
- `adapters/persistence-sqlite/src/ownership.ts`
- `adapters/persistence-sqlite/src/p53-canonical-ownership-carveouts-migration.ts`
- `docs/proposals/2026-11-15-independent-child-resource-areas.md`

**优先级**
P0 — 这是工作区之间不串扰、联网开发和完整 coding agent 发布资格的跨层验收阻断。

**建议修复方式**
按已冻结的通信和资源合同完成同一发行物上的真实验收：独立 Session/Inbox、明确
共享、formal write ownership、Deliverable/Delivery、Verification/Acceptance、
联网构建测试、服务生命周期、停止和重启恢复。不能用 worktree、目录分区或删除
carve-out 其中任一技术选择代替这项验收。历史 carve-out 只能作为历史资源事实
处理，不能从旧通信记录自动推导新的 Workspace 或权限。

**验证方式**
在普通安装包和真实模型旅程中同时证明两条链：Child 拥有独立 Session/Work/Inbox，
Parent 只能通过正式通信和治理路径协作；同时文件、命令和网络工具使用统一资源
准入，明确共享不扩大权限，交付不冒充 Acceptance，停止和重启后 Workspace、消息、
Deliverable、Verification、Acceptance 与资源绑定保持一致。

## KP-016：Workspace 默认执行能力已完成设计，运行时接入及发布资格仍未完成

**问题编号**
KP-016

**现象**
历史 `DecideSandboxPolicy` 的特殊授权链曾要求不同的两个 HumanPrincipal；原单用户
Resolver 复现会返回 `NoApplicableGrant`。设计层现已明确不再用第二个人类身份承载
Workspace 默认能力；持久 Workspace
授权、人类公开授权/撤销、内部自动执行绑定和浏览器表单只用一个本机用户，保留旧
回执历史。schema57、升级工具、生产 Layer 重开/撤销/恢复及当前来源门已有集中验证。

本问题仍为 OPEN/P0 的原因是**同一新安装包上的真实命令交付资格尚未完成**：模型
实际 Parent 分配入口已接通并通过撤权/恢复/回执重放集成检查，但真实模型分配、
完整联网构建测试、双 Workspace、停止恢复及最终验收仍待通过。不能继续把“schema57/handler 未注册”作为当前源码原因。

2026-11-24 源码复核又关闭了一处越权风险：Child 创建时若 Parent 当前授权缺失、
撤销或无法解析，不再静默建立 Child 的默认执行能力；Web 在 Workspace 尚未获得
`SystemInitialization` 基线时也不再展示无资格手工授权入口。该修复已有 Child
边界和 Web 定向回归，但没有改变本问题的真实安装包和完整 coding 旅程阻断。

晚间更新：`c283c8709076` 包已通过普通授权后的实际修改、构建、测试和公网 HTTPS；
尚未走完的是独立验证、人工验收及完整多工作区/停止恢复。此前的 qualification
evidence/probe 比较缺陷已由该包的实际执行证明修复；不得再写成完全没有命令成功
记录。后续实际失败转为 KP-017，不能把主任务命令成功扩大为完整交付。

**复现步骤**

1. 当前模型目录已有 `allocate_workspace_sandbox`；检查其直接 Child、Parent 上限和
   人工撤权门，不再以“没有模型入口”作为当前复现。
2. 使用普通预览安装包、真实模型和真实项目，从浏览器完成授权、命令、构建、测试、
   公网访问及双工作区恢复旅程；当前尚无覆盖全部行为的同一发行物成功记录。
3. 历史双身份缺口可由旧命令 Resolver 夹具复现；它只证明旧路径，不能代表新入口。

Provider 不完整失败后的 readmission hold 曾错误终止 daemon，导致用户无法提交
新的 Work 修订；当前源码已改为保持 daemon 运行并把 Work 留在持久阻塞状态，
真实包中的公开 Steer 已能提交；KP-017 的旧验证等待修复已在第三个恢复包使 revision 5→6 并重新派发，独立命令验证仍未完成。

安装包又发现 qualification evidence 与主机 probe 指纹被错误比较，已在源码修复，
后续包已取得上述真实命令成功证据。

当前实现、实际发现的竞争缺口及修复记录见
`docs/verification/2026-11-16-workspace-production-integration.md`；历史纯 Resolver
证据保留于 `.test-results/workspace-authority-gap-20261116/result.json`。

**影响范围**
Linux sandbox 策略选择、shell、构建、测试、依赖下载、联网工具、Workspace
隔离、停止恢复和首发发布资格。

**可能原因**
P12 的 Native OS Sandbox 特殊授权增量把主机 provider 信任和用户 Workspace
授权耦合为 HumanPrincipal-to-HumanPrincipal grant。P4/P11 已经具备按 Workspace
ResourceBoundary、ownership 和 Execution 绑定资源的事实，但该特殊授权没有复用
这些工作区事实。

**涉及文件**

- `docs/design/implementation/P12/02-authority-resolver.md`
- `docs/design/implementation/P4/04-sandbox.md`
- `packages/application/src/authority-resolver.ts`
- `packages/application/src/commands/grant-permission.ts`
- `packages/application/src/commands/decide-sandbox-policy.ts`
- `apps/single-workspace/src/transport/auth.ts`
- `apps/web/src/commands/forms/DecideSandboxPolicyForm.tsx`
- `planning/proposals/workspace-scoped-sandbox-policy-authority-draft.md`

**优先级**
P0 — 真实 Linux coding agent 发布阻断。

**建议修复方式**
按已确定的 Workspace 授权口径，并沿用现有 Parent/Direct-Child 治理关系，将
以持久 Workspace 授权记录和内部 `BindWorkspaceSandboxPolicy` 绑定当前
Workspace、ResourceBoundary、ownership、Execution 和策略版本；旧命令保留历史语义。
`user:local` 只保留为请求认证和审计来源。P5 的
authority bundle 继续证明 provider/operator 可信，但不再充当第二个人类用户权限
系统。实现必须同时处理旧 grant/provenance 的历史兼容，不能用伪造身份填充旧字段。

**验证方式**
在普通安装包中用一个本机用户完成真实模型、现有项目、WorkspaceWrite、构建、测试
和公网 HTTPS 旅程；全过程不设置第二 principal、隐藏 token 或内部环境变量。再用
两个 Workspace 同时执行，证明资源互不可见、边界/ownership/Execution 变化使旧策略
失效、重启后仍按同一 Workspace durable facts 恢复，并保留准确的 actor、Workspace
和 Execution 审计绑定。


## KP-017：独立验证器没有命令沙箱绑定，完整命令任务无法走完验收

**问题编号**
KP-017

**现象**
真实安装包的生产任务已运行测试、修改代码、构建并联网成功；随后独立验证器能读
项目，但 `shell` 没有支持的执行策略绑定。原实现返回不存在持久请求的“等待授权”，
反复重入后触发保护停止，Verification 保持 Open、无证据、无结论。安全停止记录又
曾使整个项目关注事项读取返回 503；该读取缺陷已修复并通过新包公开浏览器恢复。
用户补充指导后，旧版验证等待仍阻塞新版 Work；源码已修复，安装恢复已观察到
revision 5→6 的公开提交、新执行和精确命令审批，尚未完成后续验证与验收。
2026-11-25 另修正了 Verifier 的任务指令：普通项目目录可能不是 Git 仓库，`git
status`、`git diff` 和 `git log` 只能作为可选诊断，不能把“不存在 Git 仓库”的退出码
直接当作核心 criterion 的失败或 Unknown。该修复已通过根 typecheck、Biome 和新
Linux preview 打包，但尚未证明独立 Verifier 能在真实安装旅程中完成全部命令、证据、
结论和人工验收，因此不关闭本问题。

**复现步骤**

1. 使用 `c283c8709076` 包、真实模型、真实项目及公开浏览器授权，要求先失败测试，
   再修复、构建、测试、联网并提交独立验证。
2. 主任务产生真实命令输出并提交完成声明；独立验证器尝试 `shell`。
3. 观察验证器停止但 Verification 无结论；原包打开关注事项返回
   `projection/unavailable / EpisodeVersionUnsupported`。
4. 原包通过公开“调整方向”推进 Work 修订后仍显示等待执行；重启保留该等待。
5. 修复包的读取恢复与新修订唤醒证明见
   `docs/verification/2026-11-16-installed-workspace-command.md`；这些修复没有
   实现独立验证器的 native 命令，也没有产生最终 Acceptance。

**影响范围**
需要独立运行测试、构建或其他命令的真实 coding 任务；验证失败后的可观察性和
纠错恢复。之前文件型任务的通过记录不覆盖此路径。

**可能原因**
策略账本和闭合快照绑定 Workspace ExecutionEpisodeBinding，独立 Verifier 则是
ExecutionBoundAgentBinding。两者不能互换，也不能借用 Producer 的可写策略。
早退分支错误地把“不支持的绑定”表示为可恢复等待。P10 还把验证器的合法身份
当作未知 Workspace episode；wake sink 未使自验证等待随 Work 修订前移而失效。

**涉及文件**

- `apps/single-workspace/src/executable-tool-handler.ts`
- `apps/single-workspace/src/workspace-sandbox-policy-binding.ts`
- `apps/single-workspace/src/projection-query.ts`
- `packages/domain/src/sandbox-policy.ts`
- `packages/domain/src/execution.ts`
- `packages/projection-runtime/src/attention-loader.ts`
- `packages/application/src/wake-sink.ts`
- `docs/design/implementation/P8/02-verifier-execution.md`
- `docs/design/implementation/P4/04-sandbox.md`

**优先级**
P0 — 完整 Linux coding 交付阻断。

**建议修复方式**
保留已完成的精确身份读取和旧等待修复；对不支持的命令明确返回未执行结果，
不制造虚假等待。为独立验证建立受治理的精确执行绑定，保留 Producer 原成果
不可写、工作区权限上限、动作审批及停止/恢复；临时可写验证区与原项目分离。
负责人已接受临时副本固定方案，P8/P4/P12/DID 1.67 的所属条款已落地。输入
捕获、完整权限/版本/来源复查及 Scope 清理组件已有合批 31 项资格；它们尚未
注册到普通 daemon。仍需专用持久策略、实际挂载资格、P4 命令接线和完整安装验收。
不能直接把 ExecutionBoundEpisode 塞进既有 Workspace episode codec，或自动把
未检查项判为 Pass。

**验证方式**
同一新安装包、真实模型和公开浏览器完成主任务修改/命令→独立命令验证→逐项证据
及结论→人工验收→重启查看。证明验证命令可以生成临时文件但不能修改 Producer
原文件、权限撤销生效、停止不残留进程、孤儿验证可显式恢复。检查保留旧验证归属，
新修订不被旧等待卡住；当前/未来修订与其他 Work 的等待不能被错误清除。


## KP-018：命令审批隐藏实际命令却仍允许批准

**问题编号**
KP-018

**现象**
真实安装包的待处理页面提供“批准本次精确动作”，但 `command` 和 `cwd` 都是
`[redacted]`。用户只能看到工具名、能力、超时及摘要，无法判断要运行的命令。

**复现步骤**
1. 运行 `06193bb2acc3` 恢复包并打开已有验收工作。
2. 通过公开浏览器提交指导，使 revision 5→6 并产生新的 shell 动作审批。
3. 打开待处理页面，观察命令/cwd 全被遮盖但仍显示“批准并继续”。
4. 证据：`.test-results/workspace-qualification-evidence-fixed-20261116/wake-recovery-stable.json`
   的 queue 页面和 `wake-recovery-queue-stable.png`；该动作未在这轮恢复中批准。

**影响范围**
需要用户审批的真实 shell 命令；尤其是构建、测试、下载、删除和发布等意义不同的动作。
已确认的是审批内容不可审查，没有证据表明审批绑定被绕过或越界命令已经执行。

**可能原因**
`previewValue` 隐藏所有非枚举字符串及路径名称，shell 的 command/cwd 因此必然
隐藏。现有测试只证明 canary 不泄露，甚至把隐藏命令后的可批准 DTO 当作成功；
没有证明用户能区分实际动作。P10/05 已明确要求足够动作/目标细节，不能审查时
不得展示批准；当前实现不满足这一要求。

**涉及文件**
- `packages/projection-runtime/src/inbox-view.ts`
- `apps/web/src/views/InboxView.tsx`
- `apps/web/src/commands/forms/ResolveExecutableApprovalForm.tsx`
- `tests/p10-inbox-view.test.ts`
- `tests/functional/ui/p38-executable-approval-browser.spec.ts`
- `docs/design/implementation/P10/05-surface-actions-transport.md`

**优先级**
P1，真实命令任务交付阻碍。

**建议修复方式**
按既有 P10 合同提供能判断实际动作的可信详情，继续保护密钥和宿主私密信息，
不使用模型自己编写的摘要代替绑定参数；无法精确审查时不能保留可批准状态。
需要的新传输/显示合同先在所属文档闭合，不粗暴取消全局脱敏。

**验证方式**
真实模型、普通安装和浏览器中能区分两条不同命令及目标；用户批准的精确绑定与
实际执行一致。密钥 canary 不泄露到常规页面/事件，缺失或过时详情不得批准；
同一发行物完成真实命令、独立验证和人工验收。

## KP-019：包数量不是主要问题，核心实现和测试替身边界仍然混在一起

**问题编号**
KP-019

**现象**
仓库有 28 个 workspace package，但复杂度集中在少数大文件：
`packages/agent-runtime/src/model-decision.ts`、`apps/single-workspace/src/control-actions.ts`、
`packages/tool-runtime/src/runtime.ts` 和 `adapters/persistence-sqlite/src/attention-projection.ts`
都是数千行级。入口应用同时静态编译 fake/testecho provider 注册表，测试替身没有
完全从正式发布边界中分离；`environment-local` 虽明确标注 TEST-ONLY，仍以独立
adapter 出现在生产 workspace 目录中。声明的 package DAG 和运行时模块图目前没有
循环，但 ports/application 仍有三组类型导入循环。

**复现步骤**

1. 统计 `packages/*`、`adapters/*`、`apps/*` 下的 workspace manifest，得到 28 个 package。
2. 查看上述大文件的行数，观察职责聚集在入口、Runtime 和持久化文件中。
3. 查看 `apps/single-workspace/src/provider-registry.table.ts` 及其 package manifest，
   看到 fake/testecho 被入口应用静态注册和编译。
4. 查看 `adapters/environment-local/src/index.ts` 的 TEST-ONLY 声明。
5. 扫描 import 图：运行时无模块环，类型图仍存在 ports/application 的循环。

**影响范围**
新功能开发、代码审查、发布裁剪、类型修改和测试与生产装配的一致性。它不会单独
证明普通生产已经使用 fake，也不是当前用户数据损坏问题；它会增加把实现接入真实
安装包时漏接或误接的概率。

**可能原因**
长期按阶段追加能力时，稳定依赖边界被保留，但文件职责没有同步拆分；为测试复用
而保留的 provider registry 和本地 fake 进入了应用的静态依赖；多个合同为了共享类型
直接互相导入。

**涉及文件**

- `apps/single-workspace/src/composition.ts`
- `apps/single-workspace/src/control-actions.ts`
- `apps/single-workspace/src/provider-registry.table.ts`
- `packages/agent-runtime/src/model-decision.ts`
- `packages/tool-runtime/src/runtime.ts`
- `packages/ports/src/provider.ts`
- `packages/ports/src/tool.ts`
- `packages/application/src/gateway.ts`
- `adapters/sandbox-local/src/verification-input-copy.ts`

**优先级**
P1 — 主要阻碍开发收敛和发布边界审查，不是单独的运行时启动阻断。

**建议修复方式**
保留现有 package DAG，按稳定职责拆大文件和类型合同；把本地文件复制等机制放在
对应 adapter，把验证环境编排留在 app；为测试 provider 建立明确的 test-only registry
装配，确保正式发布入口只编译需要的真实 provider；逐组消除类型循环，不通过新增
barrel export 隐藏依赖。

**验证方式**
每次只移动一个边界，执行受影响 package 的 typecheck、架构检查和目标功能测试；
最后从 clean checkout 构建发布物，确认 fake/testecho 与 TEST-ONLY adapter 不在
正式运行入口的依赖闭包中，同时真实 Provider、文件工具和 Linux 隔离路径仍可用。

## KP-020：最终 Provider 失败曾跨 Execution 无限重入同一 Work revision

**问题编号**
KP-020

**现象**
真实 Linux 发行物在 Provider 连续 `TransportFailed` 后，每次 Provider Turn 都正确
记录 `TerminalFailure + retry_decision=Stop`，但同一 Open Work revision 没有
readmission hold。Scheduler 因而不断创建新的 WorkEpisode Execution；一次真实验收
数据库中出现 `7,585` 个失败 Execution，其中 `7,584` 个属于 Work Episode。

方案 A 已于 2026-11-25 获负责人确认：所有非取消型 Provider failure，只要最终 Attempt
是 `TerminalFailure + Stop` 且 Step/Turn/Attempt/Manifest 链完整，就建立精确
Work-revision hold。当前代码已将该 gate 扩展到 `TransportFailed`、`ProviderUnavailable`
等 failure kind；P2/P7/P10 定向验证和真实 retryable failure 旅程通过。新生成的
source-free Linux x64 preview 已完成启动烟测，但完整发行物 Provider 失败旅程、重启
保持 hold 和 revision-advancing `SteerWork` 仍待验收。

**复现步骤**

1. 使用真实 Provider 让同一 Work 的 Provider Turn 连续发生 `TransportFailed`。
2. 等待第一次 Execution 以 `Failed(ProviderFailure:TransportFailed)` 结算。
3. 在旧实现中观察同一 Work revision 产生第二个及后续 WorkEpisode Execution。
4. 查询数据库中的 `provider_attempts`，可见最终记录为 `TerminalFailure / Stop`。

**影响范围**

Provider 失败恢复、Scheduler、Provider 额度和网络资源、SQLite 执行历史、Attention、
Work 修订、重启恢复及真实 coding 任务交付。

**可能原因**

旧 RAI-DG-02 只允许 `AuthenticationFailed`、`RequestRejected` 和
`ProtocolViolation` 进入 readmission gate，而 Provider Runtime 允许
`TransportFailed` 等 retryable kind 在安全证据不足或预算耗尽时最终 Stop。Turn-local
重试和 Work-level admission 之间缺少跨 Execution 的持久阻塞语义。

**涉及文件**

- `packages/ports/src/readmission-gate.ts`
- `adapters/persistence-sqlite/src/work-readmission-gate.ts`
- `apps/single-workspace/src/runnable-source-p7.ts`
- `apps/single-workspace/src/projection-query.ts`
- `packages/api-contracts/src/views.ts`
- `planning/proposals/2026-11-25-terminal-provider-failure-all-stop-readmission-hold.md`

**优先级**

P0 — 会造成后台无限消耗，发布前必须关闭。

**建议修复方式**

使用现有 exact Work-revision gate，验证完整 Step/Turn/Attempt/Manifest 链；任何最终
`TerminalFailure + Stop` 的非取消型 Provider failure 都建立 hold。Work 保持 Open，
仅由明确的 revision-advancing `SteerWork` 恢复；不引入自动轮询、合成 WorkWait 或
伪造成功。

**验证方式**

P2 gate 对所有 failure kind 的完整链测试通过；真实 Scheduler 在连续 tick、daemon
重启和 Provider 失败后都只保留一个同 revision Execution；Steer 后只创建一个新
revision Execution；Attention/Work Detail 显示安全的 failure kind，且不泄露 Provider
原始响应、凭据或请求内容。
