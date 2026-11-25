# 其他 Agent 如何组织文件、网络和工作环境

日期：2026-11-15。只读调研；未安装或执行这些 Agent，也未把它们的测试算作 Arbor
的能力证明。依据负责人最新澄清，重点是避免工作区任意串扰，安全防护允许务实
收敛。产品要求见 [`../decisions/2026-11-15-workspace-isolation-priority.md`](../decisions/2026-11-15-workspace-isolation-priority.md)。

## 对比结论

| 对象 | 已核实做法 | 对 Arbor 有用的部分 | 不能照搬的部分 |
| --- | --- | --- | --- |
| OpenCode | 独立 read/glob/grep、write/edit/patch、shell、webfetch/websearch；网页权限与命令权限分开。官方文档明确 shell 使用宿主用户权限 | 清楚的工具分工、修改前 diff、来源和搜索服务配置、后台命令可观察 | 命令审批/目录推断不等于工作区进程隔离；不能用窄命令规则替代实际访问边界 |
| Claude Code + sandbox-runtime | Linux 命令进独立网络空间，经 Unix socket/代理出站；同一命令能访问自身启动的 localhost 服务。文件/网页工具和 MCP 不在 Bash 沙箱内 | 普通 Git/npm/curl 通过标准代理兼容联网；命令与其子进程一起限制；权限与 OS 边界分工 | 宿主级工具/辅助进程、默认广泛读取和环境继承、可选无沙箱重试不满足 Arbor 跨工作区统一边界 |
| OpenHands | 当前 Canvas 可选 local 或 Docker；Docker 模式可让每个新 conversation 使用独立容器/Agent Server，挂载自己的工作目录与状态；同一宿主目录仍会共享文件 | 工作环境有明确归属；服务入口、端口和状态随环境管理；目录/状态持久化与运行载体分离 | 容器数量不保证文件隔离；普通 Docker 网络也不自动实现跨工作区网络限制；conversation 不能等同 Arbor 的长期 Workspace |
| Cline | 文件、命令、抓取及 MCP 是不同执行器；SDK 的 subprocess sandbox 使用子进程/IPC，MCP stdio 会继承环境后合并配置 | 工具组合、取消/关闭生命周期、显式 MCP 配置和连接状态 | “sandbox”名字本身不证明 OS 文件/网络隔离；不能复制全部宿主环境继承 |

其他项目有些只做工具审批，有些只隔离命令，有些把整个运行环境放进容器。
Arbor 的主要要求是每个工作区的操作范围清楚、并行执行不互相踩踏；这一点需要
自己验收。无需把这些项目未提供的最高强度网络审查都补完，才能提供正常开发。

## OpenCode：文件工具值得参考，宿主执行不能当隔离

源码固定在 `d759c548aab33a7a6f5171cbeab40a59e91d90aa`；工具/权限官网另存下载
快照，官网为滚动文档，不能假定与该提交逐行相同。

- `write` 接收 path/content，创建父目录并完整覆盖；`edit` 局部替换；`patch`
  处理结构化多文件变更。`FileWrite.write` 读取现状，生成 diff 后请求 edit 权限，
  再提交写入。这说明用户需要看到完整创建/覆盖能力，不能只依赖 shell 重定向。
- `webfetch` 自行逐跳处理 URL 权限，并解析网页内容；`websearch` 独立选 Provider。
  固定版本 Tavily 连接使用带认证的 POST。网络通道不能只支持无认证 GET。
