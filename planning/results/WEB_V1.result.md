# Web v1 Result Record — Arbor Web v1（Product UI）

**Phase:** Web v1（承接 P13 protocol prototype；合同 = `planning/proposals/web-v1/01-ui-ia-design.md` + `02-dev-plan.md` FROZEN）· **Date:** 2026-09-23

## Verdict

**COMPLETE — FORMALLY CLOSED.** W-00..W-09 全部完成；G1/G2/G3 三 gate 通过；
§9 十三条不变量全部机械化 evidenced；`pnpm check` 全绿。

## Gate 结果

| Gate | 内容 | 结果 |
|---|---|---|
| G1 | IA/Shell 无头浏览器走查（21/21：登录/shell/新鲜度/project-scoped URL/六导航/F5 深链→登录门+URL 保留+记忆重定向/移动 tabbar+更多 sheet/断开）；顺带修复 TR-W2 SPA fallback 缺失 | PASS |
| G2 | 七命令面 × 真实 daemon（10/10：CreateProject 全流程 Committed+自动接线、Zod 空值拦截零 fetch、队列空态、上下文治理 disabled 门槛、缺数据容错） | PASS |
| G3 | 收口走查（11/11：五路由+workspace 深 tab 的 deep-link round-trip、树/关注事项只读、cost unknown≠0、刷新回登录门、移动五 tab）+ 全量 suites | PASS |

## 任务完成

| 任务 | 交付 | 状态 |
|---|---|---|
| W-00 | 基线切换（exact pins + TR-B）、project-scoped typed router（round-trip 测试）、**证明③ gov: entryKey 结构化绑定可行**（DecisionCard 可绑定）、**证明④ issuer read-only**（负向测试）、transport 合一 + Query/WS providers | ✅ |
| W-01 | 设计系统组件库（14 组件 CSS Modules + user-event 测试） | ✅ |
| W-02 | AppShell（Rail/Topbar/移动 tabbar/更多 sheet）+ 路由出口 | ✅ |
| W-03 | Overview 三区块（待处理摘要/树顶快照/"Root Workspace 最近活动"钉死文案） | ✅ |
| W-04 | Tree 只读导航（navigate/select/inspect；架构测试锁 9 禁词 + /views-only） | ✅ |
| W-05 | Workspace 头部+五 tab（URL 权威） | ✅ |
| W-06 | Work Detail + 关注事项页（read-only） | ✅ |
| W-07 | Usage（groupBy 三态）+ Settings（issuer read-only/权限/项目/会话） | ✅ |
| W-08 | 待处理队列（结构化绑定决策卡/只读降级/无手填路径）+ 七表单 RHF+Zod + 上下文接线 | ✅ |
| W-09 | 三 gate + 全量收敛 + 本记录 | ✅ |

## §9 十三条不变量证据

1. `apps/web → api-contracts`（type-only）— p13-web-boundaries I1 + EC-2
2. 七命令暴露集 == `02` 矩阵；无 SelectCurrentWork/SendMessage/Search — catalog 测试 + no-forbidden-controls + p13-closure 锚点
3. WS 只 invalidate；无乐观更新/浏览器聚合 — WSInvalidationProvider 单效 + ws-invalidation-query（数据来自第二次 server 响应）+ usage 无合计断言
4. Problem 六 category；401 全局门；TerminalRejected 内联可重提 — problems-render + session gate 测试
5. 未知枚举 muted 原样；cost Unknown≠0；时间戳原始值 — views-render fixtures + G3 浏览器断言
6. token/actor 纯内存 — session 机械扫描 + G3 reload→登录门
7. 依赖 exact pin（+react-query/rhf/zod/user-event） — dependency-pins（W-00 更新基线集）
8. 全路由带 projectId；Session.projectId 非权威 — api-router round-trip + G3 六 deep-link
9. Tree 只读 — tree-readonly 架构扫描 + G3 页面断言
10. 待处理/关注事项边界 — queue 结构化绑定 + attention 零命令断言
11. issuer read-only — issuer-restriction 负向测试（W-00④）+ settings 测试
12. 队列 action target 仅结构化绑定 — queue-proof（严格 fail-closed + summary 永不解析）+ queue-page 测试（不可解析→只读+跳转）
13. "Root Workspace 最近活动"文案 — overview 文案钉死测试（禁"项目最近活动"）

## 最终计数

`pnpm check` = architecture **16 files/99** + core **208 files/1177** +
web **25 files/163**（exit 0）。生产构建同源托管（TR-W2 含 SPA fallback
deep-link e2e）。五项 P13 行为资产测试全程保持绿。

## 记录的偏差（非 Gap）

1. 树缩进待上游 depth-field TR（v1 平铺有序节点卡，P13 起显式记录）
2. Revoke 的 grants 列表无数据源（settings 空态 + 待 transport DTO enhancement）
3. 新建项目的 projection 物化延迟 → 树首查可能 unavailable（RETRYABLE 就地呈现，consumer tick 后自愈；属运行时行为非 UI 缺陷）
4. 走查工具（playwright-core）装于 /tmp，不入仓库 pin 集；G1/G2/G3 脚本存 `/tmp/opencode/p13-smoke/g{1,2,3}-walkthrough.mjs` 可重跑
