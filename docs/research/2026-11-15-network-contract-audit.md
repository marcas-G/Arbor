# 网络需求续查：从下载通道到实际开发

日期：2026-11-15。范围：核对源码、外部实现和现有网络候选；本轮不修改运行代码、
冻结设计、生产配置或用户数据库。以下“建议”均未代替负责人接受新的设计方案。

后续优先级澄清：负责人已说明隔离首先避免工作区任意串扰，安全可不用那么苛刻。
下文保留对当前强合同的事实核对，不把其全部安全措施当作新的首发要求；最新
方向见 `docs/decisions/2026-11-15-workspace-isolation-priority.md`，其他 Agent 的
实际做法见 `docs/research/2026-11-15-agent-isolation-comparison.md`。

## 结论

严格隔离且联网是已确定要求。当前阻断是缺少可供普通项目和工具使用的完整链路，
不是需要用户重新选择是否联网。候选实现是有界 HTTPS GET 下载器及私有 Unix
socket/TLS 接入，尚不能替代 Git、包管理器、搜索、浏览器和扩展的网络能力。

建议按四种用户任务组织交付：联网开发、查询实时资料、运行与预览项目、连接用户
配置的外部服务。工程侧负责把目标检查、凭据、取消和恢复串起来；不让用户决定
namespace、broker、证书转发或内部资格编号。

## 本轮核实的事实

| 编号 | 已核实内容 | 来源与结论边界 |
| --- | --- | --- |
| N-01 | Native POSIX 的非 Disabled 策略直接返回 `NetworkBrokerUnavailable`；普通装配的 `nativeOsSupportedTupleAvailable` 仍为 false | `adapters/sandbox-native-posix/src/index.ts` 的 `validatePlanInput`；`apps/single-workspace/src/composition.ts`。没有普通生产联网命令资格 |
| N-02 | 外侧连接固定 `method: GET`、443，输出只剩最终 URL 和 bytes；不暴露上游 Content-Type、一般响应头或业务状态 | `transport/network-broker.ts` 的 `connectPinned` 和 `downloadThroughBroker`。认证、方法/请求体、流式响应和完整代理语义尚缺 |
| N-03 | Unix socket 候选拒绝非 GET、请求体、Upgrade、CONNECT；向客户端统一回 200 和 `application/octet-stream` | `transport/network-socket-broker.ts`。不能把它作为原生 npm/git 兼容代理或有内容类型语义的 fetch 执行器 |
| N-04 | Git smart HTTP 拉取使用 `POST .../git-upload-pack`；推送使用 `POST .../git-receive-pack` | Git v2.47.2 `Documentation/gitprotocol-http.txt`。同为 POST，业务行为不同；不能通过全部禁 POST 同时支持正常拉取 |
| N-05 | OpenCode 的 Tavily 搜索用带服务凭据的 POST；网页读取独立处理每次重定向的权限 | OpenCode 固定提交 `d759c548aab33a7a6f5171cbeab40a59e91d90aa`，见下方链接。仅证明参考实现，不证明 Arbor 已支持 |
| N-06 | 首次模型检查明确禁止重定向；普通 Provider fetch 的参数接口及调用没有显式 redirect 设置 | `src/model-setup.ts` 的 `checkConnection`；`adapters/provider-openai/src/client.ts` 的 `OpenAICompatibleFetchInit` / `OpenAICompatibleFetchClient`。两条路径需对齐核对，未在本轮测试实际跨域重定向或凭据泄漏 |
| N-07 | 远程 Worker adapter 依赖注入的 `send` 回调，不实现具体 HTTP/TLS 客户端 | `adapters/worker-transport/src/index.ts`。端口和协议抽象不等于远程运行产品已联网 |
| N-08 | 当前工具目录新增 write/glob/grep 源码候选，但没有 websearch/fetch/Agent 浏览器内置执行器 | `packages/tool-runtime/src/catalog.ts`、`src/tools/index.ts`。文件工具最近修订的完整资格未在本次网络研究中验证 |

`transport/` 均指 `apps/single-workspace/src/transport/`。同一静态入口盘点还检查了
Arbor Web、launcher、模型配置及 Provider。Web 的同源 API/进度连接属于 Arbor
控制面；未据此推断已经支持项目预览、遥测、自动更新或 MCP。SDK、注入回调和
子进程可能产生的网络仍需按运行时逐项核对，文本搜索不是完整动态通信审计。

## 实际任务需要的协议能力

