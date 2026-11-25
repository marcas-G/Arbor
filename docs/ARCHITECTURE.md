# 架构

更新日期：2026-11-20  
权威来源：System Design v1.27、DID v1.68 及所属阶段的已接受补充。  
本文件只做当前实现导览，不改变冻结架构。

2026-11-20 设计落地：合格 Linux 隔离环境完成精确资格检查后，Project/Workspace
初始化应建立当前 Workspace 边界内的 `WorkspaceWrite × Enabled` 基础能力；普通
Work 和重启不重复申请。当前实现仍在完成初始化建账、撤权/恢复、Child 边界和
同一发行物验收，未资格化环境继续安全地保持 Disabled/fail-closed。该默认事实
不是第二个人类身份，也不替代每次 Execution 的精确策略绑定。

2026-11-16 执行接入边界：普通 Work 的持久 Workspace 授权 → 内部策略 Binder →
P4 → Native POSIX → 受控公网通道已在安装包真实任务执行过构建、测试及 HTTPS。
独立 Verifier 使用 ExecutionBoundAgentBinding/ExecutionBoundEpisode，当前 native
策略账本及严格快照只接受 Workspace ExecutionEpisodeBinding；不能借用 Producer
的策略快照。该缺口仍阻断独立命令验证。P10 的安全停止读取已补精确 canonical
execution-bound 身份校验，保留其 workspace-scoped Attention，未向 Work 或 native
策略解码器塞入伪造绑定。HumanIntervention 消费还会清除同一 Work 的旧修订自验证
等待，不改变旧 Verification 的归属或结论。证据及尚未完成范围见
`docs/verification/2026-11-16-installed-workspace-command.md`。

2026-11-16 独立验证补充：负责人已接受临时副本，DID 1.67/P8/P4/P12 已落地。
`adapters/sandbox-local/src/verification-input-copy.ts` 负责实际输入捕获、源内容重验和副本释放；
`verification-command-environment.ts` 组合当前 canonical 身份、完整授权来源链、
只读取材边界和当前主机材料，准备独立副本并要求 Scope 管理生命周期。
此准备层尚未在普通 daemon 注册，不写策略决定、不签发 Supported、不调用
执行器；新的验证策略、实际挂载资格、P4 effect admission 和恢复接线仍需完成。

## 总体结构

```text
                              ┌──────────────────────┐
                              │      apps/web        │
                              │ React + Query + UI   │
                              │ Tailwind + Radix     │
                              └──────────┬───────────┘
                                         │ HTTP / WS
                              ┌──────────▼───────────┐
                              │ apps/single-workspace│
                              │ composition + daemon │
                              └──────┬───────┬───────┘
                                     │       │
                  ┌──────────────────▼─┐   ┌─▼──────────────────┐
                  │ application/runtime│   │ projection-runtime │
                  └─────────┬──────────┘   └─────────┬──────────┘
                            │ ports                  │ ports
                  ┌─────────▼────────────────────────▼──────────┐
                  │                 ports                         │
                  └─────────┬────────────────────────┬──────────┘
                            │                        │
                  ┌─────────▼──────────┐   ┌────────▼───────────┐
                  │ domain semantics   │   │ adapters            │
                  │ no infrastructure  │   │ SQLite/provider/... │
                  └────────────────────┘   └────────────────────┘
```

## 本机启动与页面更新

`scripts/start-user.mjs` 是用户后台启动入口。普通 `arbor` / `open` 调用自动
使用操作系统用户数据目录保存数据库；目标数据库不存在时，先启动独立的
离线 `schema-upgrade` 子进程执行 `fresh`，成功后才启动普通 daemon。项目
目录在 Web 界面内选择，不默认继承启动命令的当前目录。`ARBOR_DB`、
`--data-dir`、`ARBOR_PROJECT_ROOT` 和 `--project-root` 只用于高级部署、
兼容预设或测试。已有数据库不经过自动迁移。
初始化报告和 manifest 留在数据库旁；当前源码 daemon 要求精确 schema 57。
前台 `scripts/start-local.mjs` / `pnpm start` 仍要求预先初始化数据库。

