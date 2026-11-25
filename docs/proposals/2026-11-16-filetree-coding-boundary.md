# 普通项目目录进入隔离 coding 执行边界

日期：2026-11-16  
状态：待人工治理确认；本稿不修改 `docs/design/**`，也不启用新的执行语义。

## 发现

当前产品入口已经允许用户选择任意已登记的本机目录。目录选择合同明确规定：

- 目录以 `FileTree` 资源边界登记；
- 选择目录不会创建 `GitWorktree`；
- 已有目录可以打开并继续使用。

当前隔离策略候选读取仍要求：

- Workspace 存在唯一 active `WorktreeStore` 记录；
- 该记录必须是 `GitWorktree`；
- 该 GitWorktree 必须同时出现在 Workspace 的资源边界和环境解析结果中。

因此，普通目录可以创建项目、读取文件、提交 shell 权限审批，但审批消费后不能生成
隔离策略候选。真实复现使用 2026-11-16 Linux x64 预览包和普通 C 项目：

- Workspace `ws_01a1e222-68e5-760d-8a2e-5d4c6b80b445` 的持久边界是 `FileTree`；
- `worktrees` 没有对应记录；
- shell Executable approval 已为 `Consumed`；
- `tool_invocations.effect_admission_state` 仍为 `NotAdmitted`；
- `agent_loop_step_actions.state` 仍为 `Pending`；
- `/views/workspace-detail` 返回 `projection/unavailable`。

这证明问题位于“已批准 Executable action → SandboxPolicyCandidateRead”之间，
不是模型连接、权限审批或 bubblewrap 执行器本身的失败。

## 与冻结设计的冲突

当前设计同时包含两条语义：

1. 已登记目录可以作为根 Workspace 的 `FileTree` 资源，且不自动创建 GitWorktree；
2. primary writable coding resource 必须是 managed `GitWorktree`，sandbox policy
   candidate boundary 只接受该类型。

两条语义在普通目录的构建、测试和 shell 场景下不能同时满足。实现层不能通过伪造
`WorktreeStore` 行、把 FileTree 改写成 GitWorktree，或回退到宿主机执行来绕过冲突。

## 建议的产品语义

将“可进入隔离执行的 primary coding resource”定义为：

- `GitWorktree`，或者
- 已通过 host directory admission、ownership activation 和 environment
  observation 的 `FileTree`。

两者都继续绑定同一个 Workspace ResourceBoundary。Linux Native provider 仍必须：

- 只把该已准入资源映射到沙箱的 `workspace` mount；
- 保留现有文件路径、ownership、审批、provider qualification、进程限制和网络策略；
- 禁止访问宿主机其他路径、其他 Workspace 和宿主机网络接口；
- 在没有匹配 Supported qualification 时拒绝执行；
- 让同一 shell invocation 在策略提交后恢复，不生成第二个 action，也不重复消费审批。

`GitWorktree` 的现有 P11 记录和隔离规则保持不变；这只是为已准入普通目录增加
同等的 boundary evidence，不把普通目录冒充为 Git worktree。

## 实现范围（待接受后）

1. 将 sandbox candidate boundary snapshot 的 primary resource 证据改为明确的
   `GitWorktree | FileTree` 受支持类型，并保持资源地址、解析区域、ownership 和
   Workspace 修订的精确绑定。
2. 让 boundary resolver 对普通 FileTree 选择产生可验证的 primary region；对
   GitWorktree 继续使用现有 WorktreeStore 事实，不从路径推断 Worktree 身份。
3. 更新 sandbox boundary producer、candidate builder 和 policy decision preparation，
   使 `WorkspaceWrite × Enabled` 的 Linux Supported candidate 可用于普通目录。
4. 保持 Executable approval 消费后的原 action、invocation、RecoveryBinding 和
   action identity 不变；提交 policy 后只恢复该 action。
5. 添加普通目录的单测、真实 daemon/process 测试和发行包浏览器旅程：批准 shell →
   选择策略 → 执行 `make`/测试 → 失败可见 → 修改文件 → 重跑 → 停止/重启恢复。
6. 同步维护当前状态和已知问题文档；在全部证据通过前，不宣称 Linux coding agent
   已达到发行资格。

## 不应采用的替代方案

- 在用户选择的目录中隐式执行 `git init` 或创建 worktree；这会修改用户项目，并
  改变已接受的目录选择行为。
- 为普通目录插入一条虚假的 `worktrees` 记录；这会把路径标签当成 P11 事实。
- 因候选不可用而退回 TrustedLocalUnconfined 或宿主机 shell；这会违反严格隔离。
- 让浏览器或命令 payload 直接传入绝对路径；这会绕过已冻结的 `workspace` mount
  和 ResourceBoundary 绑定。

## 接受后的验收条件

普通 FileTree 项目必须完成以下闭环，且每项使用公共用户路径：

1. 真实模型提出 shell；用户看到精确命令并批准；
2. 用户看到并提交隔离策略；
3. 原 shell action 恢复并仅执行一次；
4. `make`、测试和联网依赖在同一 Workspace 沙箱中真实运行；
5. 文件修改只落在已选择目录；其他目录和其他 Workspace 不可访问；
6. daemon 停止/重启后保留正确的 action、结果和工作区状态；
7. 独立 Verification 与人工 Acceptance 能看到真实结果。

在人工治理接受本稿前，当前状态应继续记录为“普通目录可选、可读，但 shell/构建/测试
仍未完成”，不能把已有审批通过误报为命令执行通过。
