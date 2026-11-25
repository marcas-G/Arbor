# 标准代理候选与真实开发命令验证

日期：2026-11-15。基线：`e7065a7c` 加当前未提交修改。
结论：Linux 隔离执行候选已能通过标准代理完成真实公网请求、Git 查询、npm 安装
及项目测试。**普通安装包尚不可执行命令，KP-003/KP-014 未关闭。**

## 实现与复用

- 标准 HTTP CONNECT 由 Node `http.Server` 处理；TLS、HTTP 消息、分块传输、流控和
  上游证书验证均使用 Node 标准库，移除自定义 ARBO 握手与手写 HTTP 解析/序列化。
- X.509 签发使用 MIT 的 `@peculiar/x509@3.1.0`、其要求的 `reflect-metadata@0.2.2`
  以及 Node WebCrypto。没有新增 transport 直接启动宿主进程的通道。
- 私钥只在宿主内存。临时公证书与辅助脚本只读挂载到沙箱，不安装到宿主 trust。
  这是按旧冻结合同验证的 TLS 兼容候选，不把 TLS 解密新增为负责人产品要求。
- 沙箱保持独立网络 namespace；内部辅助程序只做 TCP ↔ 私有 Unix socket 字节转发。
  辅助程序归 P12 transport，由 broker 提供路径；Native adapter 不反向依赖 app。
- 同一次执行有单独 broker 生命周期；计划拒绝、构建异常及进程返回后均进入关闭。
  路径须为真实规范路径、固定 `egress.sock`、实际 socket/普通文件；socket 目录不
  包含其他文件。网络策略走已有 domain decoder，包括 Disabled 目标列表必须为空。
- 请求先绑定 CONNECT/SNI/Host，再对全部 DNS 答案校验并选定 IP；每次实际请求
  重新解析/校验。按标准剥离 hop headers 与 Proxy-Authorization，保留目标凭据和
  端到端响应头。上传暂限 16 MiB，连接/请求使用有界超时；不宣称满足所有开发场景。

## 已观察到的行为

真实 systemd 用户单元和 bwrap 内按顺序执行：

1. 校验代理环境变量；绕过代理直连公网 IP 失败。
2. curl 从 `https://example.com/` 获得内容。
3. Git v2 `ls-remote` 查询 Arbor HEAD，上游包含 GET `/info/refs` 与 POST
   `/marcas-G/Arbor.git/git-upload-pack`；返回公开 HEAD `e7065a7c…`。
4. npm 真实请求 registry 元数据及 tarball，安装 `is-number@7.0.0`；关闭 audit/fund，
   明确使用 `--ignore-scripts`。这不证明 lifecycle scripts 或完整构建链已验收。
5. 系统 Node 执行项目 `node --test`，通过已安装依赖计算结果，`pass 1 / fail 0`。

结果 exit 0，未超时、未截断。完整命令、上游方法/目标及 stdout/stderr 保存在
`.test-results/network-proxy-20261115/native-command-outcome.json`。

此案例**显式注入测试 Supported capability、IPv4 resolver 和 Pref64 已知正答案**；
真实公网响应不是 fake upstream，但 discovery 与资格是 T2 夹具。它没有走普通
production、安装包、真实模型或浏览器，因此不能计为用户完整任务验收或 T3 资格。

另一组 T2 用例在两端使用真实 TLS/HTTP/socket，仅把 DNS 和上游地址指向本机
测试站点：验证分段 chunked POST、分块响应、凭据/响应头保留、hop headers 移除、
错误 Host、绝对 URL、重复 Host、过大 body、错误/缺失 SNI、不信任 CA、关闭时取消
pending discovery 和重复关闭。不把本机 fixture 说成外部网站资格。

## 验证结果与失败记录

- 五文件网络核心：151/151（含显式启用的真实 native 用例），`network-core.log`。
- 两文件功能定向：14/14，`functional-final.log`；已登记到 functional inventory。
- 根 `pnpm typecheck` 和补充 test typecheck：exit 0，`typecheck.log` / `test-typecheck.log`。
- 完整架构：38 文件、198/198，`architecture.log`；未扩大架构白名单。
- 根 lint：1490 文件通过，`lint.log`；`git diff --check` 通过。
- `pnpm test:manifest` 修正 inventory 后通过，`manifest-fixed.log`。初次失败因 validator
  仍硬编码 69，而新增两文件变为 71；runner 因拒绝 inventory 没有产生 probe 文件。
  保留原 `manifest.log`，不将修复后的结果描述为首次零失败。
- 初始库集成缺 reflection polyfill，出现模块载入失败；依库文档补显式依赖和入口导入。
- 初始架构检查发现 transport 代码/测试放错层；移动辅助程序至 transport、真实协议
  harness 至 functional，并由 adapter 接收 binding，保留原边界检查。
- 原 Restricted 夹具使用显式 `:443`，违反已有 canonical origin 合同；修为有效输入，
  同时补无效策略反例，未放宽 decoder。

以上是定向增量，未重跑完整核心、Web、release、干净 VM 或最终安装包。
证据目录的 `source-manifest.json` 保存 19 个相关源码、依赖及测试文件摘要；
它只标识本次候选，不是正式发行物签名或完整仓库资格。

## 尚未完成的关键行为

1. ordinary composition 只是登记 factory；默认 Disabled 与两处
   `nativeOsSupportedTupleAvailable: false` 保留，无受信 Supported tuple。
2. 实际主机 RFC7050 AAAA ENODATA 仍返回未知，没有伪造成可信 NoDns64 负证明。
3. 新通道每次请求重查目标，但没有跨客户端连接的五跳重定向计数，也没有证明禁止
   所有应用层 DoH/隧道。它不能继承旧 GET 下载编排的完整逐跳资格。
4. 每次命令独立 namespace/进程组，不提供跨命令共享服务、工作区预览映射或恢复后
   服务身份。两个工作区同端口服务、停止互不误伤及重启仍需真实联合验收。
5. 私有仓库、代理认证、SSH、非 443/HTTP、WebSocket、UDP 和远程发布副作用未验收。
6. websearch/fetch/浏览器/MCP 仍没有因此获得模型工具执行器或对应权限。
7. 所有 process Stop/取消、并发/崩溃边界和完整 Native 资格尚未通过。

下一步按负责人已确认的“工作区互不串扰、正常联网开发、成熟组件优先”收敛合同和
实现，再完成普通安装包的真实模型任务。没有修改冻结设计、生成自认证资格或切换
生产开关。