启动器用源码/构建摘要判断是否需要重建，通过 `/runtime` 核对 Arbor 产品、数据库指纹、构建和进程身份；这些是诊断信息，不是业务权限或 readiness。Linux 停止操作还核对 `/proc` 的启动 tick 和入口路径，拒绝复用 PID。首次模型配置独立 host 写入口已按负责人接受的固定方案落地，只处理真实连接检查、私有凭据及受控重载；精确 P13 例外见 `docs/decisions/2026-11-14-first-run-model-setup.md`，不授权任意配置写入。

Web 的服务端状态由 Query 缓存持有，WS 只通知失效。首次认证连接和重连
成功后都会刷新当前视图，覆盖初始 HTTP 读取和 WS 订阅之间的变更窗口；
失效帧不作为业务数据直接写入缓存。

Web UI 使用 Tailwind utilities；主题别名复用 `tokens.ts` / `tokens.css`
中的颜色、字号和间距，不启用 Preflight。共享可编辑组件保存在
`components/ui/**`，遵循 shadcn 的项目内源码模式；`components.json`
记录生成配置，`@/` 别名在 TypeScript 与 Vite 同时解析。页面较长的布局
utility recipe 位于相邻 `*.styles.ts`，由 Tailwind 构建时扫描，无运行时样式库。

Radix Dialog、DropdownMenu、Tabs 分别负责 Sheet、移动端“更多”和分工
标签页的焦点、键盘与可访问性语义。Tabs 的选中值仍由 URL 决定，方向键只
移动焦点，Enter 选择；菜单只调用既有路由和刷新/断开操作。旧 CSS Modules
和组件全局样式已移除，全局仅保留 reset、tokens、utility layer 和辅助功能
规则。`lib/utils.ts` 的 class merge 显式识别 Arbor 字号/间距/阴影别名，防止
把 `text-small` 错当作颜色而移除。

`AppRouter` 按页面动态导入，以内容区域内的 Suspense 呈现加载状态，保留
导航外壳。Query、WS、表单重试身份和服务端权限仍沿原有路径工作。

## 首发运行边界

Arbor 首发是 Linux 本机单用户 coding agent。安装器负责提供可运行的 daemon、Web 资源和启动命令；普通用户不应通过设置 `ARBOR_DB`、`ARBOR_PROJECT_ROOT` 或内部端口来完成日常使用。用户首次启动后在 Web 界面配置真实 Provider，并选择项目目录；未配置 Provider 时只能进入配置/诊断流程。

用户数据目录应统一承载 SQLite、Blob、项目目录登记、备份和升级记录。当前 production 将 Blob 新写入保存到 `<database>.blobs`，可用 `blobRoot` 同时覆盖 BlobStore 与 retention。兼容读取校验并复制旧临时文件；它不是完整历史迁移或备份工具，旧内容丢失后的恢复仍是发布缺口。

Linux 进程执行是首发 coding agent 的正式能力。它必须从 Composition Root 装配经过资格验证的文件、网络、环境、资源、停止和进程树边界；没有资格的运行组合继续 fail-closed，不能回退到测试用 TrustedLocal。

该边界必须同时支持严格隔离与受控联网。网络代码归 P12 transport：
`network-egress.ts` 校验 origin、地址及 Pref64，`pref64-discovery.ts` 解析正向
已知答案，`network-broker.ts` 编排旧的有界 GET。新增 `network-proxy-broker.ts`
使用 Node HTTP CONNECT/HTTP/TLS/stream，`network-proxy-helper.ts` 提供仅在沙箱内
运行的 TCP/Unix socket 字节转发。证书由 `@peculiar/x509` 与 WebCrypto 生成；
authority 私钥只在宿主内存，不挂载给项目、不安装到宿主信任库。