| 用户任务 | 真正的网络需要 | 必须避免的遗漏 |
| --- | --- | --- |
| 克隆和拉取代码 | HTTPS GET + smart HTTP POST、认证挑战、Git 内容类型、流式 pack | GET-only 不够；Git LFS/子模块可能增加目标和凭据范围，成功克隆普通仓库不能代表它们已支持 |
| 安装依赖和工具链 | 注册源元数据、归档/CDN、合法重定向、可用的 TLS 信任、原生客户端代理配置 | install 脚本可能再联网；审计 API 也可能 POST；npm 的通过结果不能推断 pip/Cargo/Go 的结果 |
| 搜索资料 | 查询 API、服务专用认证、结果来源和费用信息、取消 | 搜索不等于抓取结果网站；无配置时不能用模型记忆伪装在线结果 |
| 读取网页 | 目标校验、Content-Type/编码、HTML/文本/JSON 等明确支持的解析、结果出处 | 下载 bytes 不等于可用网页；压缩后及解压后的大小、解析时间、输出上下文都要限制；PDF 与动态页面须另行列支持范围 |
| 下载到项目 | 网络读取 + 写入获准路径、临时文件、完整性校验、取消清理 | write 本身是文件工具，不因其存在获得网络；下载成功不能绕过文件权限，也不能自动执行下载内容 |
| 项目内服务及测试 | 同一沙箱生命周期内的本地 TCP、绑定地址、端口分配、进程停止 | 若服务与测试分属互不相通的网络空间，仅“各自有 localhost”仍不能互连；后台服务活多久、随谁停止要明确 |
| 用户查看开发预览 | 选定服务的受控入站入口、HTTP、WebSocket/HMR、访问生命周期 | 这不是沙箱向公网出站；热更新地址也不能指回不可达的沙箱端口 |
| Agent 操作网页 | 独立浏览器进程/会话、所有子资源和跳转、WS、下载、表单与上传 | 只查首次导航会遗漏 iframe/worker 等；浏览器不能借用主机登录态 |
| 调用远程扩展 | 依据所选服务的真实传输支持 HTTP 请求、流式结果、认证和断线恢复 | MCP 不能概括成“都用 WebSocket”；需核对实际版本/传输，stdio 是另外的进程入口 |
| 访问本机模型 | 只有用户配置的模型连接可访问相应本机端点 | 项目命令和 fetch 不能因此获得主机 localhost；控制面与执行面必须分别授权 |
| 使用代理/自签证书的服务 | 受信外侧代理、代理认证、上游 TLS 验证、明确的证书信任范围 | 不能通过继承主机所有代理变量、关闭 TLS 或安装全局临时 CA 解决；企业 CA/mTLS 当前没有资格 |

这是验收需求分解，不是宣布所有协议首发都开放。SSH、HTTP-only、非标准端口、
外部数据库协议、UDP/QUIC、内网以及私有服务仍需明确支持范围；它们不能因为
“必须联网”就自动开放。正常协议所需的读取 POST 也不代表发布操作已经授权。

## 四个需要纠正的边界承诺

### 1. 隔离主机与限制项目内容外发是两件事

项目文件受到读取权限控制；获准内容可以按任务发送给用户选定的模型。联网的
工具或构建脚本也可能把可读内容放进 URL、请求体、日志上传或第三方服务调用中。
文件隔离与目标域名检查不能自动识别这些内容是否应该外发。

本轮仅执行 URL 授权函数，使用合成字符串而未发送网络请求：Restricted 中允许
`https://example.com` 后，`/docs`、`/collect?sample=DEMO_PROJECT_TEXT` 都通过
origin 检查；loopback 字面目标被拒绝。证据在
`.test-results/network-contract-audit-20261115/url-boundary-example.json`。
这只证明检查层不判断内容/业务用途，不证明 DNS、连接或完整数据泄漏已发生。

**建议产品说明**：说明项目内容会发送给哪些已配置服务；给搜索、上传、发布和
远程工具保留目标/用途权限。不宣称“只要严格隔离就绝对不可能外发项目内容”。
任意命令得到某个目标的网络访问后，网络层本身不能可靠识别它的全部业务意图。

### 2. 禁止直接 DNS 与绝对禁止借 HTTPS 解析域名不能混写

独立网络空间和 broker 可限制直接 DNS、直连和 broker 实际拨号目标。即使工具
从公网资料里获得另一个地址，后续实际连接仍须过目标校验。

但任意公开 HTTPS 服务可以在普通响应中返回地址，也可以转发或编码 DNS 数据。
只检查 origin/IP/TLS 无法保证识别所有应用层解析/隧道。上述 URL 演示中，一个
`/dns-query?dns=DEMO_SYNTHETIC_VALUE` 也通过 origin 检查；这不是实际 DoH
请求，也不是已经发现可达内网的漏洞。

