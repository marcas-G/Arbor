# 实际功能验收

验收日期：2026-11-11；目录选择补验 2026-11-12；对话 admission 重启边界补验 2026-11-14（Asia/Shanghai）。  
源码：`e7065a7c` 加当前工作树中的未提交修改；本轮开始时已构建 daemon 和 Web。  
验收环境：本机 Linux、Node 24.21.0；浏览器检查使用 Chromium 156。

2026-11-15 补验：使用最终字体修复后的 source-free Linux x64 预览包重新完成了
真实模型文件型 coding 旅程。包身份、SHA、结果和边界见
`docs/verification/2026-11-15-final-package-coding-journey.md`。因此下文早期旅程
记录仍作为历史证据保留，当前包的文件型旅程以这份补验为准；命令、构建和测试仍
不可用。

## 用户现在可以完成什么

本机已复用用户授权的 Codex 模型服务，配置位于
`~/.config/arbor/arbor.config.json`。模型名称为 `codex/gpt-5.6-sol`。
凭据存放在仓库外的私有文件中，配置通过带明确目录边界的文件引用读取；
配置与凭据文件权限均为 `0600`。没有修改 Codex 的原始配置。

| 用户行为 | 本轮结果 | 实际验证范围 |
| --- | --- | --- |
| 准备全新数据库、启动 Arbor、打开首页 | 可用 | 启动器在新目录调用离线初始化工具创建 schema 55，再启动普通 production daemon；`ARBOR_DB` 选择、状态、停止和重启均实测通过，重启未再次初始化 |
| 在页面发送消息、获得真实模型回复 | 可用 | 在普通 production 实例发送消息，真实模型返回指定内容；Chromium 页面再次发送消息并获得回复 |
| 对话响应 admission 中断后重启并再次尝试 | 可用 | schema 55 可丢弃夹具复现旧半状态；daemon recovery 结束旧 Execution、显示 NeedsAttention；页面/命令再次尝试创建新的 Attempt/Execution |
| 刷新页面后查看对话历史 | 可用 | 浏览器刷新后，新回复和原有历史仍可见 |
| 提交文件目标、批准创建工作 | 可用 | 通过公开命令提交自然语言目标并处理其审批；本项使用真实模型旅程，不通过浏览器点击审批 |
| 让模型创建并读取文件 | 可用 | 真实模型调用文件工具创建此前不存在的目标文件，读回内容；文件快照证明目标文件新增、原有文件保留 |
| 独立核验结果、记录验收、完成工作 | 可用 | 独立执行读取目标文件并给出通过结论，公开验收命令后工作状态为 Completed |
| 重启后查看已完成工作和验收 | 可用 | 同一真实模型旅程重启 daemon 后，完成状态、验证和验收记录仍可读取 |
| 纠错、修改目标、停止工作 | 可用 | 真实模型下普通纠错、关键纠错和停止三条旅程通过，包含对应的重启和执行停止检查 |
| 父子工作、依赖与跨工作交付 | 可用（本轮受控任务） | 真实模型完成父子责任形成、子工作区文件写入授权、越界写入拒绝、交付满足依赖、独立验证、Parent 接收和父结果最终验收 |
| 执行 shell、运行项目构建命令 | 不可用（普通生产配置） | 当前进程执行模式为 Disabled；本轮文件任务成功不代表具备 shell 执行能力 |

“可用”仅指表中具体操作。本轮文件任务规模很小，不能据此宣布任意软件开发目标或全部发布场景已经完成验证。

## 项目目录与已有项目补验（2026-11-12）

普通生产入口已接入服务端目录选择器。用户可输入绝对路径或浏览文件夹，
使用已有内容，或勾选“新建此文件夹”创建最后一级目录；不同路径可在运行中
连续接入。“暂不绑定文件夹”是次要选项，不是路径失败后的自动降级。

当前源码的三条目录相关浏览器旅程全部通过，零重试：

- 中文及空格路径输入/浏览、已有文件保留、文件读取进入独立验证；
- 不重启创建另一位置的新文件夹和项目、再次选择原目录打开原项目、不产生重复项目、重启后两条目录绑定仍可见；
- 旧预设 Profile 的文件证据、Verification PASS、人工 Acceptance 及资源冲突反馈；
- 原始路径和伪造引用的公开创建命令仍被拒绝。

以上三条测试中的第一条同时包含前两项行为；这些旅程使用隔离的脚本
Provider，不代表又一次真实模型全场景验收。完整记录：
`.test-results/project-directory-research-20261111/folder-all-ui.log`。

本机 `127.0.0.1:18787` 已重启到本次构建，并以真实 Chromium 只读复核：
首页路径输入/目录浏览、已有项目列表、项目管理导航及继续根对话可用，
没有提交创建、重命名或归档命令，页面无运行时错误。原有一个 Project
和 schema 55 均保留；该旧 Project 本来就是 ConversationOnly，页面如实显示
“未绑定文件夹”，没有擅自绑定启动默认目录。证据：
`.test-results/project-directory-research-20261111/directory-live-browser.json`
及同目录 `directory-live-home.png`。

