# Linux 进程执行首发方案

状态：实现方案修正；负责人已明确要求严格隔离且必须联网，不能以断网模式
交付。未修改 `docs/design/**`，不宣称当前已支持。

## 要解决的用户问题

Linux 首发的 Arbor 必须能在用户选择的项目目录内运行构建、测试和其他
开发命令。文件读取和修改已经可以通过浏览器使用，但没有进程执行时，用户
仍然不能完成一次真实的软件开发闭环。

## 首发行为

普通用户安装后，Arbor 只在当前 Linux 主机通过完整资格检查时显示并执行
shell 工具。资格检查失败时继续显示可用的文件能力，并在需要运行命令时
给出明确的“当前主机未具备安全执行条件”结果；绝不改用无隔离的本地进程，
也不返回测试夹具的假结果。

当前冻结的首发设计只允许受信配置明确提供的精确 tuple；现有设计文本给出的
候选是 `ReadOnly × Disabled`，并没有批准 Linux `WorkspaceWrite`。因此本方案
不能把 Linux 写入能力直接写成已支持行为。要满足 Arbor 的 coding agent 目标，
负责人已经要求完整的 Linux coding agent；待处理的是把现有 Windows 首发限制
对齐到 Linux 的精确设计落点，再进行对应资格和装配，不再重复询问是否需要构建和测试。
网络访问是首发必要能力，不能推迟为可选后续功能；只读或断网资格都不能
证明 coding agent 的安装依赖、构建和测试已经可用。

## 进程边界

- 项目目录是唯一允许写入的用户资源；其他已接入的文件资源按当前审批结果
  只读或读写挂载。
- bubblewrap 创建新的 user、mount、PID、IPC、UTS 和 network namespace；
  子进程没有直接网络、主机 loopback、任意宿主 socket 或 Arbor 数据目录访问。
  实际联网经既有 Restricted/Enabled 的受控通道，不能把隔离等同于断网。
  DNS、地址分类、逐连接固定、TLS 身份、重定向及反绕过遵循现有 P4/P12 合同。
- `/usr`、`/bin`、`/lib`、`/lib64` 等系统运行时目录以只读方式提供，作为
  执行开发工具所需的工具链；它们不是用户资源，也不允许写入。不存在的
  目录或符号链接无法把沙箱带回主机路径。
- 用户配置的程序运行时目录（例如发行物自带的 Node）以只读方式提供，
  由安装器固定到该发行物；不得从请求参数或 `PATH` 动态选择主机外部程序。
- systemd 用户单元包住整个 bubblewrap 进程树，负责内存、CPU、进程数、
  总运行时间和 kill-on-stop；stdout/stderr 在 Arbor 侧有独立字节上限。
- 所有路径、参数、环境名和挂载在 effect admission 前重新核对；任一条件
  无法证明时不创建进程。

## 可安装性

安装器在首次运行前检查 bubblewrap、用户级 systemd、cgroup v2 的 pids、
memory 和 CPU 控制器以及 namespace 能力。缺少任何条件时，安装仍然成功，
但产品明确显示“文件模式可用，命令执行不可用”，并给出发行版安装提示。
它不静默降级为宿主机执行。

## 资格证据

只有同一个发行物、同一个主机 build 和同一个规则集完成以下真实检查后，
才可以把一个精确 tuple 标成 Supported：

1. `pwd`、文件读取和文件写入只触及获准项目目录；
2. 主机 `/etc`、Arbor 数据目录、其他用户目录和未挂载目录不可读；
3. 允许的公开 HTTPS 依赖下载确实成功；绕过通道的 DNS、IPv4、IPv6、主机
   loopback、UDP 和任意 TCP 连接均失败。Restricted 未列出地址、私网、保留
   地址、DNS 混合答案、重绑定、TLS 身份不符和越界重定向均拒绝；
4. 子进程树、超时、停止、进程数、内存、CPU、stdout/stderr 限制均真实生效；
5. 符号链接、路径穿越、环境变量和可执行文件替换的负向用例均失败；
6. daemon 重启后未提交和已提交两侧都按现有恢复合同收敛；
7. 干净安装包在目标 Linux 架构完成同一组检查。

证据必须由资格工具生成并由受信任的本机配置引用。provider 自己探测到
`bwrap` 或 systemd 存在，不能单独生成 Supported 结论。

## 需要修改的实现范围

- Native POSIX adapter：真实启动、输出收集、超时、停止和错误分类；
- Linux provider probe：systemd/cgroup/namespace 的有效能力检查；
- process policy materializer：Linux 精确 tuple、当前 host build 和证据绑定；
- production composition：从受信配置读取资格结果，不再把 Linux 永久写死为
  `false`，但缺少资格结果时仍为 Disabled；
- preview/release packager：固定发行物运行时和工具链路径，生成资格所需的
  版本与摘要信息；
- functional acceptance：从浏览器真实模型路径运行项目构建、测试、失败、停止
  和重启恢复。

## 不属于本方案

本方案不开放远程项目、多用户目录可见性、自动安装任意系统
依赖或对已有用户数据库的升级。它也不改变项目目录、权限审批、Verification
和 Acceptance 的产品语义。

网络 broker 属于本方案的必要实现范围，受现有 P4/P12 网络合同约束；不得
把它排除或推迟为首发后能力。负责人澄清记录见
`docs/decisions/2026-11-14-strict-isolation-with-network.md`。

## 当前结论

这是一项首发阻断项的具体收敛方案。当前代码尚未满足它：Native POSIX
没有可用的 Linux Supported tuple，Linux provider registry 没有受信资格材料，
生产组合也仍固定为 Disabled。即使完成只读 Native 资格，也不能宣称已完成
可写进程的构建和测试。产品目标已有授权；精确设计变更仍须保持可审计，
然后由同一发行物完成完整资格。