- [官方权限说明](https://opencode.ai/docs/permissions/#shell)明确 shell 使用宿主
  用户的文件、进程和网络权限，目录推断为 best effort。其审批 UX 可以参考，
  不能据此声称多工作区实际互不可访问。
- [官方工具说明](https://opencode.ai/docs/tools/)说明后台命令与浏览器入口；当前
  Browser 连接桌面附带浏览器，并不证明那是独立于用户桌面的隔离浏览器。
- MCP connection 代码处理连接生命周期、catalog 更新和会话失效后的重连。
  这些不能直接替代 Arbor 对不明远程写入的持久恢复要求。

源码：
[文件写入](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/file-write.ts)、
[网页读取](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/webfetch.ts)、
[MCP 连接](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/mcp/connection.ts)。

## Claude Code：隔离网络可以兼容正常工具，不必自建每种下载器

[官方 sandbox 文档](https://code.claude.com/docs/en/sandboxing)明确：

- Linux 使用 bubblewrap/socat，独立网络空间没有直接外网路由；外侧代理通过
  客户端的代理配置服务 curl、npm、Git HTTPS 等。忽略代理的工具可能仍不能连接。
- Linux 命令的 localhost 私有，可访问该命令启动的服务；不能据此推断后续另一条
  命令自动加入同一网络空间。这对跨工具调用的开发服务尤其重要。
- Bash 沙箱只覆盖命令和子进程，Read/Edit/Write/WebFetch/WebSearch、MCP、hooks
  及部分辅助进程在其外；`allowedDomains` 不能约束全部这些工具。
- 默认代理不解密出站 TLS，文档承认域名限制的局限。可选 TLS termination 与独立
  `srt proxy` 是其他配置/模式，不能与默认代理混写。

固定源码 `sandbox-runtime@0bbebed0aa9a8e628dc4df8bc30293550a1988eb`：
[Linux 通道](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/linux-sandbox-utils.ts)
使用 `--unshare-net` 和 Unix socket 桥，沙箱侧有代理监听；
[standalone proxy](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/docs/srt-proxy.md)
模式则要求受信 decider 并拒绝不透明 CONNECT。后者不代表默认模式的网络保证。

对 Arbor：可以采用成熟的“隔离工作环境 + 普通工具网络接口”，无须把逐请求
TLS 解密当作防止工作区文件互相覆盖的必要条件。需要隔离和记录的是工作区实际
文件/进程/服务边界，不能只包住 shell 后让其他工具绕开它。

## OpenHands：运行环境隔开以后，挂载和状态仍需明确

本轮发现其当前仓库已经分工为 Canvas 与 software-agent-sdk；旧 Python runtime
路径不再存在，不能照旧资料假定实现位置。

- Canvas 固定 `e20691d0ef4329a8c0fca7794272cfaf255d3709` 的
  [README](https://github.com/OpenHands/OpenHands/blob/e20691d0ef4329a8c0fca7794272cfaf255d3709/README.md)
  明确 local 默认和可选 Docker，以及 `OH_CONVERSATION_RUNTIME=docker`。
  每个新 conversation 可有自己的容器、Agent Server 和工具；挂载的工作目录和
  状态可跨容器替换保留。README 特别指出：挂载同一个宿主工作目录时，文件仍共享。
- SDK 固定 `942deccf8a865ca04db54955ebefe1a5abd10f10` 的
  [DockerWorkspace](https://github.com/OpenHands/software-agent-sdk/blob/942deccf8a865ca04db54955ebefe1a5abd10f10/openhands-workspace/openhands/workspace/docker/workspace.py)
  创建容器、绑定用户指定 volumes、把 Agent Server 发布到宿主 loopback 的选定
  端口；Docker network 可配置。该路径没有展示按 Arbor 工作区实现的外网/内网隔离
  证明，也未在本轮运行。
- [LocalWorkspace](https://github.com/OpenHands/software-agent-sdk/blob/942deccf8a865ca04db54955ebefe1a5abd10f10/openhands-sdk/openhands/sdk/workspace/local.py)
  执行本地命令、复制文件，不能与 Docker 模式的保证混用。
- 读到的 `sdk/launch/preview.py` 是启动配置预检，不是网页开发预览。未据此声称
  已调研清楚所有项目端口、HMR 或浏览器预览实现。

对 Arbor：独立目录/worktree 和独立运行环境解决不同问题；必须检查实际挂载和
可写区域。共享目录不能因为“用了容器”就自动避免互相覆盖，也不能让每次关闭
环境都把整棵文件树静默复制给其他工作区。

## Cline：工具生命周期可借鉴，子进程不等于访问隔离

固定提交 `72b3d7140553a733242126e51a7c2e87efe75c64`：

- [SDK 工具定义](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/tools/definitions.ts)
  分开文件、命令、网页抓取及交互，SDK/ClineCore 的工具清单不能自动推广到所有
  编辑器扩展或产品版本。
- [网页抓取](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/tools/executors/web-fetch.ts)
  有流式大小上限、取消信号和内容处理；但源码在取得响应头后就清除 timeout，
  且默认自动重定向。不能把“有 timeout 参数”写成整个正文阶段都受该计时器限制，
  或把它作为 Arbor 逐跳目标检查已闭合的参考证明。
- [subprocess sandbox](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts)
  通过 spawn 和 IPC 承载插件/工具运行，可以注入 launcher；默认子进程实现不是
  OS 文件/网络隔离的证明。
- [MCP stdio](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/mcp/client.ts)
  启动时合并 `process.env` 和服务 env；关闭有优雅退出/强制退出处理。
  前者不能复制为 Arbor 的默认跨工作区环境策略，后者的生命周期分工可参考。

## Arbor 应据此收敛什么

1. 先把多工作区真实并行的文件/写入所有权、进程、临时状态、服务端口和结果归属
   做对；每一层都要知道当前 Workspace，不仅 shell。
2. 常规联网用兼容原生工具的方式实现；文件写入、搜索抓取和命令执行有清楚接口，
   不靠一个万能 shell 或 GET 下载器补所有功能。
3. 安全按主要产品目标取舍，不以绝对内容防泄漏、识别所有加密隧道或自建完整
   TLS 审查作为工作区隔离的同义词。基本 TLS、凭据用途和误接其他工作区的防护保留。
4. 验收先看 A/B 同时工作是否互不踩踏且各自能联网构建测试，再看协作交付和
   停止/重启是否正确。单独下载成功或建立两个空容器均不够。

当前 Native 生产执行仍不可用；本报告没有启用它，也没有代替冻结网络合同的
正式对齐。强安全合同的替换应按新优先级明确记录，不能静默复用旧资格。

## 材料与局限

原始下载和逐轮成功/失败清单在 `.test-results/agent-network-comparison-20261115/`。
官网保留原始 HTML/Markdown 与可见文本；GitHub 源码按上述固定提交下载并记录
SHA-256。OpenHands 整仓 recursive tree 首次下载不完整，改用固定子树与 SDK 树；
旧 runtime 目录查询失败保留记录。没有将下载失败写成没有该能力。

本轮没有运行其他 Agent、它们的容器或测试；没有测试其隔离强度、崩溃恢复、
完整网页预览或发行安装。结论仅限读到的源码和官方文档。
