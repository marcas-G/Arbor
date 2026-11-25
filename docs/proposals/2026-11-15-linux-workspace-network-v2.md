# Linux 工作区隔离与普通联网开发：固定对齐包

日期：2026-11-15。状态：PREPARED，尚未接受、尚未落入设计、尚未启用命令。

本包落实负责人已经明确的方向：Linux 本机单用户、可安装、真实模型、工作区互不
任意访问、正常联网开发，优先复用成熟组件。它替代尚未接受的
`2026-11-14-linux-isolated-network-and-local-tests.md` 建议，不改写历史证据。

## 1. 用户实际得到什么

1. 安装后检查本机执行条件；通过完整检查后，普通工作台可运行获准项目中的
   文件操作、依赖安装、构建和测试。失败明确说明缺少什么，不静默退回宿主命令，
   不把只能对话或只能改文件称为完整安装成功。
2. A、B 工作区有各自的文件权限、运行环境、临时状态和服务归属。A 不能借 shell
   访问 B 未分配的文件，也不能停止或冒认 B 的进程/服务。明确的只读共享、写入
   所有权及正式交付保持现有语义。
3. 一个工作区自己的测试和服务可以通过其内部 localhost 通信；后续命令需要
   访问该工作区已登记服务时，复用同一工作环境。两个工作区可使用相同内部端口。
   这不开放宿主 localhost、其他工作区或内网。
4. 公网 HTTPS 使用普通 Git/npm/curl 等客户端及其正常 TLS 验证，不安装临时 CA，
   不解密 TLS，不要求工具改用 Arbor 专有下载协议。默认通道仅支持公开 HTTPS
   DNS 目标及端口 443；具体生态必须实测，不能写成所有协议已经支持。
5. 停止只影响选中的运行及其拥有的进程/服务；工作区服务必须有明确拥有者、
   关闭行为和可见状态。重启后不冒认旧服务，不盲目重放可能已发生的写入。
   模型自述完成和命令退出零都不替代独立 Verification 与 Acceptance。

本包不开放任意宿主/内网连接、继承主机账号、sudo、远程多用户或已有用户库升级。
Child 仍是独立 Workspace，经 Work/Message/Inbox/Deliverable/Dependency 协作；
没有把 Child 改为目录、容器、子进程或 Parent 目录的一部分。

## 2. 明确替换的旧要求

仅对新 Linux 执行规则使用下列合同；旧版本、Windows 和历史资格保持原义：

| 旧条款 | 新 Linux 合同 |
| --- | --- |
| 首发候选仅 Windows `ReadOnly × Disabled` | Linux 可对精确的 `WorkspaceWrite × Enabled`、`WorkspaceWrite × Restricted` 及所需只读组合独立资格；不得推导笛卡尔积 |
| 所有 loopback 均禁止 | 允许同工作区隔离网络空间内 TCP；宿主、其他工作区、内网连接仍被隔离 |
| broker 解密并核对每个 TLS SNI/Host/HTTP 跳转 | 标准 CONNECT；客户端端到端验证 TLS，broker 授权并固定每条出站连接的目标地址 |
| 每条连接必须取得独立的 NoDns64/Pref64 资格 | 新通道只拨数值 IPv4；检查完整 A/AAAA 答案及特殊地址，但不拨 AAAA，也不宣称证明网络不存在 DNS64 |
| broker 识别全部 DoH/加密隧道、正文与业务副作用 | 不作这种保证；出站连接不产生对其他工作区或宿主的直接路由，动作权限和副作用恢复仍由原 Tool Runtime 处理 |

IPv4 出站是该版本可验证的实现范围，不是把 IPv6-only 主机假报为支持。
在只有 IPv6 出站的主机上明确不可用；未来支持须使用不同规则与独立证据。
本包不要求负责人选择网络库、内部 ID 或资格术语。

## 3. 执行和通信边界

- 复用 bubblewrap 的 user/mount/PID/IPC/UTS/network namespaces，以及 systemd
  用户 cgroup 的进程树、内存、CPU、进程数、超时和停止管理。工具链只读；项目
  资源继续来自现有精确 admission/ownership。所有工具使用一致的工作区资源边界。
- 不把整个 HOME、Arbor 数据、主机网络、任意宿主 Unix socket 或模型密钥挂入工作区。
  主机工具环境只按既有名称 allowlist 投影。专用代理通过显式私有 IPC 接入；
  helper 及其固定启动配置属于受信产物，项目不能替换它们。
- 隔离必须覆盖共享挂载中的 pathname socket 及 namespace/进程逃逸路径；不能只
  测 abstract socket 或把只读挂载等同于禁止 socket 连接。可复用成熟 seccomp
  组件限制未授权 socket/namespace 操作；是否采用其他等效控制由工程和证据决定。
  缺少有效控制时不得签发 Supported。
