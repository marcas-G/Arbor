# Arbor Web v1 — Development Plan（FROZEN）

**状态**: FROZEN（随 01-ui-ia-design.md 8 点修订裁决冻结；implementation 授权另行下发）
**模式**: bounded-parallel（沿用 P11/P13 执行规则；主会话拥有 gates/集成）
**前置**: W-00 开工条件 = 本计划 + 01 设计方案冻结（已满足，见文末判定）

## 任务 DAG

| ID | 任务 | 交付 | 依赖 | 并行度 |
|---|---|---|---|---|
| W-00 | 基线切换 + 三项前置证明 | ① 新依赖 exact pin（+@tanstack/react-query、react-hook-form、zod、@testing-library/user-event）+ EC-12 pins 清单更新；② **projectId-in-URL typed route baseline**（§2.1A 全套路由 + Session.projectId 非权威化）；③ **Governance Queue action-target feasibility proof**：机械验证 frozen inbox DTO 能否结构化恢复 proposalId+revision → 按 §2.7 frozen 规则二选一落地（能→DecisionCard 绑定；不能→只读条目+跳转，无假 action）；④ **Grant issuer read-only restriction proof**：issuer=authenticated principal 的 UI 只读实现路径 + 负向测试基线；⑤ `api/transport.ts` 合并（两 fetch 层→Query fetcher，行为测试随迁）；⑥ `api/router.ts` typed history router；⑦ QueryClient+WS Provider 骨架 + session 行为迁移；⑧ TR-B 基线取代记录 | — | 主会话 |
| W-01 | 设计系统组件库 | tokens 增补 + CSS Modules 组件（Badge/Button/Card/Field/Empty/Tabs/Table/KeyValue/Dialog/Toaster/FreshnessChip/StatusBadge）+ EC-10 扫描延续 + 组件测试 | W-00 | 1 agent |
| W-02 | AppShell + 路由 | Rail/Topbar/响应式骨架、**project-scoped 路由层级**（/p/:projectId/**）、项目切换、FreshnessIndicator、Toaster 接线、移动底部 tab（概览/树/待处理/关注/更多）；**检查点：IA 走查（用户，blocking）** | W-01 | 主会话 |
| W-03 | Overview 页 | 三区块组合（待处理摘要/树顶快照/"Root Workspace 最近活动"文案）+ 测试 | W-02 | ┐ |
| W-04 | Tree 页（**只读导航**） | 节点列表/深度控制/mini-detail；**明确无快捷治理 mutation**（无纠偏/停止入口，架构测试锁定 Tree 模块无 command 发起） | W-02 | ├ 3-way 并行 |
| W-05 | Workspace 页 | 头部 + **五 tab**（概要/依赖/验证/对话记录/收件箱）+ 上下文治理动作位 | W-02 | ┘ |
| W-06 | Work Detail + 关注事项页 | 验证面板/治理动作/read-only 事故清单（稳定 dedup 引用） | W-05 | ┐ |
| W-07 | Usage + Settings 页 | groupBy/权限面板（issuer read-only + 负向测试）/项目面板 | W-02 | ├ 2-way 并行 |
| W-08 | 待处理队列 + 七命令对话框 | RHF+Zod 表单（预分配/重试同 id/回执/双确认延续）、队列聚合；**只实现 W-00 已证明可结构化绑定的 action cards**（不承担 entryKey 可解析性的"发现"职责——不可绑定即按 frozen 规则只读展示） | W-06 | 主会话（shared contracts） |
| W-09 | 收口 | 迁移测试全绿（fixtures/render/problems/no-forbidden/pins）+ 新页面测试 + daemon e2e 复验 + §9 十三条不变量机械化复验 + prototype 残留清理 + 文档/结果记录 | W-03..W-08 | 主会话 |

## Gates

- G1（W-02 后）：IA/Shell 用户走查（blocking）
- G2（W-08 后）：命令面全量走查（七表单 × 真实 daemon）
- G3（W-09）：`pnpm check` 全绿 + §9 不变量（含新增 8–13 条）机械化复验 + 结果记录

## 保留资产安全网（贯穿）

W-00 起每批收敛跑：p13-web-boundaries、p13-closure、invalidation-client、
dependency-pins（新清单）、no-forbidden-controls、daemon e2e——五项行为资产
任何时候不得红。

## 风险与开放点

1. ~~entryKey→proposalId 可解析性~~ → **已前移至 W-00 前置证明**（frozen 二选一规则，见 §2.7/§5）
2. Overview/待处理队列的并行查询扇出（TanStack 批处理；深树 depth 限制）
3. 树缩进仍待上游 depth-field TR（v1 呈现限制照旧记录）
4. 新依赖入 lockfile 需 exact pin 审计（W-00）

## W-00 开工条件判定

- [x] 技术基线冻结（用户 ruling）
- [x] IA 8 点修订落地（本文档 + 01 §2.1A/2.2/2.3/2.4/2.6/2.7/2.10/§5/§7/§9）
- [x] focused review Blocking=0（FREEZE-CONFIRMED，8/8 CLOSED，2026-09-23）
- [x] 两份文档 FROZEN（Web v1 product contract）
- [ ] implementation 授权（另行下发；授权即入 W-00）
