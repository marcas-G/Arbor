# Native 中断、独立任务停止与网络超时增量

日期：2026-11-15；`e7065a7c` 加当前未提交修改。
上一阶段的网络候选验证见 `2026-11-15-standard-network-proxy.md`。
本轮仍未获得 ordinary production 资格，未操作保留用户数据库或修改冻结设计。

## 已复现并修复

原 Native adapter 用无取消 finalizer 的 Promise 包装执行。Effect 中断很快返回，
systemd 用户单元内的后台子进程却仍继续运行。真实 bwrap 命令写入 ready 后，在
后台延迟写入 `after-interrupt.txt`；中断后该文件仍生成，反例失败保存在
`.test-results/native-cancellation-20261115/before.log`。

现改用 Effect 的 callback/取消 finalizer，传递标准 AbortSignal，等待监督进程和
broker 清理完成后才结束中断。systemd 按精确 unit 停止整个 control group，保留
`KillMode=control-group`，设置一秒停止宽限期。取消早于 unit 创建时，不会在客户端
仍可能创建 unit 的情况下接受一次 `not-found`。输出溢出、超时或客户端异常也先
进入清理；broker 清理失败不再吞掉，不能转为“尚未发生效果”的 Unavailable。
未增加进程启动白名单，仍仅有原先 systemd-run/systemctl 两处 execFile。

真实反例修复后验证：

- ready 后中断，返回时 `/sys/fs/cgroup/.../cgroup.events` 已为 `populated 0` 或单元
  已回收，后台延迟写入不再发生。
- 两个不同目录的真实隔离调用同时运行；中断 A 后，B 正常完成并写出结果，A 不再
  写入。它证明调用/进程组没有误停，不是两个正式 Workspace 的完整产品验收。
- capability 尚未返回时取消，不发生延迟 spawn。
- broker 清理失败成为缺陷结果，不伪装为普通无效果拒绝。

## 网络错误处理

本轮公网复验出现 Git exit 128：请求停在 GitHub GET，随后客户端报 GnuTLS
连接未正常结束。保留 `network.log`、`network-diagnostic.log` 与相应命令 JSON。
独立 Node HTTPS 连接同一公开 IP 的诊断最终为 ETIMEDOUT；curl 在另一次连接获得
200。这些证据说明公网结果不稳定，不能推断代理以外的唯一原因，也没有通过重试
掩盖第一次失败。

进一步检查确认 ClientRequest 的 setTimeout 不覆盖完整 TCP/TLS 建立阶段。
现新增独立十秒建连/握手期限，保留三十秒数据停滞期限，外层连接期限为三十五秒，
让连接失败优先产生可读的 HTTP 504，而非只断开客户端 TLS。持续有数据的流不受
十秒握手计时器截断，secureConnect 或请求关闭会清理它。

本地真实 TCP 服务故意不完成 TLS 握手，客户端能获得
`504 sandbox/upstream-connect-timeout`。另有本地真实 TLS 上游在响应头前断开，
客户端获得 `502 sandbox/network-unavailable`。没有把公网 Git 的所有失败都归为
本缺陷；新的正例不消除外部网络可靠性问题。

修复后单独重跑公网候选：curl → Git v2 GET/POST → npm 元数据/tarball → 项目
node:test 全部成功，exit 0，无超时/截断。完整 stdout/stderr 位于
`public-after-timeout/native-command-outcome.json`。仍显式使用 T2 capability 与
Pref64/IPv4 解析夹具，不能继承为安装包、真实 Provider 或 T3 资格。

## 本轮验证

证据目录：`.test-results/native-cancellation-20261115/`。

| 检查 | 结果 | 文件 |
| --- | --- | --- |
| Native adapter（显式 native） | 36/36 | `native-final.log` |
| 真实 TLS/HTTP/stream 功能定向 | 11/11 | `streaming-final.log` |
| 公网命令候选修复后定向 | 5/5 | `network-after-timeout.log` |
| 根 TypeScript（含测试） | exit 0 | `typecheck-final.log` |
| 完整架构 | 38 文件、198/198 | `architecture-final.log` |
| 根 lint | 1490 文件通过 | `lint-final.log` |

首次根 typecheck 发现测试 seam 返回的 capability 失去 Native 专用字段；已补显式
字段后通过，原 `typecheck.log` 保留。早期 upstream error 用例曾因 fixture 提前
正常返回而失败，后改为真实 pending 上游再验证；这不作为生产反例。没有重跑完整
核心、Web、release 或安装包旅程，不声称零失败首次运行。

`source-manifest.json` 标识本轮相关文件，不是完整发布身份。前阶段的源码摘要和
日志保持原样，其检查点不能直接移作本轮修改后的完整发布证明。

## 尚需完成

- 从公共 StopExecution/网页按钮到运行中命令取消的链路仍须真实验收。本轮只是修复
  Native 在已经收到 fiber 中断时的行为，不能假设停止按钮已经触发该中断。
- 普通 production 仍没有受信 Supported tuple，默认 Disabled；没有签发自认证资格。
- 共享服务、后续命令进入同一工作环境、两个正式 Workspace 的联合运行及停止/重启
  仍未交付。本轮没有用两个调用冒充整个父子 Workspace 协作。
- 实际 discovery、精确网络合同和受信装配、普通安装包/模型任务仍开放。