依赖方向为 composition → transport → domain 与 adapter binding 类型；adapter
不导入 app，而是接收每次执行的 socket/public certificate/helper 路径并负责关闭。
未新增 Runtime→Adapter 或包间循环。Composition 已登记 factory，普通生产的
Supported gate 仍为 false。真实 curl/Git/npm 的 T2 候选结果不构成发布资格。

Native 的 Effect 取消 finalizer 现在等待精确 systemd unit 的整个进程组和 broker
结束；取消早于 unit 创建时不能接受客户端仍活跃期间的 not-found。进程/网络清理
失败保持为缺陷，不能转为普通无效果 Unavailable。运行中的 Execution 由持久
`stop_requested_at` 通过标准 `AbortController` 进入 Provider Runtime；公共
StopExecution 到挂起 Provider 的取消链路已有真实 daemon 证据。Native 进程副作用
的完整取消/恢复矩阵仍需独立验收。

最新产品优先级是避免工作区任意串扰，安全增强可按实际需要收敛。架构应以
当前 Workspace 的资源范围/写入所有权、进程树、临时状态和服务入口为归属基础，
让不同工具使用一致边界；隔离载体不等于长期 Workspace 本身。常规联网接口应
兼容原生工具，不能默认把 TLS 解密或绝对内容过滤作为基础依赖。旧强网络合同
尚需显式修订，当前实现没有因此获得新资格。决策与外部对照分别见
`docs/decisions/2026-11-15-workspace-isolation-priority.md`、
`docs/research/2026-11-15-agent-isolation-comparison.md`。

## 模块依赖

冻结且由架构测试强制的直接依赖是：

| 模块 | 允许直接依赖 |
|---|---|
| `domain` | 无内部依赖 |
| `ports` | `domain` |
| `application` | `domain`, `ports` |
| `model-context` | `domain`, `ports` |
| `agent-runtime` | `domain`, `ports`, `application`, `model-context` |
| `execution-runtime` | `domain`, `ports`, `application`, `agent-runtime` |
| `provider-runtime` | `ports` |
| `tool-runtime` | `domain`, `ports` |
| `projection-runtime` | `domain`, `ports` |
| `api-contracts` | `domain` |
| `adapters/*` | `domain`, `ports` |
| `apps/*` | Composition Root，可装配 packages 与 adapters |

额外边界：

- Runtime 依赖 Port，不依赖具体 Adapter；
- Adapter 不依赖 Application 或 Runtime；
- Projection 不参与权限决策；
- 所有权威状态变化通过 Application Command；
- 禁止 package deep import；
- `model-context` 不直接依赖 `tool-runtime` 或 `agent-runtime`；
- 生产 package 不依赖 `testkit`。

这些规则由 `tests/architecture/**` 和 `tests/architecture/package-dag.ts` 检查。

## 循环依赖

当前 package DAG 没有允许的循环边。现有依赖矩阵本身是有向无环结构，架构测试会拒绝未声明 edge、deep import、Runtime→Adapter 和 Adapter→Runtime 等反向依赖。

2026-11-17 的源码扫描进一步区分了两类结果：运行时代码没有模块循环；类型导入仍有三组循环，主要集中在 `ports` 的 Provider/Tool/Execution 合同和 `application` 的 Gateway/Command/Consumer 合同。它们目前不会形成 ESM 运行时环，但会让类型修改的影响面异常大。沙箱策略的第一组类型循环已通过把共享 `SandboxPolicyLimitsV1` 提到 `domain/src/sandbox-policy-types.ts` 切断；其余循环应在对应合同重构时逐组消除，不能靠继续增加 barrel export 掩盖。

系统中存在业务反馈环，但它们通过 Port、持久事实和事件连接，不是源码 package 循环。例如：

```text
Execution → Agent Step → Action → Observation → 下一 Agent Step
Work → Verification → Acceptance/返工 → Work
Dependency wait → Delivery → satisfaction → wake → Work
Domain event → Projection → 用户 Command → 新 Domain event
```