- 工作区运行载体是工程对象，不新增 Agent 或组织实体，不代替 Work/Session。
  载体必须精确绑定 Workspace 和当前资源/策略身份；权限缩窄或停止时按既有
  quiescence 结束失效进程，不能让旧环境继续访问过期挂载。
- 同一工作区的后续命令与服务复用、预览入口是独立必验项。浏览器预览只映射明确
  登记的工作区服务，不透传 Arbor 控制凭据；HTTP 和 WebSocket 指向相同工作区。
  本包不凭网络通道新增永久端口或隐式服务。服务登记/预览的独立合同尚未闭合，
  必须另行闭合后实现；这不阻止本包精确限定的联网命令实现，也不减少总交付目标。

## 4. 公网通道的精确语义

通道只接受规范 `CONNECT <lowercase-IDNA-DNS-name>:443`，拒绝 IP literal、
userinfo、非规范域名及其他端口。Restricted 检查现有精确 HTTPS origin 清单；
Enabled 允许公共目标；Disabled 不启动外部通道，但同工作区内部 TCP 不因此失效。
Restricted 限制的是代理请求的 CONNECT 目标；不检查加密 TLS 内部的 SNI/Host，
不承诺阻止公共服务器的域名前置或应用层转发。这是相较旧严格域名合同的明确取舍。

受信侧每条连接重新查询全部 A/AAAA；任一答案命中既有冻结特殊地址 deny-set 时
整体拒绝，IPv4-mapped IPv6 先归一化。只选择已验证的 A 记录，以数值 IPv4 拨号，
不让系统重新解析目标，不连接 AAAA、不复用旧已解析路线。没有可用 A、DNS 错误、
地址被拒绝或通道失效均产生可读失败。

HTTP CONNECT 由标准 Node HTTP/net/stream 实现；TLS 字节原样转发，客户端使用
自己的普通受信根验证目标。Arbor 不生成 CA、不关闭证书验证、不声称检查了加密
HTTP 的 Host/方法/正文。HTTPS 跳转由客户端处理，每条新 CONNECT 重新授权；
它不是 broker 内的五跳下载器，也不声明限制了所有客户端的重定向总次数。
未来内置 fetch 的逐跳、大小、来源与取消由其独立工具合同负责。

保留有限建连期限、空闲期限、取消、背压和有界资源使用；停止等待通道及进程树
清理确认。网络可达不等于发布/部署获准，执行审批不自动扩大后续工具能力。

## 5. 版本和存储隔离

新规则必须拥有独立、版本化的 closed codec、规则摘要及 qualification manifest；
不得复用 `SandboxEnforcementRuleSetV1` 的字节或假填
`FreshPerResolutionAndConnection`、`ExactSniHostCertificate`、五跳保证。
`NetworkPolicyV1` 的用户选择字段、规范 origin 与字节保持不变。

新规则、brokerControls、snapshot/receipt 的精确版本合同见第 8 节，不能通过
宽松 JSON decoder 绕过。未包含的服务合同不因本包获得实现授权。
所有旧 snapshot、receipt 和历史 manifest 原样解析和审计，新旧规则不能互相
继承 Supported。具体迁移版本按实际头顺延，禁止升级 preserved 用户库。

## 6. 资格和正式装配

- provider 探测只报告事实，不能自行产生 Supported。精确主机 build、provider/
  capability 版本、profile×network、规则和实际产物摘要必须与受信 registry 和
  qualification manifest 一致；受信来源继续使用现有 P5 authority/source/high-water
  机制。Linux 不伪造 Windows signed-helper 证据。
- 必须验证真实文件、namespace、未授权 socket、网络、资源限制、进程树停止及
  崩溃恢复；不以命令退出零或工具存在替代。
- 新安装默认使用完成资格的隔离执行模式。条件不满足时明确报告未完成命令执行
  安装，不自动提权、不退回 TrustedLocal，也不把仅文件功能称为交付完成。
- 配置仍是启动快照；更新、主机/产物漂移、过期或缺失证据导致不可用，不能通过
  CLI/环境变量/模型输出强制宣称 Supported。既有安装不被后台静默切换。

## 7. 交付判据与授权边界

下列全部通过，才满足总目标；任何局部实验不替代它们：

1. 同一普通 Linux 发行物，从全新用户数据目录安装，浏览器配置外部真实模型，
   打开真实项目，使用 read/write/patch/glob/grep 定位并修改文件。
2. 普通权限/审批流程中完成公网依赖安装、真实构建和测试，并呈现失败；未配置
   模型不能开始任务，不能预先代办权限或使用 fake Provider。