持久登记/重启、符号链接别名、最后一级目录创建、路径错误、鉴权、重复
目录事务检查、历史回执重放、准备中关闭表单和网络失败同命令重试，
另有后端 22 项与完整 Web 36 个文件 / 289 项回归通过。
对应日志为同证据目录的 `final-directory-core.log`、
`final-profile-catalog.log` 和 `final-web.log`。根 lint、typecheck、
架构 197 项通过；完整 `pnpm check` 在核心第 7/48 批主动中止，
没有完成全量核心批次，不作为完整通过记录。目录能力仅在本机单用户下验收；不声明
远程多人目录可见性、多 daemon 动态配置同步或任意文件系统替换检测。

## S1–S4 场景验收矩阵

| 场景 | 本轮真实模型结果 | 可以确认的行为 | 当前不能确认或未通过的行为 |
| --- | --- | --- | --- |
| S1 正常推进 | **通过** | Root 对话、形成 Work、人工批准、真实模型 patch/read、独立 Verification PASS、人工 Acceptance、Completed、重启后状态保留 | 更复杂的软件工程目标、长时间多轮返修 |
| S2 监督与纠错 | **通过** | 普通纠错进入后续模型轮次；关键纠错更新工作并停止旧执行；停止请求使精确执行静止，重启后保持 | 本结果对应三个受控小任务，不代表任意复杂纠错都能成功 |
| S3 父子协作与依赖 | **通过** | 父子责任、子工作区文件写入授权、越界拒绝、产物/交付、依赖满足、子独立验证、Parent 接收、父文件整合/独立验证和人工最终验收 | 本次使用事先授予的 `fs:write`；`executableApprovals=[]`，不证明逐次可执行动作审批分支，也不覆盖全部信息缺口、升级处理或任意组织规模 |
| S4 长期连续与恢复 | **A 通过，B 不适用** | S4-A Provider 硬重启后的未知结果被保留并进入 Attention，未重复执行；S1 旅程也证明完成结果重启后可读取 | S4-B 依赖 TrustedLocal shell 执行；普通 production 明确为 `Disabled`，没有发布级 Native OS tuple，因此不能作为普通用户能力验收 |

本轮修复后的七项浏览器流程全部通过：创建项目、对话与刷新/重启历史、
审批和验收、完成工作详情、资源 Profile 与冲突反馈、伪造资源拒绝、
项目路由隔离和切换。除已单独验证的真实模型网页对话外，这组浏览器
旅程使用显式隔离的脚本 Provider。公开流程定向五项也全部通过，
包含责任树、独立验证/验收、重启保留证据和两种纠错观察。

最初失败的原因已重新核对，不能继续把它们归因为模型不收敛：

- 脚本 Provider 验收指定了不存在的配置文件，实际回退读取 HOME 中的真实模型配置。
  已改为写入真实存在的私有测试配置，并验证 HOME 中存在其他 Provider 时，
  首次运行和重启均使用指定脚本 Provider。
- 真实模型响应拦截器在返回 HTTP headers 前等待完整回复和人工放行，
  把回复生成时间计入 15 秒连接超时。旧 S3 数据库中有 62 次 ConnectTimeout。
  已改为及时交付 headers、只拦截 body，并加入回归验证；本机服务配置
  另设 connect 60 秒、first event 180 秒、stream idle 90 秒。
- 页面首次实时连接建立前的变更可能没有后续推送，旧缓存会一直保留。
  已用失败回归复现，并在首次连接成功后主动刷新视图；重连刷新仍保留。
- 浏览器部分定位仍使用旧按钮、说明和错误文案，已按当前可见页面修正。
  缺失中文字体只影响截图显示，不能解释 DOM 文本定位失败。
- 协作场景把“等待后续指令、禁止读取”的临时执行指令写入了持久验证风险约束，
  导致独立验证者也禁止读取证据；已明确只把持续性限制写入验证风险约束。

旧 S2 运行被中止，没有三个分支均失败的证据；旧 S3 超时也不能和
脚本 Provider 的配置串用视为同一个运行时缺陷。

## 本轮保留的记录

记录位于本工作树的 `.test-results/user-journeys-20261111/`：

- `real-provider-chat.json`：普通 production 实例的真实对话结果。
- `real-provider-browser.json`、`real-provider-browser.png`：网页真实对话与刷新结果。
- `real-work-journey.log`：真实模型文件工作、独立核验、验收和重启旅程通过记录。
- `real-evidence/evidence-3DVPIa/PUBLIC-S1-REAL-2026-11-11T08-49-17.130Z-499e10f0-5214-49ca-84e5-831001c52f8a.json`：同一旅程的文件快照、公开工作状态、验证、验收和重启读取记录。
- `public-journeys.log`：脚本模型下的纠错、停止、交付和文件动作恢复结果。

