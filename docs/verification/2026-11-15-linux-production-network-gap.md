# 普通 Linux 命令装配的实际阻碍与准备结果

日期：2026-11-15。基线：当前 `e7065a7c` 加未提交工作树；不是发布资格。

## 本机实际结果

- `/usr/bin/bwrap` 为 bubblewrap 0.12.0，`/usr/bin/systemd-run` 存在，
  `systemctl --user is-system-running` 返回 `running`。
- 当前主机 kernel build 为 `6.12.115+deb13.1-amd64`。
- 未找到 podman/docker/runc/socat；未为调查安装系统软件，也未请求 sudo。
- 直接调用当前构建的普通 `probeLinuxBwrap({platform: process.platform})`，没有
  注入 probe/capability，返回 `Experimental / RequiredPrerequisiteUnavailable`，
  profiles 和 networkModes 为空。默认 probe 不会因工具已安装而自动资格。
  这里没有注入实际 prerequisite runner；该返回值不证明主机本身缺少 namespace
  或 cgroup 控制，不能据其要求用户盲目重装工具。
- 当前系统真实 DNS 对 `ipv4only.arpa` 的 A 返回 192.0.0.170 和 192.0.0.171，
  AAAA 返回 ENODATA；直接调用生产 `discoverRfc7050Prefixes` 返回 null，没有
  注入 discovery 或解析器答案。当前 broker 将这种结果作为
  `sandbox/pref64-unknown` 拒绝；不能把 AAAA 缺失当作已取得的 NoDns64 资格。
- 普通 composition 的两个 `nativeOsSupportedTupleAvailable` 仍固定为 false。
  因此直接改其中一个布尔值既不能补齐另一处门禁，也不能得到可运行的正式联网命令。

这些结果表明阻碍并非缺少 curl 或项目模型配置。旧的全网络证明要求、Linux
首发允许范围、真实隔离/进程/服务能力及受信资格装配都需要显式对齐。

## 已准备的设计包

`docs/proposals/2026-11-15-linux-workspace-network-v2.md` 将负责人已明确的优先级
转为固定行为：工作区互不任意访问、内部 TCP 测试、普通客户端 HTTPS/TLS、没有
临时 CA、没有完整正文审查承诺。具体 CONNECT 授权限制、IPv4 出站范围及保留的
权限/停止/副作用恢复均明确写出。单个联网命令不被说成完整工作区服务或最终交付。

配套目录含 prepare.py、landing.patch、manifest.json 和 preparation-check.json。
补丁覆盖 13 份 owning documents；顶层提议修订为 Scenarios 1.11、SD 1.26、
DID 1.66，均尚未成为当前版本。固定规则、controls、Command/snapshot/receipt
版本兼容和受信 Linux 材料均有精确条款；普通服务登记/跨命令复用/预览仍需另行
闭合合同，未伪装为已经解决。

检查结果：`git apply --check` 通过；在临时副本实际应用后，13 个 postimage
摘要全部匹配；原 13 个设计文件仍与准备前摘要一致。规则 JSON 示例均可解析，
版本/字段不冒充旧 V1 的 Pref64/TLS/重定向保证。该检查属于准备材料自审，
不是独立 post-landing 一致性审查，不是运行资格。

没有修改本轮生产代码、冻结设计或用户数据，没有启用命令、签发 Supported 或发布。
目标保持完整：后续仍须普通安装包、外部真实模型、文件修改、联网构建测试、两个
正式 Workspace、停止恢复、查看改动、独立验证、人工验收和数据恢复证据。