冻结 P4 `04` / P12 `13` 包含 DoH/绕过禁止措辞。工程需要提交可执行定义及反例，
说明保证的是“实际连接不可绕过地址边界”，还是更强的应用层内容禁止。这里记录
合同可验证性缺口，未改写冻结含义，也未把目前的候选判为满足强保证。

### 3. 用户预览的页面脚本在用户浏览器内执行

沙箱限制的是服务端进程。用户打开项目预览后，页面脚本运行在用户浏览器中，
浏览器自身的外部/本机请求不会自动经过沙箱 broker。浏览器同源策略、混合内容
和私有网络限制会影响结果，不能概括为所有请求必定成功，也不能当作 Arbor 已有
统一隔离保证。

**建议**：预览与 Arbor 控制面使用隔离的 origin 和凭据，不把开发页面直接当作
控制台的同源内容；限制入站服务/端口，核对 Cookie、跨源请求、下载与 WebSocket。
如果要保证页面所有网络均受 Arbor 控制，应提供经过隔离的受控浏览器；普通
用户浏览器预览不能承诺同等边界。当前没有此产品资格。

### 4. 停止本机请求不能撤销远端已接受的操作

取消 socket 或杀掉进程可以阻止后续本机活动，但无法证明对方没有计费、创建
资源、发包或接受推送。GET/POST 名字也不能决定是否有副作用。恢复必须依据
具体工具的幂等身份、服务查询或人工处置；搜索及模型请求还可能重复计费。
这些要求应沿用现有持久调用和未知结果处理，不以自动重试规避。

## 建议的工程顺序与用户验收

| 顺序 | 产物 | 用户能验收的结果 |
| --- | --- | --- |
| 1 | 隔离执行网络的完整接入；原生客户端方法/请求体/响应/认证语义；受信发现及代理/TLS 配置 | 普通安装后，真实模型在获准项目中拉取公共 HTTPS 仓库、安装依赖、实际构建和测试；越界和直连失败，无宿主执行回退 |
| 2 | 同一沙箱服务生命周期及受控预览方案 | 启动测试服务并访问成功；用户浏览器查看改动及 HMR；停止后服务和入口失效，控制台凭据不进入项目页面 |
| 3 | 独立 search/fetch 工具接入既有 Tool Runtime | 配置真实搜索服务后查询并引用来源，再读取真实文档；无配置/超时/限流明确显示；网页文字不能改变权限 |
| 4 | 项目范围私有服务与凭据配置 | 拉取指定私有仓库时只使用该目标凭据，跨域重定向及错误目标拿不到；停止/重启行为清楚 |
| 5 | 按已确认范围资格 Agent 浏览器及扩展 | 浏览器子资源与操作、stdio 进程、远程调用及未知写入结果都可观察、可停止并按合同恢复 |

1/2/3 的工程依赖可以并行梳理，表中顺序不替代冻结设计的授权门槛。当前的
`2026-11-14-linux-isolated-network-and-local-tests.md` 只解决部分命令与本地
服务边界，仍待确认；它没有批准全部工具、入站预览或远程账号语义。

每个已承诺场景都必须测正常路径、权限拒绝、网络故障、停止、重启，并绑定同一
源码/发行物。一个 npm 成功例或网络单元批次不能作为以上全部功能的交付证明。

## 本轮验证与材料

- 默认执行四个网络测试文件：118 通过、1 跳过（native 探针需显式启用）。
- 显式 `ARBOR_RUN_NATIVE_POSIX=1` 后，同四文件 119/119 通过。真实 curl、
  Unix socket/TLS、bubblewrap 通道使用 fixture 上游/discovery；未进行公网包安装、
  私有认证或发布级隔离资格。没有因为定向绿色而启用生产能力。
- 未重跑根 typecheck、架构、全功能或真实模型旅程；本次不为文件工具最近修订背书。
- JSON 测试报告、源码 SHA-256、URL 检查结果与外部材料下载清单保存在
  `.test-results/network-contract-audit-20261115/`。继承的工作区有大量未提交修改，
  HEAD 不能单独作为当前源码身份；本轮记录逐文件摘要。旧 2026-11-14 材料保持不变。

外部来源：

- [Git smart HTTP 协议 v2.47.2](https://github.com/git/git/blob/v2.47.2/Documentation/gitprotocol-http.txt#L320)。
- [OpenCode Tavily 搜索](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/plugin/websearch/tavily.ts#L38)。
- [OpenCode 网页读取与重定向](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/webfetch.ts#L80)。
- [此前核对的严格隔离联网实现](2026-11-14-strict-isolation-network.md)。

本轮成功下载固定版本的 Git 协议与 OpenCode Tavily/Exa 源码，只读取而未运行。
OpenCode MCP connection 源码下载超时，没有据其补写新实现事实。