这些环必须跨持久化和明确事务边界运行，不能用内存回调绕过。

## 业务逻辑散落的位置

### 权限、审批和动作执行

相关逻辑分布在：

- `packages/domain`：权限与目标的合法形状；
- `packages/application`：Authority Resolver、Grant/Revoke、Command 权限；
- `packages/agent-runtime`：控制动作可见性和解码；
- `packages/tool-runtime`：可执行动作审批、沙箱和效果结算；
- `apps/single-workspace`：当前 Workspace、Execution、资源和配置事实的组合；
- `apps/web`：用户批准/拒绝表单。

这种分布符合“语义、策略、执行、装配、交互”分层，但当前控制动作 wiring 很大，修改时需要跨层验证。

### Verification 与完成

Verification 没有独立物理 package。它横跨：

- Domain Verification/Acceptance 状态；
- Application 的启动、记录证据、结论、重试和消费者；
- Execution/Agent Runtime 的 verifier 执行；
- SQLite stores；
- Projection 和 Web 页面。

优点是没有新增错误依赖边；代价是开发者很难只看一个目录理解完整流程。

### Project 资源接入

普通生产入口支持两条兼容的目录接入路径：

```text
启动环境 → 兼容的无路径 Profile 列表
人工输入/浏览路径 → /project-directories
                  → 校验、可选新建末级文件夹、原子持久登记
                  → 追加到 host 进程内引用表
两者 → CreateProject 的 Profile 引用
     → Gateway 回执检查
     → 纯内存引用解析
     → 新目录引用的事务内重复绑定检查
     → Project/Workspace 提交
     → 既有所有权激活及 Attention
```

`project-directories.ts` 把目录登记保存于数据库旁的 `.project-directories`
私有目录，在成功发布记录后才允许引用解析。目录检查和新建目录发生在
Application 事务外；命令内部不调用文件系统。旧的启动预设仍使用原快照。
`/projects` 的路径来自持久根 Workspace 边界，供本机用户展示及复制；
模型动作、普通预设列表和命令回执不接收原始路径。

相关代码跨 transport bootstrap、Web form、Application command、environment resolver、ownership store 和 recovery。新增能力按 DID §4.1D 与
`docs/decisions/2026-11-11-project-directory-selection.md` 落地，不改变数据库 schema。

### Parent/Child 通信与资源所有权

Parent/Child 是两条相互配合但不能合并的链：

```text
Formation → 独立 Workspace + WorkspacePrimary Session
          → 独立 Work / Agent Loop / Context
          → Inbox / Message / Deliverable / Dependency
          → Verification → Parent Acceptance

Resource admission → ResourceBoundary + ownership claim
                  → Parent effective allow/exclusions
                  → Child delegated claim
                  → 文件/进程工具的 effect admission
```

通信链的主要实现位于 `packages/application` 的 formation、message、delivery 和
dependency commands，`packages/agent-runtime` 负责控制动作解码，
`adapters/persistence-sqlite` 持久化 Workspace、Session、Message、Inbox 和
ownership facts，`apps/single-workspace` 负责 formation consumer、scheduler 和
workflow wake。`CreateChildWorkspace` 会在命令事务中创建 Child 的 Workspace 和
`WorkspacePrimary` Session；Parent 的消息和交付进入 Child/Parent 的 Inbox，不能
直接追加另一方的 Session。

资源链由 `packages/domain/src/resources.ts`、
`packages/application/src/ownership-wiring.ts`、P4 admission、SQLite ownership
adapter 和具体 sandbox 共同完成。Parent 的 `exclusions` 只表示它在物理资源上
失去的有效写入范围，不能表示 Child 共享了 Parent 的 Session、Context 或责任。
只读共享、formal write ownership、通信可见性和治理 authority 分别判断；通信到达
不等于理解，Deliver 不等于 Verification 或 Acceptance，Dependency 只由结构化
matcher 满足。

