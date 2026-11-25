# 当前状态

更新日期：2026-11-25  
源码基线：`5068be633bc9b2ee50fb4bcc36d658fa4c036149` 加本工作树中的未提交对齐修改。  
说明：本文件描述当前可执行实现，不把历史 `planning/results/**` 的阶段标签当成当前事实。

## 2026-11-25 方案 A 修复与发行物启动烟测

- 方案 A 已落地：所有非取消型 Provider failure 在形成完整
  `TerminalFailure + retry_decision=Stop` 后，对精确 Work revision 建立持久
  readmission hold；同一 revision 不再被 Scheduler 跨 Execution 无限重入。
- 新 Linux x64 source-free preview 已构建，buildId 为
  `sha256:472edfb314d99ccc1c8710b36ee7ebbacdd91227afb3992dc701ac53499f9cfb`，
  artifact SHA-256 为
  `19aeeac459f6d24d1fc002571f668e911f6e7a935ae4a7c699ea201cadb212af`。
- 脱离源码目录、仅使用发行物内置 Node、无 `pnpm` 和无手工 `ARBOR_*` 环境变量，
  在用户数据目录完成 schema 57 初始化、daemon 启动、`/runtime` 身份检查、
  静态首页访问和状态查询；数据目录由启动器以 `0700` 创建。
- 这只证明发行物启动链已闭合，不等于完整发布资格。真实 Provider、文件/命令/
  构建/测试、独立 Verification/人工 Acceptance、升级和正式发布渠道仍是开放项。

## 设计决定与当前实现的边界

2026-11-20 已接受并落入设计链的产品口径是：Linux 隔离环境通过精确资格检查后，
Project/Workspace 初始化自动建立当前 Workspace 边界内的
`WorkspaceWrite × Enabled` 基础执行能力；普通 Work 和 daemon 重启不重复申请。
这条记录使用 `SystemInitialization` 来源，不伪造 Human/Parent Grant，也不扩大
资源边界。当前源码已经补上初始化记录、幂等重放、撤权保留、Child ceiling 检查和
真实创建命令回执绑定；这表示实现链已落地，不表示 Linux 资格材料、安装包或真实
用户旅程已经完成。

当前运行环境缺少合格材料时仍必须安全地保持 `Disabled`/不可执行并显示安装或修复
状态。当前 Web 已把“未建立系统初始化基线”显示为安装/修复状态，不再提供无资格
环境下的手工授权后门；撤权后的用户恢复、阻塞 Work 的同一 Work 重试、实际安装/
修复操作、同一发行物真实命令旅程和完整发布验收仍是开放工作。本文件后面的“可用”
结论不得据此扩大。

## 2026-11-24 初始化能力落地

- `CreateProject` 和 `CreateChildWorkspace` 在生产组合根获得初始化端口后，会在同一
  Command 事务内尝试建立 `WorkspaceWrite × Enabled` 的
  `SystemInitialization` 基线。
- 初始化只接受精确的 Linux `linux-bwrap × WorkspaceWrite × Enabled` 资格和
  `NativeOsSupportedOnly` 启动模式；缺失资格不会回退到 TrustedLocal、FullAccess、
  fake Provider 或伪造 Human Grant。
- 基线绑定 Project、Workspace、ResourceBoundary/policy revision 和真实创建
  CommandId；重放为幂等，当前 Revoked head 不会被覆盖，Child 初始化不会超过
  Parent 当前 profile/network ceiling；若 Parent 当前授权缺失、撤销或无法解析，
  Child 不会静默获得默认能力。
- 未初始化的 Workspace 在 Web 中只显示安装/修复状态；只有已有 `Revoked` head
  才显示用户恢复入口，恢复仍要求当前合格 Linux 候选。
- 当前证据为根 typecheck、lint、初始化/Child 定向测试 7 项、领域授权测试、
  P1 创建测试和 Web 40 文件/299 项通过；
 仍未证明同一正式安装包上的真实模型、文件、shell、构建、测试、网络、重启和
  Verification/Acceptance 全链路。

## 当前验证结论

- 2026-11-16 晚间真实命令增量：`c283c8709076` 预览包已从普通安装、真实模型和
  浏览器工作区授权走到实际文件修改。持久输出证明初始 `npm test` 因 `-1 !== 5`
  失败；patch 后 `npm run build`、`npm test` 及访问 `https://example.com` 均 exit 0。
  **完整任务仍未交付**：独立验证器能读文件，但其执行绑定未接入命令沙箱，重复
  等待后触发保护停止，没有 Verification 结论或人工 Acceptance。随后发现其停止
  记录令项目关注事项读取返回 503；读取修复已在 `0eb639331a31` 新包、同一可丢弃
  验收数据库上通过公开浏览器恢复核验，未修数据库。补充指导后等待旧版验证的问题
  已按 P8 现有合同修复并通过 23 项定向检查；`06193bb2acc3` 包公开浏览器
  Steer 已使 revision 5→6，产生新执行与命令审批。三个包的证据不得合并为同包
  完整交付；详情见
  `docs/verification/2026-11-16-installed-workspace-command.md` 和 KP-017。

- 2026-11-16 负责人已接受独立验证的临时副本方案；DID 1.67 和 P8/P4/P12
  所属补充已按原提案逐字落地并复核。已实现 Linux 项目输入捕获/清理组件，
  实际未提交文件、内部链接、副本独立写入、越界链接/socket 拒绝、源变化及取消
  清理共 9 项通过；与恢复修复合批 4 文件/45 项通过，当前根 typecheck 通过。
  **尚未接入验证器命令调用链、持久策略或实际挂载资格，不等于独立命令验证可用。**
  决定与实现边界见 `docs/decisions/2026-11-16-independent-verification-command-environment.md`
  及 `docs/verification/2026-11-16-verification-input-copy.md`。
- 最新完整 `pnpm check` 在核心第 15/51 批失败：P14 工具目录断言遗漏已接入的
  `allocate_workspace_sandbox`。已修正并定向 2/2 通过；该完整批次未继续到 Web，
  不宣称完整绿色。此后 typecheck 和 lint 单独通过；新增副本组件之后仍须完整门禁。
