# Workspace 初始化默认执行能力：设计落地一致性复核

日期：2026-11-20  
复核范围：`ACCEPT_WORKSPACE_DEFAULT_EXECUTION_CAPABILITY` 固定 landing package  
提案：`docs/proposals/2026-11-20-workspace-default-execution-capability.md`  
提案 SHA-256：`8503d5c2663d3098171c57646b78a8408d5f1a28dc7f3cf3a37f2181fddaed66`  
决定记录：`docs/decisions/2026-11-20-workspace-default-execution-capability.md`

## 复核结论

设计 landing 一致性通过。已接受的语义是：合格 Linux 隔离环境完成精确资格检查
后，Project/Workspace 初始化自动建立当前 Workspace ResourceBoundary 内的
`WorkspaceWrite × Enabled` 基础执行能力；普通 Work 和 daemon 重启不重复申请。
这条事实使用 `SystemInitialization` 来源，不伪造 Human/Parent Grant，不创建第二
个人类身份，也不扩大到 FullAccess、TrustedLocal、跨 Workspace 或敏感外部副作用。

这只是设计一致性结论，不是实现、安装资格或发布资格结论。

## 已复核的 owner 文档

- `docs/design/00-problem-goals.md`：目标层明确 Linux 单用户 coding agent 的默认能力和边界。
- `docs/design/01-scenarios.md`：S1–S4 明确普通 Work/重启不重复授权、未资格化时先修复，以及历史 Windows `Disabled` 条款不覆盖 Linux。
- `docs/design/02-system-design.md`：Workspace 是能力主体，默认事实受资源边界、ownership、provider qualification 和 revocation 约束。
- `docs/design/03-detailed-implementation-design.md`：初始化、精确 Execution/Episode policy binding、fail-closed 和同一 Work retry 合同一致。
- `docs/design/implementation/P1/**`：Command、Port、SQLite durable fact 与初始化幂等语义一致。
- `docs/design/implementation/P4/**`：默认 standing capability 不替代 effect admission、敏感动作审批或实际沙箱 enforcement。
- `docs/design/implementation/P5/01-composition-root.md`：初始化资格门位于 composition，不能回退到 host/fake execution。
- `docs/design/implementation/P12/**`：transport/resolver 不能创建隐藏 grant；Web 提供修复状态和同一 Work retry。

## 发现并处理的冲突

1. Scenarios v1.9 原文把 `Disabled` 写成无平台区分的“首发默认”。现已明确该条款是历史 Windows candidate；合格 Linux 首发由 2026-11-20 supplement 明确采用 `NativeOsSupportedOnly`。
2. P5、P12 和 P4 原有的 per-Work human policy 语义已限定为能力扩大、撤权恢复、弱化隔离或显式策略变化；普通 coding Work 不再经过重复 Workspace 授权表单。
3. 当前状态文档仍可能记录未资格化机器的实际 `Disabled`。已改写为安全失败状态，而不是 Linux 合格发行物的产品默认。
4. `AGENTS.md`、README、FIRST-RELEASE、CURRENT_STATE、PROJECT_INTENT、ARCHITECTURE、KNOWN_PROBLEMS、OPEN_QUESTIONS 和 RELEASE_PROGRESS 已注明“设计已接受但实现/发布未完成”。

## 未被本次 landing 宣称完成的内容

- Workspace 初始化时的生产建账和事务接线；
- 撤权、用户恢复、Child 边界和 Parent ceiling 的完整发行物验证；
- 阻塞 Work 的同一 Work retry 真实 UI/Runtime 闭环；
- Linux provider、`WorkspaceWrite × Enabled`、网络 broker 和 Native process 的 Supported 资格；
- 同一干净发行物上的真实文件、命令、构建、测试、联网、独立 Verification、Acceptance、重启和发布验收；
- preserved user database 的升级支持。

## 静态复核方式

- 检查提案 SHA-256 与引用一致；
- 扫描设计链中旧提案 SHA，结果为无残留；
- 扫描修改过的设计 Markdown 围栏，结果为平衡；
- 执行 `git diff --check`，结果通过；
- 未运行代码测试，也未修改源码实现。
