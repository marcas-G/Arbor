# Linux 隔离联网与项目内部测试：固定落地方案

状态：待负责人确认；没有修改冻结设计或启用生产命令。
日期：2026-11-14。已有确定要求：Linux 首发、严格隔离、必须联网、真实构建和测试。

2026-11-15 状态补充：负责人澄清隔离首先防止工作区任意串扰，安全要求可以
不用那么苛刻。本稿没有被接受，且仍沿用较强网络前提；后续须按
`docs/decisions/2026-11-15-workspace-isolation-priority.md` 重新收敛，不能继续
把本稿作为唯一方案等待确认。下文保留旧方案内容用于追溯，不代表新决策。

## 唯一需要明确的可见行为

建议允许一个项目的服务和测试在**同一个沙箱内部**通过 localhost 互相连接。
例如测试启动临时 Web 服务，再请求它验证结果。沙箱自己的 localhost 与主机
localhost 是不同的网络空间；访问主机服务、主机文件、内网和其他沙箱仍然禁止。

这是为了让常见项目测试能运行，不是无隔离模式，也不是共享宿主网络。
公网下载仍经受控 HTTPS 通道。此前确认的严格隔离和必须联网没有重新变成选项。

## 必须处理的现有矛盾及实证

- SD 的 Native 网络段及 P4 `04`、P12 `13` 把 loopback 一并写入禁止项，
  没有区分主机与沙箱内部。
- 实际 bubblewrap 独立网络空间内，Node 临时服务绑定 `127.0.0.1` 后，
  同一沙箱的客户端可以连接。真实探针输出为
  `sandbox-only loopback succeeds`。这说明当前候选和文字本身已经不完全一致。
- 已完成真实 curl + TLS + Unix socket + bubblewrap 的局部通道用例：
  `apps/single-workspace/test/network-socket-broker.test.ts`，
  `ARBOR_RUN_NATIVE_POSIX=1` 时 12/12；其上游及 discovery 是明确的 T2 夹具，
  不作为公网联网或完整安全资格。通道没有主机网络共享或 TCP listener。
- 普通 npm/git 不具有 curl 的通用 `--unix-socket` 接入参数。进一步兼容常见
  开发工具需要明确沙箱内部专用代理监听的合法性，不能把它偷偷算成已批准行为。

## 固定产品语义

1. 严格隔离是首发唯一命令边界；没有隔离资格就拒绝执行，不回退到宿主机命令。
2. 同一沙箱内允许 TCP loopback：专用代理监听及项目自身的开发/测试服务。
   不提供宿主 loopback、宿主接口、内网路由、跨沙箱访问或直接公网路径。
   原始套接字和外部 UDP/QUIC、直接 DNS 等禁令保持。
3. 公开 HTTPS 访问由外部 broker 负责。主机连接目标仍必须通过全部 A/AAAA、
   特殊地址与 Pref64 校验、固定地址、精确证书/SNI/Host 和逐跳授权；最多五跳。
   代理内部的 loopback 不会变成 broker 可拨出的外部目标，不能通过代理回到
   主机或内网。
4. 初期使用沙箱临时 HOME 内生成的 npm/git/curl 配置接入专用代理；不继承用户
   HOME、代理变量、模型密钥或凭据。不拓宽 ambient environment allowlist。
   若后续需要其他注入方式，须另行核对合同，不默认授权任意环境透传。
5. 临时代理 CA 只供本次沙箱信任；私钥在沙箱与项目外，结束后销毁。不得修改
   主机全局信任库或关闭上游 TLS 证书验证。不透明 CONNECT 不能替代完整校验。
6. Linux 可写项目和联网是正式首发必备能力；资格必须绑定精确主机、provider、
   规则及产物。安装器只有在完整资格通过后才能生成 Native 启动配置；缺少资格
   则明确报告命令执行不可用，不把仅文件模式算作完整 coding agent 交付。
7. 人工权限、独立验证、验收、停止和恢复要求保持。不得借此自动提升所有项目
   权限、升级保留用户数据库或声明未经验证的公开发行。

