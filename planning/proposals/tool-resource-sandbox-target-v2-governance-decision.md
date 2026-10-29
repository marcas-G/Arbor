# Tool Resource / Sandbox Target V2 治理决定

**Status:** ACCEPTED / IMPLEMENTATION AUTHORIZED

**Accepted:** 2026-10-02，人工治理在完整设计讲解后明确指令 `执行`

**Closes:** `DOGFOOD-DG-03`（以机械验证和真实 dogfood 为最终关闭门）

## 决定

1. `ResourceAddress` 只描述现实资源与权限边界，不再作为模型工具路径。
2. Execution 从 Workspace ResourceBoundary 确定唯一主文件系统资源，并绑定为
   逻辑 mount `workspace`。
3. 模型文件工具只使用 `{ mount, path }`；`path` 是 mount-relative portable
   path，绝对路径、反斜杠、盘符、控制字符和 `..` 全部 fail closed。
4. Sandbox adapter 独占现实资源到执行路径的映射；模型与 Provider 不看到
   host path。
5. managed GitWorktree 是默认可写代码 mount。`LocalTrusted` 可直接绑定；不
   宣称它是 OS 安全边界。非可信自动执行必须使用 hardened provider。
6. `read/list/patch/shell@2` 取代新 turn 中的 v1。`patch@2` 支持缺失文件的
   纯插入创建和幂等重放。
7. executable handler 从当前可见 catalog 精确解析版本，禁止硬编码。
8. 普通路径/IO错误成为 `ExpectedFailure`；真实 defect 和 effect ambiguity
   保留 P9 recovery/reconciliation 语义。
9. 绑定依据必须包含 ResourceBoundary/Environment freshness；漂移时不猜测
   host prefix，直接 fail closed。
10. 实施必须由原隔离 release-validation Work 完成真实 list/read/patch/shell
    与 CompletionClaim 后才能关闭 Design Gap。

## Owning contract landing

- `docs/design/03-detailed-implementation-design.md` v1.25
- `docs/design/implementation/P4/04-sandbox.md`
- `docs/design/implementation/P4/08-minimal-tools.md`
- `docs/design/implementation/P11/12-sandbox-handoff.md`

## 授权范围

本决定同时授权 Port、Tool Runtime、Sandbox adapters、tool catalog、Model
Context/turn-profile invocation identity、测试与生产 composition 的必要实现；不
授权新增外部资源类型、改变 Workspace/Work/Execution 领域语义或放宽 shell
权限。