另两组记录直接位于 `.test-results/` 下，并非上述目录的子目录：

- `all-scenarios-20261111/`：保留首次 S2 中止、S3 超时、S4 及页面/烟测失败记录。
- `scenario-fixes-20261111/s2.log`、`s2/**/public-s2-*.json`：真实模型普通纠错、关键纠错和停止 3/3 通过的结果与独立证据。
- `scenario-fixes-20261111/public-smoke.log`：公开流程定向 5/5 通过。
- `scenario-fixes-20261111/ui-refresh-fix.log`：页面刷新修复后的浏览器流程 7/7 通过。
- `scenario-fixes-20261111/initial-socket-red.log`、`initial-socket-green.log`：首次连接缓存缺口的失败复现及修复后 8/8 相关检查通过。
- `scenario-fixes-20261111/config-isolation.log`：HOME Provider 污染隔离和重启回归通过。
- `scenario-fixes-20261111/harnesses-fixed.log`：响应拦截、证据保留等 11/11 相关检查通过。
- `scenario-fixes-20261111/schema-cli.log`：初始化工具提示真实 schema 版本的 CLI 检查通过。
- `scenario-fixes-20261111/web-tests.log`：Web 全部 34 个文件 / 279 项通过。
- `scenario-fixes-20261111/public-boundaries-final.log`：命令输入、拒绝、模型服务恢复、验证 Fail/Unknown、崩溃恢复、历史翻页、两种交付顺序和默认 shell 禁用共 13/13 通过。
- `scenario-fixes-20261111/config-client-fixed.log`：配置隔离、启动清理和相同 Command envelope 的有界连接重试共 6/6 通过。
- `scenario-fixes-20261111/recovery-boundaries-fixed.log`：模型成功持久化前后两个精确崩溃边界通过。
- `scenario-fixes-20261111/s3-final.log`：真实模型协作旅程通过；对应证据为 `s3-final/real-public-real-public-s3-real-s3-603ffbc9ae-56dz5D/evidence-JyzaGK/real-public-s3-real-s3-603ffbc9ae-2026-11-11T14-59-53.901Z.json`。
- `scenario-fixes-20261111/fresh-user-start-fixed.json`：新目录一键初始化并启动、显式数据库选择、状态、停止、再次启动且 manifest 不变。
- `scenario-fixes-20261111/launcher-existing-db-boundary.json`：旧 schema 54 数据库被拒绝启动，未初始化/升级，数据库内容散列保持不变。
- `scenario-fixes-20261111/s4-headers.log`：响应拦截器修正后的真实 S4-A 重启恢复通过；headers 已到达但 body 未提交成功时，恢复保留未知结果并显示 NeedsAttention，不重放模型请求。
- `scenario-fixes-20261111/check.log`：完整 `pnpm check` exit 0，架构 197 项、核心 479 个文件、Web 279 项通过；后续启动器和场景小改动另有最终 lint/typecheck 与定向验收。

旧 F16 只等待服务端发完响应后延迟 25 毫秒就杀 daemon，却要求一定恢复出答案，
无法区分客户端是否已持久化成功结果。已改为在成功提交前/后的明确边界分别杀进程：
提交前显示 NeedsAttention、不推断答案、不自动重放；提交后只恢复一个答案、不再次请求模型。
本项使用测试子进程的暂停探针，重启使用普通 production daemon。

真实文件旅程使用独立临时项目、生产 daemon 和已配置的真实服务，
没有用脚本模型替代真实推理。主要操作经过公开命令和视图，
独立核验者的执行身份另用只读数据库查询辅助核对。
通过后的临时项目数据库已按旅程清理规则删除，证据记录保留。
这些记录包含本机路径和任务内容，未记录模型凭据。

## 仍需继续解决的用户阻碍

1. 浏览器完整审批/验收已有脚本 Provider 证据，尚没有同一旅程全部由真实模型驱动的浏览器记录。
2. 没有配置模型的其他安装仍会回退到固定本地回复。
3. 进程执行仍为 Disabled；真实模型文件任务成功不代表能够运行 shell 或执行项目构建。
4. 对话响应 admission 的旧半状态已经有安全恢复和再次尝试路径；这项验证覆盖的是可丢弃 schema 55 夹具和对应的命令/Web 旅程，不等同于完整发布功能套件或真实 Provider 的全部崩溃矩阵。

初始化工具成功提示已改为读取数据库实际 schema 版本，CLI 验证输出 55。
后台启动器已验证可在缺失数据库时自动调用该离线初始化工具；已有数据库仍走精确版本启动 gate，不会被自动升级。

本轮完整 `pnpm check` 通过，并在后续小改动后补跑 lint/typecheck。
没有执行完整 `pnpm test:functional` 发布套件，不能把这些定向旅程扩大为全部发布矩阵的完成结论。