- 当前精确命令审批隐藏 command/cwd，却提供批准按钮，无法仅凭该页面判断实际
  动作。真实浏览器证据和代码原因已确认，列为 KP-018；未把当前审批体验记作可审查。

- 2026-11-16 独立验证环境准备增量：已接入 canonical Verification/Execution/Work
  读取、完整当前 Workspace 授权链、现有边界生产和当前主机来源；准备前后复查，
  再用原输入内容/元数据和当前来源重验旧副本。成功 Scope 结束、部分失败和正在
  复制时停止均有清理路径；旧修订或撤权不能继续使用旧材料。准备/副本/Binder
  合批 31 项通过，typecheck 与 lint 通过。新准备组件尚未注册进普通 daemon，
  独立验证专用策略持久化、实际挂载资格、P4 命令接线与同包验收仍未完成；
  见 `docs/verification/2026-11-16-verification-input-copy.md` 的补充。
- 2026-11-24 默认 Workspace 能力实现增量：系统初始化基线已接入创建 Project/Child
  Workspace 的生产命令路径；领域、初始化端口、Child ceiling 和创建命令回执测试
  通过。此结果只证明源码链路和持久化合同的定向实现，不替代 Linux 安装资格、
  真实 Provider 或发布级功能验收。

以下同日记录为较早检查点，以本节最新增量为准。

- 2026-11-16 安装包增量：Parent 模型分配入口已实现；真实 SQLite 集成证明人工
  撤权后新 Parent 动作仍被拒绝，只有用户显式恢复后才能再次分配；旧成功回执
  的重放不会重新授予权限。控制可见性、解码、授权、执行等待和 Linux 准备合批
  48 项通过、2 项 Windows 跳过。普通新安装包完成真实首装、模型配置、自动重载、
  中文/空格目录及浏览器执行环境授权，但随后内部绑定命令编号不合法导致服务退出，
  构建/测试没有通过；随后发现 Provider 失败后的 readmission hold 会错误终止
  daemon，已修复为保持服务可用并等待新的 Work 修订。已修复编号生成和调度阻塞；
  新包复验仍进行中；上一包的真实 npm test 审批后又发现 qualification evidence
  与当前主机 probe 指纹被错误要求相等，已修复为分开校验。不能把安装或授权成功
  记为命令交付成功，证据见 `docs/verification/2026-11-16-installed-workspace-command.md`。

- 2026-11-16 当前生产接入：runtime 已推进为 schema57；离线副本升级器、签名、
  manifest、维护终态及测试工厂已同步。生产注册持久工作区授权/撤销与内部策略绑定，
  在恢复策略门和 shell 调用前生成精确执行快照；现代策略使用时复查当前来源链。
  普通 Web 的“工作区执行环境授权”使用一个本机用户，默认持续有效，可撤销；
  内部 Parent 来源不会接受外部伪造。授权、重开、撤销和用户恢复的生产 Layer 路径
  及编解码合批 63/63 通过，升级/启动/Binder 合批 52 通过、6 既有跳过。
  **完整文件/命令/网络撤权、模型实际分配、安装包真实构建测试及发布验收仍开放**。
  当前集中检查和已发现失败见
  `docs/verification/2026-11-16-workspace-production-integration.md`。

- 持久工具能力仍独立于隔离执行环境：`GrantPermission` schema2 已接通精确
  Workspace 的 `fs:write`/`shell:exec`；具体敏感动作审批仍单独处理。不能把新沙箱
  授权的撤销结论扩大为所有文件或联网工具已经完成统一撤权验收。Parent/Child 的
  当前来源与“用户撤销只能由用户解除”已有领域/Gateway/SQLite 资格；模型
  `allocate_workspace_sandbox` 已接通直接 Child 分配、当前来源检查和历史回执重放。
  真实模型分配及并行工作区旅程仍需验收。

以下是之前的检查点；当前生产接入状态以上述增量为准。

- 2026-11-16 schema 56 增量：离线操作器及新兼容边界 21 项通过、6 项既有跳过，
  包含新建、复制升级、只读复核和并发续跑。修复版本摘要及 P39 维护终态仍停留
  在 55 的缺陷；受影响历史迁移的三个失败文件修正后 8/8 通过。新版本独立安装包
  和完整真实模型命令任务仍未验收，详见 `docs/verification/2026-11-16-schema56-compatibility.md`。

- 2026-11-19 新增安装包内 `reinstall-environment`：当 Arbor/provider 升级导致旧
  sandbox authority 的 provider version 不匹配时，用户可显式重新执行 22 项控制并
  发布当前 authority；旧 authority 会以带时间戳的可恢复目录保留，发布失败会恢复
  旧目录。首次安装 `install-environment` 仍拒绝覆盖已有 authority。

- 2026-11-16 新增安装包内 `check-environment` / `install-environment`：前者只检查，
  后者实际执行 22 项控制并核对规范证据，使用受保护的同盘暂存与整体发布，保留
  既有材料并支持安装锁失效恢复。实测发现并修复内存上限仍可无限使用 swap 的
  问题；最新包在独立 ext4 用户目录完成 22/22 及首装，包内 doctor exit 0，
  确认 Linux 环境可用；重复安装保留原材料，18 个记录单元无残留进程。详情及失败见
  `docs/verification/2026-11-16-linux-environment-install.md`。这不完成 schema、
  普通真实模型命令或双 Workspace 验收。

- 2026-11-16 普通 Linux 装配复查：V2 已使用 IPv4 CONNECT 候选，不依赖旧 V1
  的 DNS64/Pref64；安装产物完整文件校验已接入生产，doctor 与 admission 共用
  完整 probe。当前设计文件头为 Scenarios 1.11 / SD 1.26 / DID 1.66，含 V2
  supplement，但配套 proposal manifest 仍标为 PREPARED_NOT_ACCEPTED，接受及
  landing 审计尚待核对。源码 runtime 已推进为 schema 56，新增不改表结构或历史
  JSON 的兼容边界；离线工具、manifest 和测试工厂已接入，集中升级验证已通过，
  安装包资格待补，旧 schema 55 包不能代替新版本验收。本机默认目录仍未安装材料，独立首装目录的实际 Supported 结果见
  上述新检查记录，普通命令任务尚未验收。此前预览包完整文件
  检查通过，GitHub CONNECT 仍失败；详见
  `docs/verification/2026-11-16-installed-linux-artifacts.md`。