这两条链当前有真实形成、交付、依赖和资源拒绝测试，但同一发行物上的并行工作区、
联网构建/测试、服务生命周期以及停止/重启完整资格仍受 Linux Native process
execution 未接通阻断。不能把局部 ownership carve-out 通过记录当作完整 Child
coding agent 交付。

### 崩溃恢复

恢复不是一个单独模块，而是由 Execution lease、Provider handoff、AgentLoopStep、ToolInvocation、Command receipt、Approval、Verification 和 Projection 各自提供可重放事实，再由 composition 中的 recovery loop 协调。

这保证局部所有权清晰，但使完整故障路径需要跨多个 package 阅读和测试。

对话响应 admission 是一个跨层协作点：`packages/application/src/conversation-response-runtime.ts`
通过 CommandGateway 驱动 admission，`packages/execution-runtime/src/commands/admit-execution.ts`
在同一事务中绑定 Execution、Attempt 和 Job，`apps/single-workspace/src/production.ts` 与
checkpoint owner adapter 在启动/周期恢复时消费这些事实。对历史上已经留下的
“Active Execution + Queued Job + 缺失 Attempt”半状态，恢复逻辑会结束旧 Execution、记录
`AdmissionInterrupted` 并把 Job 置为 `NeedsAttention`；Web 通过 `ResumeConversationResponse`
允许用户再次尝试，新的 Attempt/Execution 使用递增身份。该路径禁止自动重放未知响应，具体用户行为见
`docs/decisions/2026-11-14-conversation-response-resend.md`。

### 本机手动备份与恢复

`scripts/start-user.mjs` 的备份维护命令加载 executable 内的
`user-data-backup.ts`，复用 Node `node:sqlite` 的 `backup()`、现有 P39 跨进程
维护锁和 Application 的 `reconcileRestoredLeases`。维护操作不经模型控制动作，
不自动升级数据库；一个维护许可覆盖 SQLite、数据库旁内容目录和项目目录登记。

备份清单使用相对路径、大小和摘要；校验除核对文件还检查数据库完整性及已识别的
历史内容引用。扫描按字段和条目类型区分内容地址、Provider continuation 和文本；
`Deliver` 的摘要即使恰好是 64 位摘要字符串仍是文本。恢复只写新目录，完成前保留
阻止普通启动的标记，恢复后的旧 Worker incarnation 失效、租约代数前移并到期；
下次普通启动进入原有恢复链。`user-data-restore-guard.ts` 由 production composition
调用，启动器也提前给出诊断。

这不是全机器快照：项目文件、Git/worktree、模型凭据和独立沙箱授权/审计仍在边界外；
符号环境快照记录保留原值并报告数量。范围与操作步骤见 `docs/BACKUP_RESTORE.md`。

## 被多个地方依赖的接口

### `CommandGateway` 与 Command registry

Web、Agent 控制动作、消费者、恢复和系统协调都通过同一个 Command Gateway 写入权威状态。它是最关键的写入接口，任何 receipt、schema 或幂等语义变化都会影响大量调用者。

### Repository Ports

`ProjectRepository`、`WorkspaceRepository`、`WorkRepository`、`ExecutionRepository`、`SessionRepository`、`CommandStore`、Approval stores 和 Verification stores 被 Application、Runtime、Projection 或 Composition 共同依赖。Port 兼容性直接决定 SQLite adapter 和测试夹具的升级成本。

### `api-contracts`

服务端 view DTO、Problem、Command receipt 和 Web transport 共同依赖该包。它是后端与 UI 的稳定产品边界，不能由某一侧单独重解释。

### ActionCall / ControlTool / ToolInvocation

Model Context、Agent Runtime、Tool Runtime、Provider adapter 和恢复逻辑共同依赖动作 identity、callRef、invocationId 和 observation 绑定。任何“只改显示名称”的改动都可能触及持久重放语义。

### SQLite schema 和 migration descriptors