3. 两个正式 Workspace 联合证明文件/权限/临时状态/相同内部端口互不串扰；
   各自能联网开发，经正式交付和接收协作。
4. 补充指导、停止 A 而 B 继续、命令产生副作用前后 kill/restart；不重复危险效果，
   结果不明明确呈现。后续命令访问本区服务，浏览器预览含 WebSocket 指向正确项目。
5. 普通安装包查看改动、独立验证、人工验收、重启历史保留；备份/恢复及声明支持的
   升级路径有真实证据。当前源码的完整检查、功能和发行资格仍必须单独通过。

本包固定上述行为及第 8 节的联网命令合同。附带 `landing.patch` 是对应 owner 文本的
精确审阅材料。接受并完成一致性复核后，授权对应 Linux 联网命令实现、追加迁移、
普通装配及资格工具开发。服务登记/复用/预览仍须形成后续精确合同；总交付目标
保持不变，不能以本包的局部完成替代。
本包不签发资格、不修改用户数据库、不批准部署或发布。

## 8. 联网命令的固定技术合同

### 8.1 新规则和控制字节

新增 `SandboxEnforcementRuleSetV2`。规范键序及唯一 Linux 模板为以下单行 JSON；
UTF-8、无 BOM、无尾换行、无额外空白，SHA-256 小写摘要不内嵌：

```json
{"version":2,"networkPolicyCodecVersion":1,"filesystemRuleVersion":1,"environmentRuleVersion":1,"processTreeRuleVersion":1,"resourceLimitRuleVersion":1,"brokerProtocolVersion":2,"addressClassificationSnapshotId":"iana-special-purpose-2025-10-09+sha256:86583d4bbc916863208c3fbb5a75ee3e6500dd12aa4f9bd3a72caaacb4a3da6a","addressFamily":"IPv4OnlyPublicConnect","redirectPolicy":"ReauthorizeEachConnect","tlsPolicy":"ClientVerifiedEndToEnd","localNetwork":"WorkspaceNamespaceTcp","platformPrimitiveSetId":"linux-bwrap-workspace-netns-cgroupv2-connect-v2"}
```

新增 `SandboxNetworkBrokerControlsV2`，仅允许以下两个 closed 形状，键序如示例。
第二个形状的 mode 只可取 `Restricted` 或 `Enabled`，必须等于 canonical networkPolicy：

```json
{"version":2,"mode":"Disabled","directNetwork":"Denied","broker":"Disabled","localNetwork":"WorkspaceNamespaceTcp"}
{"version":2,"mode":"Enabled","brokerProtocolVersion":2,"directNetwork":"Denied","dns":"BrokerOnly","addressFamily":"IPv4OnlyPublicConnect","ipPinning":"AllAnswersPublicPerConnection","redirectPolicy":"ReauthorizeEachConnect","tlsPolicy":"ClientVerifiedEndToEnd","rawIp":"Denied","udp":"Denied","specialUse":"Denied","localNetwork":"WorkspaceNamespaceTcp"}
```

NoDns64、Pref64、TLS 解密和 broker 总跳数不属于该 V2 的声明或字段。V1 的 decoder、
encoder、已记录规范字节、规则摘要和黄金向量完全保留，不允许据新行为重解释旧 V1。

### 8.2 Command、snapshot、receipt 与内部 process policy

- 新 `OsEnforcedPolicySummaryV2` 等于当前 `OsEnforcedPolicySummaryV1` 的**全部现有
  字段、类型和键序**，仅 version 改为 2，networkBrokerControls 改为上述 V2；kind
  仍为 `OsEnforced`。必须绑定 Linux、linux-bwrap 和精确 V2 registry rule digest。
  旧 `TrustedLocalUnconfinedV1` 不变，不获得 version 2。
- 新 `SandboxPolicyDecisionCommittedInternalV2` 等于 V1 的完整字段和键序，仅
  version=2、effectivePolicySnapshot=上述 V2。原 receipt 的命令身份、指纹、
  时间和单次消费不变；旧命令重放只返回它原来的 V1 结果，不能被重新物化成 V2。
- `DecideSandboxPolicy` schema 2 复用 schema 1 的全部输入字段、精确 authority/
  revision/CAS/选择合同，只允许上述 V2 Linux OsEnforced 分支。schema 1 只能物化
  原 V1；schema 2 不能生成 TrustedLocal。模型不能提交受信规则、控制或资格结果。
  新候选使用显式 policySchemaVersion=2，UI 转发该版本；缺失/未知版本拒绝，
  不从字符串 providerId 猜测版本。