- 2026-11-16，完整功能批次终止为失败：268 通过、1 失败、1 跳过，浏览器阶段
  未运行。失败接管场景已补 fixture 写锁等待并按现行 P40 持久 Observation
  合同修正旧断言，定向 1/1 通过；最新源码没有完整发布功能通过结论。
- 2026-11-15，文件运行链路对越界写入的断言已按 P4 资源准入合同对齐为 `Denied(ResourceResolutionDenied)`，真实运行链路 6/6 通过。随后一次完整 `pnpm check` exit 0（核心 492 文件、50 批全部完成；架构 198、Web 294），但该结果早于后续人工指导唤醒修复。完整功能批次在 AH19 首个长流程中失败，追查到任务等待人工输入后，SteerWork 虽提交却没有解除 Manual 等待；已改用既有 HumanIntervention 唤醒机制，并通过同事务读取 Inbox 消费状态防止重复命令误唤醒后续等待。之后当前工作树再次完成 `pnpm check`：lint 1499 文件、架构 198/198、核心 493 文件、Web 39 文件/294 项、根/Web typecheck 和 production build 均通过；这仍不包含完整 `pnpm test:functional`、package/clean-checkout 和真实 Provider 发布资格。人工指导修复的定向结果及限制见 `docs/verification/2026-11-15-human-steer-wake.md`。
- 2026-11-15，真实模型复验发现权限拒绝后偶尔选择普通 `Yielded`，用户看不到可操作阻断；现已将 BaseLoop asset 更新为 v3，并在 Work completion protocol 中明确可由用户处理的权限/资源/终端能力拒绝必须使用 `wait(disposition: Blocked)`。同一新预览包已完成对齐后的真实文件型 coding 旅程：拒绝、可见阻断、重启保留、浏览器授权、实际写入、独立 Verification、人工验收和完成后重启读取均通过，页面无错误。第一次复验的失败由验收脚本内容标准冲突造成，已保留记录并通过对齐输入复验。详情见 `docs/verification/2026-11-15-blocked-prompt-recovery.md`。
- 2026-11-15，使用字体修复后的同一 source-free Linux x64 预览包完成真实模型文件型 coding 旅程：首次配置、自动重载、真实项目、文件读取/写入阻断、重启恢复、限时授权、补充指导、独立验证、人工验收和完成后重启读取均通过，页面无错误。证据见 `docs/verification/2026-11-15-final-package-coding-journey.md`。该证据不包含 shell、构建或测试执行，也不改变预览包未达到正式发布资格的结论。
- 2026-11-14 发布基础修复：Blob 新写入已改为数据库旁的持久目录，读旧临时内容时校验并复制；HTTP/WS 增加 Host/Origin 校验，真实 Chromium 已证明本机 WS 成功、其他来源 WS 被拒绝。启动器增加构建指纹、运行实例核验和 Linux PID 复用保护。相关后端 10 文件 / 51 项、启动器 4 项通过；不等同于完整发布验收。
- 首次模型配置已按负责人确认的流程落地：配置前 HTTP/WS 拒绝业务工作，提交时对 OpenAI-compatible `chat/completions` 做真实连接检查，凭据只写入本机私有文件，成功后自动重载 daemon。Web 38 文件 / 292 项通过；本地隔离 Provider 已验证配置前 503、连接成功、重载后 `instanceId` 变化、配置生效和 API 解锁。独立 Linux x64 预览包已通过外部真实模型 `gpt-6.1-sol` 的浏览器配置、自动重载、真实助手回复和重启历史读取，证据见 `.test-results/real-install-fixed-20261114/result.json`。首次文件任务暴露正式装配缺少阻塞及恢复链路；修复后的独立安装包已用真实模型从拒绝、浏览器限时授权到修改、独立验证、人工验收和重启完整通过。包含命令的编程任务仍未通过，详见 KP-012 和 KP-003。首次配置方案及落点见 `docs/decisions/2026-11-14-first-run-model-setup.md`。