Runtime startup、离线 upgrader、manifest、测试数据库工厂、功能测试和 clean-checkout 都依赖精确 schema 版本与 descriptor hash。当前源码版本是 57，本轮完整升级和安装包资格仍在验证；原 schema 55 包不代表新版本资格。

## 会阻碍下一步开发的技术债

### 1. Composition Root 过大

`apps/single-workspace/src/composition.ts` 和生产 wiring 汇集大量服务、测试探针和首发策略。虽然依赖方向正确，但变更影响面大，容易出现某条生产路径和测试路径装配不一致。

建议：继续按稳定子装配提取 Layer factory，但不要把 Adapter 依赖泄露回 Runtime。

### 1.1 包边界与文件边界不一致

仓库当前有 28 个 workspace package，但真正的复杂度主要集中在少数文件：
`packages/agent-runtime/src/model-decision.ts`、`apps/single-workspace/src/control-actions.ts`、
`packages/tool-runtime/src/runtime.ts` 和 `adapters/persistence-sqlite/src/attention-projection.ts`。
另一方面，`worker-local` 这类很小的适配器本身不是问题，它代表可替换的 Port 实现；
不能为了减少目录数量把它们和核心 Runtime 合并。

本轮已先完成一项低风险边界修正：验证输入目录的 descriptor-anchored 遍历、复制、
哈希和清理属于本地沙箱机制，已移到 `adapters/sandbox-local`；应用只保留验证环境
准备和授权编排。下一步应按同一原则拆 `control-actions` 和 Composition 的职责，
每次只移动一个稳定边界并跑对应功能门禁，不能进行大规模目录改名。

### 2. 现行路径与 legacy 兼容路径并存

`legacy-directive-handlers.ts`、legacy codec、迁移 adoption 和恢复兼容仍在源码中。它们有历史读取价值，但增加了“旧名字看似仍可新写”的误解风险。

建议：为所有 legacy surface 保持单向约束：只读、审计、恢复或 fail-closed；架构测试禁止重新注册为新写入入口。

### 3. Migration 和夹具耦合度高

schema 36–56 的累计迁移、P39 特权步骤、descriptor hash、manifest、测试模板和 clean-checkout 必须同步。漏掉任何一处都会产生“单测绿但离线升级器不完整”的问题。

建议：把 schema version、descriptor 集合、支持前缀和文档口径继续收敛到可机器检查的单一清单。

### 4. 发布资格与实现门禁分离

`pnpm check` 不运行完整公开进程、Playwright、clean-checkout 或真实 Provider 旅程。实现可以全部单元测试通过，但仍缺当前源码基线的发布资格。

建议：发布分支使用不可歧义的 `check:release` 结果，并记录精确 SHA、是否 resume、执行/继承文件和 Provider/OS 边界。

### 5. 产品只支持本机单用户，代码已出现远程扩展边界

Authenticator 可替换，但跨 Project 列表和资源目录仍是 local-principal 特例。若直接扩展远程访问，容易在可见性 resolver 完成前泄露项目元数据。

建议：在产品明确需要多主体之前保持 loopback 限制；需要时先设计 Project visibility，再接入身份系统。

### 6. Web 包体跟踪

2026-11-14 已按路由拆分：production build 入口 chunk 为 487.09 kB，未再
触发默认 500 kB 单 chunk 警告。共享 preload、对话和业务页面另有资源，
此结果不等于首屏总 JavaScript 低于 500 kB，也没有测量真实设备的冷启动耗时。
后续继续按实测加载成本决定优化，而不提高警告阈值。

### 7. 网络入口没有统一成一个全局开关

模型 Provider、隔离项目命令、用户浏览器预览、Agent 浏览器、MCP 扩展和供应商
托管工具位于不同执行位置，访问目标、凭据和副作用也不同。当前网络候选集中在
`apps/single-workspace/src/transport/`：`network-egress.ts` 做目标授权，
`pref64-discovery.ts` 做地址发现答案解析，`network-broker.ts` 编排有界 HTTPS
GET，`network-tls-authority.ts` 和 `network-socket-broker.ts` 支持实验通道。
标准 CONNECT 候选另由 `network-proxy-broker.ts` / `network-proxy-helper.ts` 接到
Native adapter factory，但仍被生产资格门禁挡住；没有为 `websearch`、`fetch`、
浏览器或 MCP 提供工具执行器。

