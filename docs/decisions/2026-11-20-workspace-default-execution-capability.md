# 决策：Workspace 初始化默认执行能力

日期：2026-11-20  
决策状态：ACCEPTED  
决策人：项目负责人

## 决策内容

负责人明确要求：本机单用户 coding agent 的基础能力不应被设计成每个任务都
重复申请的特殊权限。Workspace 初始化时，在 Linux 隔离执行环境已安装并通过
精确资格检查的前提下，自动具备当前 Workspace 资源边界内的文件读写、本地
命令/构建/测试和受控联网能力。

负责人明确反对的行为是：先创建 Work，再因缺少基础 Workspace 能力而阻塞，
然后让用户手动完成一层复杂的“授权此工作区”流程。普通 Work 和 daemon 重启
不应重复申请这组能力。

初始化默认能力使用系统初始化来源和真实初始化 CommandId 记录，不把
`user:local` 拆成多个身份，也不把初始化事实伪装成 Human/Parent Grant。

对已通过 Linux 隔离环境资格的发行物，普通启动默认采用
`NativeOsSupportedOnly`；`Disabled` 只用于显式停用、回滚或环境不可用状态。

## 边界

默认能力不是无限权限：它只针对当前 Workspace 的 ResourceBoundary，不能访问
其他 Workspace 或宿主任意资源，不赋予 FullAccess、TrustedLocal、sudo 或
部署/发布权限。越界、扩大资源、Child 资源分配、用户撤权后的恢复和高风险
外部副作用仍按既有治理与动作审批处理。

## 采用理由

这同时满足两项要求：

1. coding agent 开箱即可完成普通读写、构建、测试和联网工作；
2. 工作区之间仍由独立 ResourceBoundary、ownership 和 OS sandbox 严格隔离。

## 交付约束

这是设计决定，不代表实现或发行资格已经完成。实现必须先更新 owner 文档和
测试计划，再完成同一源码/发行物基线的浏览器真实验收；不得用自动授予宿主
权限或 fake/test-only 执行器替代。

固定提案：`docs/proposals/2026-11-20-workspace-default-execution-capability.md`