- 2026-11-12，运行中目录选择的浏览器完整旅程通过：输入/浏览中文及空格目录，保留已有文件，通过所选目录的文件读取和独立验证，不重启创建第二个目录项目，再选原目录直接打开原项目，重启后两条路径及项目仍在。该旅程使用隔离的脚本 Provider；不把它扩大为真实模型的新一轮发布资格。精确合同见 DID §4.1D 和 `docs/decisions/2026-11-11-project-directory-selection.md`。
- 本次目录接入验证：相关后端 22 项、Web 36 个文件 / 289 项、目录相关浏览器三条旅程通过。该次记录的架构门禁为 197 项；当前工作树的架构门禁已推进到 38 个文件 / 198 项通过。完整 `pnpm check` 在核心第 7/48 批主动中止，不是完整通过记录。已用受影响后端及完整 Web 回归核验本次接入。同一构建已在本机 18787 服务启用，只读浏览器确认目录控件和已有项目操作可用，原项目及 schema 55 保留。记录位于 `.test-results/project-directory-research-20261111/`。
- 2026-11-11，按实际用户操作复验：本机已接入用户授权复用的 Codex 模型服务 `codex/gpt-5.6-sol`。普通 production 的真实对话、浏览器消息和刷新历史，以及真实模型文件目标、审批、创建文件、独立验证、验收和重启读取通过。真实 S2 普通纠错、关键纠错和停止 3/3 通过；真实 S3 父子协作、子工作区写入授权、越界拒绝、交付唤醒、子独立验证/Parent 接收、父独立验证/最终验收通过；本次未触发逐次可执行写入审批。真实 S4-A 在响应 headers 修正后重新通过，S4-B 属于普通 production 明确禁用的进程能力。公开流程定向 5/5、恢复/拒绝/交付等 13/13、浏览器 7/7 通过。首次启动器的新目录初始化、`ARBOR_DB`、状态、停止、重启及旧库不自动升级均已实测。完整 `pnpm check` exit 0：架构 197 项、核心 479 个文件、Web 279 项通过；后续小改动另补 lint/typecheck。完整发布功能套件尚未重跑。证据见 `docs/USER_JOURNEY_ACCEPTANCE.md`。
- 2026-11-14，当前首次模型配置流程的架构门禁为 38 个文件 / 198 项通过；自动重载生命周期先在隔离本地 OpenAI-compatible Provider 上通过，随后在独立安装包与外部真实模型上通过；后者也验证了真实助手回复及重启历史。文件型 coding 旅程已在 2026-11-15 的最终字体包上重新通过；仍尚未证明包含命令、构建和测试的 coding 任务已交付。
- 2026-11-09，当前工作树曾完整执行 `pnpm check` 并以 exit 0 结束：Biome 检查 1453 个文件，TypeScript 检查通过，架构测试 38 个文件 / 197 项通过，核心测试 479 个文件全部通过，Web production build 成功，Web 测试 34 个文件 / 278 项通过。之后首次模型配置和 Native 候选实现继续增加门禁；完整 `pnpm check` 需在本轮变更稳定后重新取得同基线结果。
- 2026-11-14，已处理对话响应 admission 的中间崩溃边界：生产 admission 在同一事务中写入 Execution、Attempt 和 Running Job；对旧的 Active Execution + Queued Job + 缺失 Attempt 半状态，启动/周期恢复会结束旧 Execution、写入 `AdmissionInterrupted` Attempt 并将 Job 置为 `NeedsAttention`。用户可以点击“再次尝试”，系统通过 `ResumeConversationResponse` 创建新的 Attempt/Execution，不复用旧身份。schema 55 可丢弃夹具、P17 命令/runtime、Web 对话页定向验证通过。
- Web 已按路由拆分页面；本次 production build 的入口 JavaScript chunk 为 487.09 kB，CSS 为 47.39 kB，无默认 chunk-size warning。共享 preload 和异步页面仍另外加载，这不是首屏总传输量或加载耗时测量；KP-008 的原始单 chunk 警告已修复。
- Web UI 的全部现有页面、表单、读模型视图和错误/连接提示已迁移到 Tailwind utilities；项目内 shadcn 风格原语覆盖 Button、Input、Textarea、Card、Badge、Dialog、DropdownMenu、Tabs。Sheet、移动端“更多”和分工标签页分别使用 Radix Dialog、DropdownMenu、Tabs。运行时不再导入旧 CSS Modules 和五份全局组件样式，仍保留 Arbor reset、tokens 和 reduced-motion 规则。组件生成配置位于 `apps/web/components.json`；具体范围见 `docs/decisions/2026-11-14-frontend-ui-stack.md`。
- 2026-11-14 前端迁移最终验证：完整浏览器 11/11、Web 37 个文件 / 289 项、架构 197 项、相关 P17 6 项、根/Web typecheck、lint 和 production build 通过。浏览器覆盖 1440/768/390 宽度、分栏、弹窗焦点、菜单/标签键盘、自由选目录、聊天/审批/验收/重启与路由隔离；未重跑完整核心/崩溃/真实 Provider 发布矩阵。记录见 `docs/decisions/2026-11-14-frontend-ui-migration-result.md`。
- 2026-11-09 的设计合并恢复记录当时所依据的是 Problem & Goals v1.3、Scenarios v1.10、System Design v1.25、DID v1.65；它是该历史检查点的基线，不是当前设计版本。当前冻结链已推进到 Problem & Goals v1.4、Scenarios v1.12、System Design v1.27、DID v1.68，并保留 P36–P41 已接受增量。恢复过程见 `planning/results/design-merge-regression-recovery20261109.result.md`。
- 2026-10-29 的发布候选曾完成 S1、S2、S3、S4-A 真实 Provider 旅程，以及完整功能和浏览器覆盖。
- 当前 `e7065a7c` 是后续治理分支和功能分支的整合提交，并继续引入 schema 55 等变化；当前整合头尚没有一份新的、同源码基线的完整 `pnpm test:functional` 和真实 Provider 发布资格记录。

2026-11-14 文件闭环的独立安装包真实模型证据见 `docs/verification/2026-11-14-linux-install-real-model.md`；工作详情现提供当前分工限时文件授权，授权与新指导仍是两次明确操作。MIT 已由负责人确认并加入仓库及新打包器。

因此，当前已有本轮真实模型主流程通过记录，以及较早工作树的完整实现门禁记录；最新工作树仍需整体验证，当前整合头也仍需重新完成发布级功能资格。

## 已真正可用的功能

以下功能在当前源码中有生产路径、公开 API、Web 界面和自动化验证。

### Project 与资源

- 输入或浏览服务所在机器的目录，打开已有文件夹或在已有父目录下新建最后一级文件夹并创建 Project；
- 项目名称可修改，默认取目录名称；再次选择已绑定的真实目录会打开原 Project；
- 代码仍保留“暂不绑定文件夹”的 ConversationOnly Project 和旧启动预设 Profile 兼容路径；这不是首发产品流程，首发必须以真实项目目录和真实 Provider 为工作前提；
- 项目列表、项目切换、重命名和归档；
- 首页与项目中心共用已有项目列表，显示持久绑定路径，支持名称/路径搜索、路径复制、更新时间展示、打开工作台、继续根对话、进入所选项目管理及查看归档历史；归档仍需在设置页确认；
- 根 Workspace、责任树和资源来源持久化；
- schema 57 全新数据库创建和严格启动版本检查（离线集中验证和独立安装已通过，
  完整真实模型任务尚受 KP-017 阻断）。

普通生产入口已装配 host 目录准入，运行中选择不同路径不需要改 `ARBOR_PROJECT_ROOT` 或重启。目录指向服务所在机器，不是浏览器上传的文件夹。准入记录存于 `<数据库绝对文件名>.project-directories`，启动加载，运行时仅追加；当前源码业务数据库 schema 为 57，原目录接入不需要 DDL 变更。旧的程序化 composition 未显式装配目录服务时继续提供预设选择界面。OpenCode 调研和落地范围见 `docs/research/2026-11-11-project-directory-selection.md`。

### Parent/Child：通信区域与资源执行边界分开

当前 P6/P7 的产品语义是独立 Child Workspace：Child 拥有自己的责任、Primary
Session、Work、Context、Inbox、Verification 和 Acceptance；Parent 通过 Assign、
Message、Deliverable、Dependency 和治理路径与 Child 协作。Child 结果不会直接
写入 Parent Session。这个通信/责任模型与目标一致。