因此，浏览器的 Arbor UI 连接、项目预览入站映射、Agent 浏览器外部访问、MCP
远程服务和 Provider 托管工具不能互相借用权限。详细数据流、凭据和停止/重启
语义见 `docs/research/2026-11-14-network-tool-surface.md`。

2026-11-15 增量：旧 GET-only 候选的限制不能套用于新 CONNECT 候选。新候选已用
真实 Git POST/npm 下载及 T2 chunked POST/响应验证基础流转，尚未验证完整认证、
跨连接重定向次数、远程扩展和发布副作用。项目服务需要明确同沙箱网络与生命周期；预览
入口还需要独立于控制面的 origin/凭据边界，用户浏览器请求不能被假定经过沙箱。
目标授权不是内容外发过滤或业务副作用判断；DoH/隧道禁止措辞仍有可执行保证的
闭合工作。当前事实、外部来源、URL 层反例和建议验收顺序见
`docs/research/2026-11-15-network-contract-audit.md`；这些建议未落为新冻结语义。

## 下一步架构工作顺序

1. 用当前整合头重新完成发布级功能和真实 Provider 资格。
2. 按已确定的 Linux 范围完成工作区隔离与正常联网合同/实现对齐；保留用户数据库升级继续按其单独支持范围处理。
3. 将当前健康文档加入日常变更检查，阻止 README、schema 和 release 状态再次漂移。
4. 在不改变冻结语义的前提下拆小 composition 和 legacy compatibility wiring。


## 2026-11-16 独立 Linux 环境首装边界

`start-user.mjs` 的 `check-environment` / `install-environment` /
`reinstall-environment` 是 daemon 外的
独立安装命令。`transport/linux-sandbox-checks.ts` 使用固定临时资源、生产的
bwrap/systemd supervisor、实际网络 broker 和 DNS resolver 执行完整控制；只在
全部通过时生成规范候选 manifest，不签发运行时能力。

`transport/linux-environment-install.ts` 自行调用检查器，不接收外部资格结果或
Supported 标记。它复用 domain closed codecs、现有 protected provisioning store
及 `probeInstalledLinuxSandbox`，以 `proper-lockfile` 串行首装，在受保护同盘目录
暂存并整体发布 source/high-water/证据。首次安装保持不变；显式重新资格化会先把旧
authority 移到同盘的带时间戳目录，再发布新 authority，失败时恢复旧目录；daemon composition
不调用该安装器。生产仍通过现有 authority → policy decision → P4 admission 链路
消费材料，安装本身不创建 Workspace 文件权限、动作审批或业务数据库写入。

安装包内上述流程已在独立 ext4 用户目录通过；schema 顺延、普通模式/配置接入、
真实模型命令旅程及双 Workspace 仍未闭合。证据与失败记录见
`docs/verification/2026-11-16-linux-environment-install.md`。


## 2026-11-16 工作区权限生命周期增量

长期 Workspace 工具授权仍沿 P12 Resolver → P1 Gateway → PermissionGrantRepository
→ SQLite `permission_grants`，使用既有 NULL 过期字段，不引入第二个人类身份或
新数据库版本。`GrantPermission` schema 2 的持久入口只接受精确工作区
`fs:write` / `shell:exec`；Resolver 必须取得明确治理身份、Active Workspace
及 revision，Gateway 在事务内重新读取并核对 Workspace/project/lifecycle/revision
和可信时间。P4 工具执行继续读取当前有效权限、资源边界和动作审批；退休/跨项目
Workspace 不能取得新的工具权限。历史 schema 1 receipt 保留原结果解码。

