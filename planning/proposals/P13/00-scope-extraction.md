# P13 提案 — 产品 Web 界面（完整前端包）：Scope Extraction

**状态**: 裁决已落（GQ1=A / GQ2=B / GQ3=A / GQ4=默认确认，2026-09-23）；
设计闭环完成：DID v1.15 + `docs/design/implementation/P13/**` FROZEN
（独立评审两轮 Blocking=0）。本文件降级为历史研究记录。
**基线**: DID v1.15 · System Design v1.3 · api-contracts（P10 `05` frozen）· P12 `10` transport shells
**日期**: 2026-09-23

## 0. 动机

P0–P12 完成后系统无可供终端用户使用的产品界面：P12 `10` 的 web shell 是
**合同壳**（DTO JSON island，明确 "no view semantics"），CLI 是 admin/ops 面。
冻结场景 S1–S4 要求用户可感知行为（观察 Agent Tree、下钻、确认划分、纠偏），
当前仅能通过裸 HTTP/WS 端点满足。产品缺口 = **浏览器瘦客户端渲染层**。

参考模式（opencode）：server 唯一真相 + REST + 事件流 + 瘦客户端
（TUI/Web/IDE 均无语义）。Arbor 已有对等地基，缺的正是 opencode 的
`packages/web` 对应物。

## 1. 已冻结的地基（不改动）

| 面积 | 冻结位置 | 内容 |
|---|---|---|
| 视图语义 | P10 `05` / api-contracts `views.ts` | 9 视图: responsibility-tree, attention, workspace-detail, current-work, verification, dependency-view, transcript, usage, inbox-view |
| 传输绑定 | P12 `10` | `POST /views/:view`、`POST /commands`、WS、Problem DTO、auth→Authority Resolver |
| 命令面 | domain/application | ExternalCommandEnvelope 逐字转发； Authority Resolver 裁决 |
| 禁止项 | P12 `10` §2 | Search = out-of-v1 deferral；shell 不发明查询/索引语义 |

## 2. P13 候选边界（待 GQ 裁决后定稿）

**Owns**: 浏览器客户端包的信息架构/交互/呈现；DTO→UI 组件映射；WS 订阅与
视图刷新；命令表单与 Problem 呈现；前端构建/打包/静态服务接入。

**Must Not**: 不新增视图语义；不重解释 DTO；不经 `/commands` 之外的路径
变更状态；不实现 Search；不内嵌 Authority 逻辑（凭据只交给 transport）。

## 3. 待裁决 GQ

- **GQ1 技术基线扩展**（DID §14 变更）：引入前端构建链。候选
  A=Vite+React（opencode 同路线）；B=Vite+SolidJS；C=Lit/无框架 WebComponents。
- **GQ2 v1 交互范围**：A=只读观测（9 视图+WS 实时）；B=观测+治理命令
  （RecordDecision/Steer/Assign/Select/Complete/StartVerification 表单）；
  C=chat-first 全量（B + 主工作区对话面，即 transcript 双向化）。
  注：C 需上游确认"人→Main Agent 消息注入"的冻结命令语义是否存在缺口。
- **GQ3 视觉语言**：A=继承旧 console 植物学纸面风格（paper/leaf/serif）；
  B=全新设计语言。
- **GQ4 包位置与交付**（默认提案，随合同冻结确认）：新包 `apps/web`；
  生产态由 single-workspace 生产 daemon 嵌入静态服务（同端口）；开发态
  Vite dev server + 反向代理。

## 4. 风险与开放点

1. chat-first（GQ2-C）可能触发上游设计缺口（人机对话命令语义）→ 需 gap 流程。
2. 前端依赖进入 workspace（pnpm）→ 基线锁定策略需在合同中固定版本。
3. WS 事件→视图失效映射规则属 P13 拥有的呈现语义（不触碰上游）。
4. 权限呈现：AuthorityDenied/Problem DTO 已冻结，直接渲染即可。