## 固定设计落地包

确认后才落入以下 owning documents；不修改历史结果证据。

### Scenarios：v1.10 → v1.11

追加 Linux 开发命令补充场景：用户要求安装依赖并运行项目测试；获准后执行环境
在批准目录内下载、构建、运行测试。测试可在自己的沙箱内启动和访问本地 TCP
服务；宿主文件、宿主服务和内网不可访问。失败必须可见；停止、重启、独立验证
和最终验收沿用既有场景，不把命令退出零等同于 Work 完成。

### System Design：v1.25 → v1.26

追加 `Linux isolated networking and local-test supplement`：

> For newly qualified Linux primitive-v2 tuples, NetworkPolicyV1 governs
> egress beyond the isolated execution network namespace. Same-sandbox TCP
> loopback may connect the broker relay and project-local test/development
> services. Host loopback/interfaces, private/LAN targets, other sandboxes,
> direct external DNS/network, raw sockets and external UDP/QUIC remain
> denied. All external HTTPS remains broker-mediated under the existing
> address, Pref64, TLS and redirect contracts. A broker relay is not a host
> network route. Legacy primitive-v1 tuples retain their recorded contracts.

### DID：v1.65 → v1.66

追加首发补充：Linux 的正式 shell 候选允许经完整资格的
`WorkspaceWrite × Restricted|Enabled` 精确组合，不再仅限旧 Windows 只读断网
候选。Windows 既有资格不继承到 Linux；没有资格时保持 Disabled/不可用。
安装器可在同一安装产物和主机完整资格通过后写入既有 Native 启动模式；配置
仍为启动快照，无 CLI/环境覆盖、运行中静默切换或弱边界回退。

该补充不自动产生 Supported 行、迁移或现存数据库变更，也不重新解释旧记录。

### P4 `04-sandbox.md`

追加上述 primitive-v2 的 egress/namespace-local TCP 区分；把受控通道的
逻辑边界、临时 HOME/工具配置与 CA 的生命周期落在 Sandbox 合同中。
原有环境投影、资源准入和权限不变；网络策略字段与规范字节不变。

### P12 `13-security-performance.md`

为新 Linux 边界新增闭合 primitive ID：
`linux-bwrap-user-mount-pid-netns-cgroupv2-seccomp-broker-v2`。
旧 primitive ID 的语义与证据不变。新 ID 进入规则集模板与精确资格行，得到
独立 enforcementRuleSetDigest；不得复用旧规则摘要或旧 manifest 作为通过证明。
其余规则版本、网络策略 codec、地址快照、Pref64 和逐跳合同保持。

资格必须同时证明：内部 TCP 服务可用；broker 通道可用；主机/内网/跨沙箱/
直接外部网络和未经授权 socket 不可用；TLS/请求身份不混淆；上游未知 discovery
被拒绝；资源限制及进程树停止生效。不能以发现程序或单个下载成功代替。

### P12 `12-providers-tools.md` 与 `14-acceptance.md`

前者补安装资格结果与 Native 配置装配、固定运行时/辅助程序的产物信任；后者
增加上述新 primitive 的完整正反矩阵，以及普通安装包真实 npm/git/curl、构建、
测试、失败、停止与重启恢复。Linux 材料不能伪装成 Windows signed-helper 材料。

### 当前状态文档与 AGENTS supplement

只在接受并落地后记录 proposal 的精确摘要、决策、owner 修订及一致性检查。
所有 current-state 文件继续区分“已授权”“实验实现”“已资格”“已发行”；
不会因为设计通过就把尚未运行的功能写成可用。

## 明确没有被此方案解决的事项

受信 Pref64 discovery/NoDns64 方法、TLS 代理完整 HTTP 兼容、seccomp、聚合
资源限制、精确 qualification/authority 装配及完整安装包验收仍须实现并证明。
本方案没有降低它们的要求。SSH、任意内网或远程主机访问也不由本方案开放。