持久能力不等于精确执行策略。旧 Native 策略的人类 issuer/subject 特殊链还未
替换；Parent 明确分配及当前上游 ceiling 的完整检查、每次 Execution 的新策略
物化与恢复仍是待实现的纵向链。设计决定和分阶段资格见
`docs/proposals/2026-11-16-workspace-permission-continuity.md`。


## 2026-11-16 工作区沙箱授权与撤权底座

新增 `domain/workspace-sandbox-authorization` → `ports/WorkspaceSandboxAuthorizationStore`
→ SQLite adapter 和独立 Application 当前来源链读取器。Gateway handler 用单事务
重新读取目标工作区、授权 head、可信时间与完整 Parent 来源链；来源 Execution
仅在分配时证明当前 Parent，分配后的授权不随其结束过期。只有当前 head 可以
授予能力，损坏/撤销 head 不回退历史。Child 撤权必须由用户重新授权解除，Parent
不能覆盖。每次成功变更保留完整事实、精确回执及 v1 变更事件。

当前生产 registry、外部人类命令和浏览器授权表单已接入这条链；runtime 为
schema57。内部 Parent 来源仍只能经受信 ExecutionOrigin 提交，不能从外部伪造。
模型工具目录已注册 `allocate_workspace_sandbox`，经 typed AgentAction、共享
授权器和生产 handler 路由至 Gateway；只接受直接 Child 引用，运行时绑定身份、
版本和 Parent 来源。旧成功回执在重新解析 Child 引用前恢复，但不会写入新授权；
新的分配始终检查当前人工撤权。RootConversation、Work、Inbox 可见，Decision、
Verifier 和历史 Specialist 不可见。真实模型双工作区资格仍开放。
当前资格及范围见 `docs/verification/2026-11-16-workspace-production-integration.md`。



## 2026-11-16 工作区到单次执行的策略绑定

新增内部 Application `BindWorkspaceSandboxPolicy`，通过 P12 解析器取得精确
System 来源、当前工作区授权版本和受信主机字段；主机 preparation 接口只依赖
实际使用的字段，不构造人类 grant。Gateway 提交前重新读取完整来源链、有效期、
精确 Execution/Episode 和既有主机/资源 CAS，生成 result v3（内部 Linux summary
仍为 v2）及显式 v2 策略事件。旧 `DecideSandboxPolicy` 只接受原有 v1/v2 结果。

schema57 在同一事务创建授权账本并迁移旧策略表，来源只能为旧人类 grant
或真实同 Project/Workspace 授权版本之一；保留入向故障外键和不可变触发器。
SQLite adapter 按表结构兼容 schema49–56；读取现代记录须匹配 schema1/v3 回执和
准确授权版本。通用注册包装器现在保留 preparation、准备结果、历史回执版本和
重放校验钩子，避免注册时丢失行为。

生产 registry、自动绑定和恢复入口、P4 当前来源复查、浏览器表单、离线副本升级、
签名、manifest 和维护终态已接入，CURRENT_SCHEMA_VERSION 为 57。Binder 在共同的
`runExecution` 恢复门之前及 shell 处理器中运行；当前修订已有不可用事实时不能
直接复用，须创建新的有限快照。文件工具在授权已存在时受其撤销和 ReadOnly 上限
约束；旧 fs:write 权限不会抵消已保存的只读或撤销决定。

工具 InvocationAuthority 携带进程内的当前授权 head 和 scope 来源。SQLite 的
`admitEffect` 在同一事务重新比较完整链的 head、Parent、生命周期、资源和策略
版本；P4 也核对进程策略的来源授权版本。此字段不存成另一种授权，不是外部输入。
已放行命令的强制终止不由这些检查证明；本轮验证覆盖新 effect 的准入竞争。

完整安装包真实模型命令/构建/测试及双工作区旅程仍待验收。分层检查中的主机
preparation/编排 fixtures 不等于 OS 资格。当前证据和失败见
`docs/verification/2026-11-16-workspace-production-integration.md`。