当前 S3 资源所有权实现另有一层 Parent `allow` 加 `exclusions` 的 carve-out
模型：它只描述物理写入资源如何准入，不应被理解为 Child 是 Parent Session 或
责任区域中抠出来的一块。设计已经进一步明确：允许明确的只读共享和受控写入，
结果通过可追溯交付/接收回到 Parent，不能静默覆盖对方文件。当前尚缺同一源码/发行物
上的并行工作区、联网构建测试、服务生命周期及停止/重启完整验收，不能把 carve-out
定向测试结果扩大为完整 Child coding 旅程已经交付。核对记录见
`docs/proposals/2026-11-15-independent-child-resource-areas.md`。

主要实现：

- `apps/single-workspace/src/project-resource-profiles.ts`
- `apps/single-workspace/src/project-directories.ts`
- `packages/application/src/commands/create-project.ts`
- `apps/single-workspace/src/transport/server.ts`
- `apps/web/src/commands/forms/CreateProjectForm.tsx`
- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/components/ProjectDirectoryList.tsx`
- `apps/web/src/pages/bootstrap/BootstrapPage.tsx`

### 对话、Work 与执行

- 根 Workspace 对话和持久 transcript；
- 从目标创建/分配 Work；
- Current Work、Work Detail、历史完成 Work 和进度展示；
- Agent Loop、Provider 调用、控制动作和工具动作；
- Work 修订、普通/关键纠错和停止执行；
- Provider 绑定、失败分类、重试和重启恢复。

主要实现：

- `packages/agent-runtime/**`
- `packages/execution-runtime/**`
- `packages/provider-runtime/**`
- `packages/application/src/commands/assign-work.ts`
- `packages/application/src/commands/steer-work.ts`
- `apps/web/src/pages/workspace/**`
- `apps/web/src/pages/work/**`

### 审批、权限与安全边界

- 控制动作审批和可执行动作审批是两个独立流程；
- PermissionGrant 绑定主体、能力、目标和有效期；
- 项目级待处理队列支持批准、拒绝和过期/失效反馈；
- 外部 Command 在进入 Application 前进行严格结构、ID、actor 和 origin 校验；
- 资源所有权、当前 Work revision、Execution generation 和动作 identity 参与授权与 fencing。

主要实现：

- `packages/application/src/authority-resolver.ts`
- `packages/application/src/commands/grant-permission.ts`
- `apps/single-workspace/src/control-action-authorizer.ts`
- `packages/tool-runtime/src/approval.ts`
- `apps/web/src/pages/queue/QueuePage.tsx`

### Verification、Acceptance 与交付

- 独立 Verification 的启动、证据记录、三值结论和重试；
- Verification Pass 后仍保持 Work Open，直到 Parent 或用户 Acceptance；
- Child Work 结果由 Parent 显式接收；
- Deliverable、Delivery、Dependency 声明、满足和确定性唤醒；
- 完成后 Work Detail 可继续查看。

主要实现：

- `packages/application/src/commands/start-verification.ts`
- `packages/application/src/commands/conclude-verification.ts`
- `packages/application/src/commands/accept-complete.ts`
- `packages/application/src/dependency-coordinator.ts`
- `packages/application/src/commands/produce-deliverable.ts`
- `packages/application/src/commands/deliver-command.ts`

### 观察和恢复

- Workbench、责任树、Workspace、Work Detail、待处理、Attention、Usage、Settings；
- SQLite 持久化、Command receipt 重放、Execution lease/fencing；
- Provider 成功或失败、动作效果、审批消费、验证和会话的崩溃恢复；
- 投影重建、Watermark、Attention 去重和重启后继续。

主要实现：

- `packages/projection-runtime/**`
- `adapters/persistence-sqlite/**`
- `apps/single-workspace/src/production.ts`
- `apps/single-workspace/src/composition.ts`
- `apps/web/src/pages/**`

## 半成品或受限功能

### Native OS 进程执行

2026-11-16 安装接线增量：V2 现已在 production admission 读取安装产物的完整文件
字节，固定并校验实际 bwrap/setpriv/systemd 路径；过滤规则内嵌执行器，V2 直接
挂载被校验的固定 relay。`arbor doctor` 与生产复用完整 probe，不再仅凭 registry
存在就报告就绪。所需审计源码和 relay 已加入包清单；这仍未生成 Supported 材料，
也没有完成首次安装资格流程。范围及失败记录见
`docs/verification/2026-11-16-installed-linux-artifacts.md`。

Native POSIX 和 Windows adapter、策略、持久化和测试代码已经存在。Linux
POSIX adapter 已实现 systemd 用户单元 + bubblewrap 的真实执行候选，并有
本机定向隔离验证；普通 production composition 现在从用户级受信 authority
registry 读取当前 Linux 的 Supported tuple，缺失、漂移或证据不匹配时仍为
`false`。当前未签发精确资格 tuple 时，实际运行仍是 `Disabled`，
`NativeOsSupportedOnly` 也会在 spawn 前 fail-closed；这不是合格 Linux 首发的目标默认。
资格通过后的目标默认是 `NativeOsSupportedOnly`，并由 Workspace 初始化建立
`WorkspaceWrite × Enabled` 基础能力。

结论：安全拒绝路径可用；生产级本机进程执行尚不可作为已支持能力发布。它是 Linux coding agent 首发的 P0 实现缺口，不能继续按“对话模式可接受”处理。

负责人已澄清必须严格隔离并联网，不能将断网或无隔离候选当成交付。
当前候选通过每次执行的 Unix socket、沙箱内本地 TCP 字节转发及标准 HTTP CONNECT
连接公网 HTTPS，保留 `--unshare-net`。没有绑定 broker 时 Restricted/Enabled 仍返回
`NetworkBrokerUnavailable`；Linux probe 已能读取受信 registry，但当前用户环境没有
已安装的 Linux Supported 资格材料，因此普通 production 仍不可达。

2026-11-15 真实 systemd+bwrap 候选已通过 curl 公网请求、Git 协议 v2 查询（含
`POST /git-upload-pack`）、npm 下载安装 `is-number@7.0.0` 及使用该依赖的项目测试，
直接公网 IP 连接被拒绝。该实验显式注入测试 capability、IPv4 解析和 Pref64 正向
已知答案，不能替代 production discovery 或安装包验收。独立流式用例覆盖分段
chunked POST、响应头/响应体、Host/SNI 绑定及 broker 取消关闭。

同一真实 harness 在当前 Debian 主机上使用实际 production broker、实际
systemd+bubblewrap 和 `https://example.com/` 重跑时，workspace 写入通过，但
公网请求被 broker 以 403 拒绝；失败来自当前 V1 通道没有可用 Pref64/DNS64 资格，
不是 bubblewrap、namespace、cgroup 或 seccomp 前置条件缺失。该结果进一步证明
当前主机不能签发 V1 Linux Supported row；不能把测试时注入的 Pref64 或 capability
扩大为 production 资格。

HTTP/TLS 解析和流转复用 Node 标准库，证书签发复用 `@peculiar/x509`/WebCrypto；
私钥只在宿主内存，沙箱只挂载临时公证书，不修改宿主 trust。该 TLS 解密候选按旧
冻结合同试验，不表示新产品要求必须解密。旧 GET-only socket 候选保留为实验测试。

本轮网络核心五文件 151/151、功能定向两文件 14/14、根 typecheck、架构 198 项通过；
不是完整 release 批次。真实 discovery 的 NoDns64 负证明、代理的跨连接重定向次数、
全部 DoH/隧道语义、共享服务生命周期、并行工作区及普通安装包资格仍待完成或合同
对齐。实际 ENODATA 未伪装成可信证明。细节见
`docs/verification/2026-11-15-standard-network-proxy.md`。

2026-11-15 负责人澄清：严格隔离首先防止工作区互相任意访问和串扰，安全可以
不用那么苛刻。新工程方向以多工作区资源/进程/服务归属及正常联网开发为主，
不把所有高级网络审查作为首发前提。当前生产拒绝仍是事实。当前设计文件已含
V2 supplement，源码也含 V2 候选，但配套 proposal manifest 仍为
PREPARED_NOT_ACCEPTED；接受/landing 审计记录尚待核验，不能据此宣布支持。见
`docs/decisions/2026-11-15-workspace-isolation-priority.md`。

2026-11-16 实机复核和修复：生产 host probe 确认本机 namespace/cgroup/seccomp
前置条件具备，缺少已打开 broker 时仅 networkBrokerChannel 不可用；先前不带
runner 的低层 probe 不能当作宿主检测。实际 bwrap 计划曾允许连接只读/可写项目
挂载内的宿主 Unix socket，现已接入 libseccomp 生成的命令过滤、只读 proc 和
嵌套 namespace 限制。真实回归确认 socket 被拒绝、子进程继承限制、内部 TCP
正常、真实 V2 HTTPS 返回 200。命令自身的 pathname Unix socket 同样受限；
任意依赖此类 socket 的工具链尚未资格验证。完整 Git 场景在 Git 阶段以约 10 秒的
CONNECT 504 失败；独立 npm 安装和 C 编译候选已通过，
宿主直连 GitHub 也超时，现有本地代理请求则出现 TLS EOF，原因尚未确定。
修复不生成 Supported 材料，普通命令执行仍未交付。详见
`docs/verification/2026-11-16-native-command-isolation.md`。

### 保留用户数据库升级

当前源码 Runtime 精确要求 schema 57。离线工具已接入从 schema 36–38 和 44–57 创建或续跑独立副本，默认集中验证已通过，未展开 exhaustive 矩阵；文档和代码只把它用于可丢弃资格夹具。没有已支持的在线升级，也没有保留用户数据的发布承诺。

结论：源码全新数据库路径已接入 schema 57，安装包资格待补；保留用户数据库升级未交付。schema 是内部数据库格式，不是要求用户理解或手工操作的产品概念；公开首发前必须由安装器和升级器自动处理受支持旧版本，并提供备份与失败恢复。

### 对话响应 admission 的中间崩溃恢复

对话响应的正常链路可以提交消息、建立 Execution、调用 Provider、保存响应并在重启后处理已完成或已失败的 Execution。生产 admission 已把 Execution、Attempt 和 Running Job 放入同一事务；对历史半状态，恢复会安全结束旧 Execution 并把消息置为 `NeedsAttention`，页面允许用户再次尝试。再次尝试会使用新的 Attempt/Execution，避免重复使用不确定的旧响应身份。

结论：正常对话链路和该 admission 中断恢复边界可用；用户可见恢复规则见 `docs/decisions/2026-11-14-conversation-response-resend.md`。

### 多用户和远程可见性

传输层可以替换 Authenticator，也支持静态 token 和 Basic gate，但 `/projects` 与 `/project-resources` 的跨项目 bootstrap 读取仍按本机单主体设计。源码明确要求多主体部署提供后续可见性 resolver。

结论：本机单用户是首发产品边界；多租户/多主体产品未完成，也不属于当前发布目标。

### 可安装发行物

当前工作树仍是源码开发形态：`package.json` 仍为私有的 `0.0.0` 包，`npm pack` 会带入大量源码和测试且不包含可独立运行的发布 `dist`，`pnpm test:package` 还依赖本机离线 store。当前没有正式发行物。已增加本地 Linux x64 预览打包器，包含 Node、production 依赖和 Web；独立安装目录的初始化、首次配置本地重载、文件型真实 coding 旅程和普通重启已实测，外部真实模型首次配置和对话也已通过；命令执行、构建、测试和升级仍未完成，不能公开宣称可发布。

2026-11-16 用最新源码重新构建并解压验证了 preview archive：`bin/arbor --version`
和 `doctor` 均可运行，doctor 能发现模型配置并明确报告 Linux 隔离进程资格未安装，
因此不会误导用户以为依赖安装、构建和测试已经可用。该包仍为
`releaseQualified: false`；SHA-256 为
`b14e597467f074cd1b84602601e80e1572f11c0a0126f1b58ffd43a7043e2910`，文件位于
`.test-results/repaired-preview-20261116/arbor-0.0.0-preview-d47111f5041f-7166d262-linux-x64.tar.gz`。
详见 `docs/RELEASE_PROGRESS.md`。

结论：安装包、用户数据目录、首次启动、模型配置和升级路径是发布 P0，不能把源码能启动等同于项目可发布。

### 持久 Blob 数据

Blob 是模型上下文、验证摘要、消息附件、Artifact 等较大的持久内容，数据库中的业务记录通过引用关联它们。当前 production 默认使用 `<数据库绝对路径>.blobs`，显式 `blobRoot` 同时供内容存储和 retention 使用。写入采用私有临时文件、文件同步、原子 rename 和目录同步；读取校验所有者、普通文件和内容摘要。旧临时目录只作为按需兼容导入源，已被系统删除的旧内容不能恢复。

Linux 普通安装现已增加 `arbor backup --to`、`arbor verify-backup --from` 和
`arbor restore --from … --data-dir …`。它们复用 SQLite 官方备份 API、既有 P39
维护锁和恢复租约重整函数；同时处理数据库、内容文件和项目目录登记，恢复只接受
新目录，未完成的恢复会阻止普通启动。历史附件、验证回执和摘要中已识别的内容引用
会核对完整性，仍存在的旧临时内容只按引用复制。操作说明见 `docs/BACKUP_RESTORE.md`。

结论：已补手动联合备份/校验/恢复入口，定向验证见
`docs/verification/2026-11-15-user-data-backup.md`。自动备份、设置页入口、缺失内容的
用户恢复界面和完整历史搬迁仍未交付；项目源码、模型凭据和外置沙箱授权/审计需单独
保留。符号环境快照只报告引用标记数量，不冒充内容字节。此功能不是数据库升级承诺，
也不替代最终同基线发布资格。只备份 SQLite 仍不足以恢复内容。

### 安装包界面字体

Web 发布物内置 Noto Sans SC 的开源字体子集，静态服务同时提供 `/fonts/` 文件资源；
这是为了让缺少中文系统字体的 Linux 安装仍能正常阅读界面。字体文件和 OFL-1.1
来源清单在 `apps/web/public/fonts/noto-sans-sc/`。独立安装包浏览器检查已确认 CSS
和字体可加载、中文截图正常；系统字体覆盖仍作为回退。

### 当前整合头的发布资格

历史 release candidate 有完整旅程证据，但当前整合头包含后续 schema、恢复、测试和 Web 合并。`pnpm check` 不包含完整公开进程、浏览器重启和真实 Provider 旅程。

结论：当前代码可继续开发和验证，但发布前必须重新跑当前头的发布级功能门禁。

## 假实现、mock、硬编码和绕过逻辑

### 明确的测试或开发替身

- `adapters/provider-fake`：测试和开发替身，不访问网络；不得作为普通 production 的默认模型。
- `adapters/environment-local`：标注为 TEST-ONLY fake；production 使用 `environment-resolver-local`。
- `packages/testkit` 和 `tests/functional/support/**`：测试 harness、脚本 Provider、进程崩溃探针和夹具。
- `testOnlyAllowTrustedLocalProcessExecution`：只为功能测试打开 TrustedLocal 进程路径，普通启动不启用。

### 当前 production 的固定边界

- 未配置 Authenticator 时，所有本机 loopback 请求都映射为 `user:local`。
- production composition 不再硬编码该布尔值；它只在默认用户级 authority registry
  含有当前 Linux、精确 provider/version/capability/OS build、规则摘要和 evidence
  的 Supported 行时开放 catalog。当前环境缺少该材料，所以实际仍为不可用。
- daemon / 前台入口的默认数据库路径是 `./arbor-slice.db`，默认监听 `127.0.0.1`。后台 `scripts/start-user.mjs` 使用 `ARBOR_DB`，或由 `--data-dir` 指定的目录；未指定时使用本机数据目录下的 `Arbor/data/arbor.db`，缺失数据库通过独立离线 `fresh` 初始化。
- 当前仍存在未配置真实 Provider 时进入 `model-fake` / `provider-fake` 的路径；这与首发要求冲突，必须改为配置引导和明确错误状态。
- 本机用户通过专用 host 接口确认目录；CreateProject 仍只接收稳定引用，事务中不执行文件系统 I/O。兼容的预设列表仍不包含路径。

这些固定值有明确安全边界，但其中一部分是首发 composition 限制，而不是长期产品终态。

## 真实调用链

### 人工 Command：UI 到数据库

```text
React form
→ apps/web command transport
→ POST /commands
→ Web transport server / HTTP shell
→ Authenticator
→ strict external command decoder
→ CommandHandlerRegistry
→ CommandGateway
→ Application command handler
→ Domain validation / transition
→ Port repository transaction
→ SQLite adapter
→ Command receipt + domain event + projection input
```

关键入口：

- `apps/web/src/commands/**`
- `apps/single-workspace/src/transport/server.ts`
- `apps/single-workspace/src/transport/http.ts`
- `apps/single-workspace/src/transport/composition.ts`
- `packages/application/src/external-command-codec.ts`
- `packages/application/src/gateway.ts`
- `apps/single-workspace/src/registry.ts`

### Query：数据库到 UI

```text
React Query
→ POST /views/:view
→ sensitive-read authentication
→ ProjectionQueryPort
→ projection-runtime
→ SQLite read models / authoritative repositories
→ frozen api-contracts DTO
→ Web view/page
```

关键入口：

- `apps/web/src/api/transport.ts`
- `apps/single-workspace/src/projection-query.ts`
- `packages/projection-runtime/**`
- `packages/api-contracts/**`

### Agent 执行：Work 到动作和结果

```text
Scheduler finds runnable Episode
→ execution-runtime acquires fenced lease
→ agent-runtime builds current step/context
→ model-context creates bounded provider request
→ provider-runtime calls selected adapter
→ model output decodes to typed ActionCall
→ control action or tool-runtime route
→ authority / approval / sandbox / effect settlement
→ Observation appended to the same durable step
→ independent Verification
→ Parent or human Acceptance
→ Work completion and projections
```

## 事实上的核心模块

### 当前包组织的真实状态

- workspace 共 28 个 package；声明的 package DAG 没有循环，运行时代码扫描也没有模块循环。
- 复杂度没有平均分布：`agent-runtime`、`application`、`persistence-sqlite` 和
  `single-workspace` 承担了绝大多数实现；其中 `control-actions.ts`、
  `model-decision.ts` 和 `tool-runtime/src/runtime.ts` 都是数千行级文件。
- `adapters/environment-local` 明确是 TEST-ONLY，`provider-fake`/`provider-testecho`
  是确定性测试协议适配器；它们存在于 workspace 不等于普通生产会自动使用 fake。
  但 fake 注册表仍被入口应用静态编译，发布物边界因此没有完全收窄。
- 类型导入仍有三组循环，集中在 ports/application 合同；这不构成运行时循环，
  但会放大接口修改的编译和审查范围。
- 已将验证输入副本实现移入 `adapters/sandbox-local`；`single-workspace` 继续拥有
  `verification-command-environment.ts`，因为它读取 Application/authority/Work/Verification
  事实并负责编排。该整理不改变功能语义，也没有把独立验证误报成已交付。

1. `packages/domain`：合法状态、标识和不变量。
2. `packages/application`：Command、授权、事务边界、Verification、依赖和消费者。
3. `packages/agent-runtime`：Agent Loop、Action、Observation、Context 和恢复。
4. `packages/execution-runtime`：调度、租约、fencing、停止和 Execution 恢复。
5. `packages/tool-runtime`：工具目录、审批、沙箱、调用和效果结算。
6. `packages/provider-runtime`：Provider 流、失败分类、持久交接和重试。
7. `adapters/persistence-sqlite`：当前权威持久化和迁移实现。
8. `apps/single-workspace`：Composition Root、daemon、transport 和生产 wiring。
9. `packages/projection-runtime` 与 `apps/web`：用户可观察状态和人工控制面。


### Coding agent 工具面

当前内置工具事实是 `read@2`、`list@2`、`patch@2`、`write@1`、`glob@1`、
`grep@1`、`shell@3`。`write` 提供递归创建父目录和完整写入；`glob` 和 `grep`
提供文件定位与文本搜索，注册于现有 Tool Runtime 接缝。当前源码已经通过真实
schema 55、SQLite、ownership admission、实际挂载目录和 evidence ledger 的运行链路
验证：工作区越界被拒绝、无 ownership 不创建文件、已完成写入回放不覆盖用户修改，
已获准但未完成的非幂等写入在模拟边界中断并重建相同服务后收敛为 OutcomeUnknown
且不再次执行。此项不是 daemon kill/restart 或双进程资格，见
`docs/verification/2026-11-15-filesystem-runtime.md`。它仍未
在普通安装包、真实模型和真实项目的完整用户旅程中验收；不能把这批集成测试扩大为发布资格。
当前仍没有独立 `edit`、`delete`、`move`、`websearch`、
`fetch` 或浏览器工具。shell 在普通 production 无 Linux Supported tuple 时
继续隐藏。新增三个文件工具只在 Linux 的模型目录中显示；底层定义保留用于精确
历史解析。`write`、`glob`、`grep` 的资源准入现在使用请求中的精确目标路径；父目录 carve-out
之外的合法写入可以继续进行，子区仍被拒绝。写入新建父目录时仍需按实际副作用范围
验证，不能把整根挂载当作授权。外部工具对照
和剩余缺口见 `docs/research/2026-11-14-coding-agent-tool-surface.md`；网络工具
另见 `docs/research/2026-11-14-network-tool-surface.md`。

### 网络入口与工具

真实模型请求发生在 Arbor 受信服务中，和隔离执行环境的网络是两条不同链路。
当前没有内置 `websearch`、`fetch`、浏览器或 MCP 执行器；也没有通过生产路径
证明供应商托管工具的执行地点、数据外发和费用边界。`network-egress.ts`、
`network-broker.ts`、`pref64-discovery.ts`、`network-tls-authority.ts` 和
`network-socket-broker.ts` 保留了 GET 下载实验。新 `network-proxy-broker.ts` 和
`network-proxy-helper.ts` 通过标准 CONNECT 接入 Native 候选，factory 已在 composition
登记，但未通过 production Supported gate。它们不等于浏览器预览、websearch、fetch
或 MCP 执行器。
当前不能证明的具体事项包括：普通安装包中的公网依赖下载、完整代理兼容、私有仓库认证、同沙箱
项目服务互连、受控预览端口、浏览器页面子资源、远程扩展清单变更和带副作用请求
的停止/重启恢复。详细矩阵见
`docs/research/2026-11-14-network-tool-surface.md`；当前阻断记录见 KP-003、
KP-013 和 KP-014。

2026-11-15 后续候选已补一般方法和流式 HTTP，并用真实公网 Git POST、npm 下载
验证了基础客户端兼容。仍未验收私有仓库认证、发布/部署副作用或停止后的远程
结果未知恢复；用户浏览器页面请求也不会自动经过它。原 GET-only 反例报告
`docs/research/2026-11-15-network-contract-audit.md` 是此前候选的调查快照，
最新结果及其明确限制见 `docs/verification/2026-11-15-standard-network-proxy.md`。

### 2026-11-15 停止与网络超时修复

Native 收到 Effect 中断后现等待进程组和 broker 清理，修复中断返回后后台仍写文件
的真实反例；两个不同目录的隔离调用中，停止 A 不影响 B。网页 StopExecution 到运行中
Provider 的取消链路现已用真实 daemon、SQLite、公开命令和挂起 HTTP 请求验收：持久
Stop 能在响应返回前中断 Provider，后续由恢复扫尾收敛。这不能将 scripted Provider
证据扩大为真实外部模型发布资格，也不能将 native fiber 用例扩大为两个正式 Workspace
资格。Native 进程副作用的完整取消/恢复矩阵仍待验收。握手另有十秒上限，上游错误可返回
HTTP 502/504。公网 Git 复验曾失败，修复
超时处理后 curl/Git/npm/项目测试重跑通过，但仍未证明长期网络可靠性。

本轮 Native 36/36、streaming 11/11、公网候选 5/5、根 TypeScript、架构 198 项和
lint 通过，普通生产门禁保持关闭。证据、失败记录及剩余范围见
`docs/verification/2026-11-15-native-cancellation.md`。
