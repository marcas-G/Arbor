# P13 — 06 Acceptance

**Owns:** P13 验收标准与 completion 定义
**Baseline:** DID v1.15 G1–G4 · DID v1.17 TR-WPU-A visual successor · contracts `00`–`05`

## 1. End-to-end acceptance story

一个操作者在浏览器中：打开同源托管的 Arbor Web → 提供 token 认证 →
看到 responsibility tree（含 subtree attention 冒泡）→ 下钻某 workspace
detail → 看到其 pending formation proposal → 以 RecordDecision 表单 Approve
（绑定 exact proposal revision）→ 收到 Committed receipt → 稍后经 WS
invalidation 看到树/详情 refetch 出新 child workspace → 对其 outcome 以
AcceptWorkOutcome 表单验收 → 对仍在执行的 activeExecution 以
StopExecution 紧急停止控件（显式确认）中止 → 全程未见 SelectCurrentWork
选择控件与任何 chat 输入框；拔掉 token 后所有命令得到 `unauthenticated`
Problem 呈现。

## 2. Exit criteria matrix

| # | Criterion | Evidence（机械化） |
|---|---|---|
| EC-1 | `pnpm check` 全绿（含 web build + web tests 并入根编排） | root `pnpm check` exit 0 |
| EC-2 | `apps/web` 零禁依赖（硬要求 1） | architecture test：按 `@arbor/*` 白名单实现——`@arbor/api-contracts` 唯一允许；禁止 `@arbor/domain` / `@arbor/application` / `@arbor/projection-runtime` / `@arbor/adapters/*` / `@arbor/ports` / 其余一切 `@arbor/*` 与 `apps/*` 源码引用 |
| EC-3 | 9 个 frozen view 均有 fixture/render coverage（硬要求 2） | render tests：9 view × (typical / minimal / unknown-enum) |
| EC-4 | Problem DTO 主要 typed failures 明确 UI rendering（硬要求 3） | render tests：六 category（unauthenticated/forbidden/not-found/invalid-request/stale/其他503）+ `TerminalRejected` 内联态 |
| EC-5 | WS invalidation → server refetch，不自行 replay（硬要求 4） | 单测：帧处理只触发 refetch、cache 无事件性写入；e2e：invalidation 后数据来自 server 响应 |
| EC-6 | 命令一律经 `/commands`，暴露集合 == `02` Human-actionable 七项（硬要求 5） | UI command catalog 常量 + 机械测试：表单可达命令集合相等；architecture test：写路径白名单（`01` I3） |
| EC-7 | `SelectCurrentWork` 无人工选择控件（`02` §4） | 测试：runnable/current 呈现组件不含 command 发起；catalog 不含该 type |
| EC-8 | `SendMessage` 无 chat 控件（`02` §5） | 测试：transcript/detail 视图无消息输入；catalog 不含该 type |
| EC-9 | Search 保持 out-of-v1（硬要求 6） | 测试：无 search 端点调用/输入；architecture test：无 `/search` 类路径 |
| EC-10 | design tokens 单一来源、组件无字面量 | token 模块唯一 + 扫描测试（色/字号字面量仅存在于 token 文件） |
| EC-11 | dev proxy 与 prod 同源托管可用 | e2e：daemon 托管 dist，浏览器冒烟（story §1 路径）+ `/assets/*` cache 头 |
| EC-12 | 前端依赖 exact pin、无未批准依赖 | 依赖清单测试：pin 集合与 `05` §4 一致；无额外 runtime 依赖 |
| EC-13 | TR-W1/TR-W2 落地且传输语义未漂移 | WS 帧测试（invalidation 帧形状、无 payload）；static 服务测试（无 API 语义）；P12 `10` 既有测试不动绿 |
| EC-14 | 无 open P13 Design Gap | gap gate（planning 复核） |

## 3. 完成定义

```text
P13 COMPLETE = EC-1..EC-14 全 PASS
P13 FORMALLY CLOSED = result record（planning/results/P13.result.md）
                      + AGENTS.md / 合同索引状态同步 + 工作区 clean
```

## 4. Phase 完成阻塞项（closing 前保持显式）

```text
1. Command → UI exposure policy matrix（`02`）落地为机械可验的 UI catalog
2. WS invalidation（TR-W1）双向闭环：server 推送 + client refetch
3. 同源托管（TR-W2）生产可用
4. design token system（`04`）全组件覆盖
5. 六条硬要求全部机械化 evidenced（EC-2/3/4/5/6/9）
```

## 5. Must Not Decide

- 不决定 P14 chat 语义；
- 不决定新 view / Search；
- 不决定矩阵类别变更（U-2）。