- `SandboxEnvironmentBasisV1` 及其字节保持不变：相同 mounts/authority/registry
  输入仍得到原摘要。完整 effective-policy 摘要含 version 和 V2 controls，结合
  registry 内 V2 rules digest 绑定不同语义；不得用旧 policyDigest 验收新策略。
- 新内部 `OsEnforcedSandboxProcessPolicyV2` 与现有 process policy 具有相同现有
  字段和约束，kind 为 `OsEnforcedProcessPolicyV2`，另含唯一新增字段
  `networkBrokerControls: SandboxNetworkBrokerControlsV2`。它是进程内类型，不是
  新 wire 协议或 durable record。现有 SandboxProcessPort.run 的 request.policy
  扩展为 V1/V2 closed union；V2 adapter 不接受 V1 假冒 V2，反向亦然。
- V2 broker binding 不含 certificatePath，不产生 CA 文件；提供私有 socket、
  固定 relay artifact、端口及 close 生命周期。绑定只在精确隔离执行中使用，
  不从模型输入解析主机路径。旧 V1 binding 与执行分支保持原义。

### 8.3 SQLite 和版本兼容

下一项追加迁移以实际 schema 头顺延（当前头为 55，预计 56）：不重写任何旧行、
事件或历史 JSON，不添加伪 V2 defaults。原持久化列继续保存 version-tagged JSON；
只在确实存在旧 closed SQL 限制时追加允许上述 V2，原 V1 谓词保持。即使不需要
DDL，也推进 runtime schema，确保旧 binary 在打开新库前拒绝，不能误读新 JSON。
新的强 decoder 拒绝额外字段、错误 controls、跨版本混合或不匹配规则。

迁移器、manifest、README、干净初始化及发行包资格必须同基线更新。只运行于新库
和可丢弃资格副本；preserved 用户库升级仍禁止。旧 pending V1 动作继续按旧规则
执行/拒绝，不因新默认模式变为 V2；旧 Denied 行不能复活。

### 8.4 受信 Linux 资格材料

P5 registry entry 的现有字段与 canonical codec 不变；新 row 的
enforcementRuleSetDigest 必须等于 8.1 模板摘要，精确元组不得从旧 row 推导。
新增 protected source 只读方法 `readLinuxSandboxQualificationEvidence(ref)`：
输入只能是 registry 的 blob SHA-256 引用，输出规范 manifest 原字节或 unavailable，
不能接受模型提供的文件路径、公钥或自定义 verifier。缺少该可选方法时不支持 V2。

Linux manifest version=2 的规范键序为：version,providerId,providerVersion,
capabilityRevision,osFamily,osBuild,profile,networkMode,networkPolicyCodecVersion,
enforcementRuleSetDigest,validatedLimits,artifactHashes,cases。其余标量使用对应
registry/domain 类型及 closed 值；validatedLimits 使用现有 SandboxPolicyLimitsV1
的完整字段/顺序。artifactHashes 是按 UTF-8 role 唯一排序的
`{role,sha256}` 数组；role 集合精确为 adapter-runtime,adapter-source,bwrap,
qualification-control,relay-runtime,relay-source,systemctl,systemd-run。路径由安装产物
和受信 host 配置固定，manifest 不携带任意可执行路径。每个摘要为实际完整文件
字节的 SHA-256 小写值；不能仅哈希版本字符串。

cases 是按 caseId UTF-8 排序的 `{caseId,verdict,evidenceRef}`，verdict 仅为 PASS，
evidenceRef 必须是对应完整资格结果的 `blob:sha256:<lowerhex>`；没有自引用。
必需 caseId 集合精确为：artifact-drift,cancel-before-spawn,cancel-running-tree,
dns-mixed-denied,dns-rebinding,env-secret-absent,file-ro,file-rw,file-outside-denied,
host-loopback-denied,namespace-escape-denied,output-bound,private-target-denied,
process-limit,public-https,raw-network-denied,readonly-sharing,resource-cpu,
resource-memory,same-namespace-tcp,socket-outside-denied,timeout-tree。
Restricted 另必须包括 restricted-allow,restricted-deny；Disabled 不允许公共出站，
其 public-https 项替换为 disabled-egress-denied。每项为真实控制测试，不接受模拟
支持能力替代；完整 ordinary install/real-model/双 Workspace 验收另由第 7 节负责。

manifest 摘要必须等于当前受信 registry row 的 qualificationEvidenceRef；
manifest 的全部元组必须逐项相同。每次 capability 和 effect admission 核对当前
source/high-water、主机及实际产物字节；请求限制不得超过经过测试的 validatedLimits。
独立离线资格/安装流程可生成并明确安装材料，daemon/provider 自己不能签发 row，
不能把运行中的 probe success 自动写成 Supported。Windows 信任/签名源保持不变。
