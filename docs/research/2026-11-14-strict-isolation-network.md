# 严格隔离下的开发工具联网：实现调研

日期：2026-11-14。目的：为已确定的“Linux 严格隔离且必须联网”寻找具体接入
方式；不重新讨论是否采用无隔离命令，也不改变现有冻结合同。

## 已核对的外部实现

来源是 Anthropic 的 `sandbox-runtime` 仓库，固定树
`0bbebed0aa9a8e628dc4df8bc30293550a1988eb`，没有运行下载的程序或添加依赖。
本地原始文件保存在 `.test-results/strict-network-research-20261114/`。

- [Linux 网络桥接源码](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/linux-sandbox-utils.ts)：
  通过 `bwrap --unshare-net` 建立独立网络空间，主机代理与沙箱之间用 Unix
  socket 桥接，沙箱内使用 socat 提供代理监听。HTTP 与 SOCKS 通道各有用途，
  源码描述了 HTTP_PROXY 与 Git SSH 配置；它不是直接共享主机网络。
- [独立代理协议与安全模型](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/docs/srt-proxy.md)：
  主机传入监听 socket 与决策通道；文档描述 TLS 终止、精确目标名、请求决策、
  限制及生命周期管理。没有 CA 时拒绝 CONNECT；该代理模式拒绝不透明隧道。
- [TLS 代理实现](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/src/sandbox/tls-terminate-proxy.ts)：
  对 CONNECT 中的 TLS 做终止，检查请求 Host/SNI 与目标绑定，上游连接再检查
  目标证书；私钥与决策状态由代理持有。
- [代理环境用例](https://github.com/anthropic-experimental/sandbox-runtime/blob/0bbebed0aa9a8e628dc4df8bc30293550a1988eb/test/sandbox/proxy-env-vars.test.ts)：
  覆盖代理变量和 NO_PROXY 等会影响工具路径的配置。这里只读用例，未宣称
  在 Arbor 或当前主机执行通过。

原始 raw 下载的部分请求超时，随后通过同一固定 SHA 的 GitHub contents API
取得 Linux/HTTP 代理文件；未把下载重试写成首次成功。

## 对 Arbor 的实际帮助

已确认存在可参考的工程组合：独立网络空间 + 专用跨边界通道 + 应用代理 +
开发工具配置。没有理由把“严格隔离”直接解释成“只能断网”。

Arbor 当前新增的 GET 下载实现只是外侧请求处理的基础，不能作为通用开发工具
代理交付。普通 npm/git/curl 发出的 HTTPS 需要可用的客户端接入与信任配置；
只添加代理地址或放行 CONNECT 不能证明 Arbor 逐请求、逐跳合同成立。

## 不能直接照搬的地方

1. Arbor 冻结合同要求整个 DNS 答案集只要有一个禁止地址就拒绝；参考文档中的
   地址过滤描述不等于这一要求，不能据此给 Arbor 签发资格。
2. Arbor 的受控联网目前只允许公开 HTTPS，并绑定 Pref64、逐连接固定、TLS 与
   五跳限制。参考实现的 SOCKS/SSH 等能力不自动成为 Arbor 支持范围。
3. Arbor 的现有环境投影只有 HOME、LANG、LC_ALL、PATH、TMPDIR、TZ；不能直接
   透传主机 HTTP_PROXY、CA 路径或其他变量。须明确区分受信生成配置和环境继承。
4. 需要核对沙箱内专用监听与“禁止 loopback/直连”的合同落点、TLS 信任范围、
   客户端证书/认证和 DoH 反绕过，不能在实现中自行放宽或默认已经解决。
5. 工具接入完成后仍需进程树清理、CPU/内存/进程数等现有隔离要求，以及同一
   普通安装包的真实任务验收。外部仓库的文档或用例不能替代 Arbor 的证据。

当前不向负责人重新提出内部网络方案选择。产品要求已经确定；这些是 Agent
需要继续查清、明确方案并验证的实现问题。有新的可见产品取舍时才另列问题。
