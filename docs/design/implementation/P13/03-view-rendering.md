# P13 — 03 View Rendering & Problem Presentation

**Owns:** 10 个 frozen view DTO 的呈现契约、fixture/render coverage、Problem 呈现
**Does not own:** view 语义/形状（P10 `05` / api-contracts，frozen）

**FT-DG-02 additive rendering amendment (2026-10-08):** render the
P10-owned `work-detail` DTO; this does not reopen P13 or alter command,
transport, or canonical lifecycle semantics.

## 1. 通用规则

1. 渲染输入**只有** `ViewResponseMap[V]` DTO（+ Problem）；组件不得接受
   其他来源的数据构造 view 内容（`01` I2）。
2. DTO 字段语义按 api-contracts 注释原样呈现；**未知枚举值**（如未来的
   `WorkspaceStatusLabel` / `AttentionSource` / severity 扩展）原样展示 +
   muted 样式，不映射不丢弃（`01` I5）。
3. `null` / `undefined` 可选字段 = "未发生/不适用"，呈现为空位，不呈现为
   零值或 false。
4. 时间戳（ISO string）本地化呈现 + 原始值可查（title/展开）。

## 2. 十视图呈现契约

| ViewId | 主呈现 | 关键组件语义 |
|---|---|---|
| `responsibility-tree` | 缩进树（root 顶部；depth 参数控件）；节点卡 = name + `WorkspaceStatusLabel` 徽章 + `subtreeAttention`（attention/actionRequired 计数，>0 高亮）+ `currentWork.objective` 摘要 + `usageSummary`（tokens/cost；cost=`Unknown` 原样呈现 "unknown"，≠0） | 节点点击 → `workspace-detail` 下钻（本文件 §4 导航） |
| `attention` | 按 severity 分组列表（ActionRequired 在前）；行 = source 徽章 + summaryRef + occurredAt + target 链接 | 行点击 → 目标 workspace 下钻；`AttentionSeverity`/`AttentionSource` 未知值原样（I5） |
| `workspace-detail` | 单 workspace 全景：responsibility 摘要、boundary、currentWork、pendingWorks 列表、executionSummary、dependencies 表（state 徽章 + satisfiedBy 链接）、inboxUnconsumed 计数列表、verification（criteriaResults 表：required 标记 + verdict 徽章 + evidenceRefs；acceptance 块）、auditTimeline（sequence + eventType + at，mono） | 各 ID 链接跳转对应下钻；`pendingWorks` 行**不是**选择控件（`02` §4）；activeExecution 卡带"停止该执行"紧急控件（`02` §2 StopExecution，显式确认） |
| `work-detail` | 精确 `{projectId, workspaceId, workId}` 的只读 Work 页面：objective/why/completionExpectation、revision、canonical lifecycle；有精确绑定时呈现 Acceptance 与 PASS Verification 摘要；有当前 Blocked WorkEpisode 时显示每个 safe denial category、bounded request/observation refs 与恢复指导 | `Open + acceptedResult` 呈现“已验收、待完成”；`Completed` 呈现“已完成”；`Cancelled` 呈现已取消；Blocked explanation 仅来自精确 WorkBlocker/settlement facts；证据明细仍由 Verification view 提供；不从 Workspace/Session 推断生命周期 |
| `current-work` | 单卡：objective + status + activeExecution（executionId + admittedAt）；`null` → 空态"无当前工作" | 空态不得提供"去选择"动作（`02` §4） |
| `verification` | criteriaResults 全表 + evidenceRefs + acceptance 状态块 | verdict 徽章三态 + 未知值原样 |
| `dependency-view` | 依赖行表：consumer → binding → state → satisfiedBy；project 范围与 workspace 范围两个查询形态（DTO req 二选一） | state 徽章；行内无任何变更动作（变更走 `02` 矩阵，v1 无 dependency 类 Human-actionable） |
| `transcript` | 游标分页列表：kind 徽章 + summaryRef + at；`nextCursor` → "更早"分页 | 只读；不提供输入框（chat = P14+，`02` §5） |
| `usage` | groupBy（workspace/subtree/project）切换 + 行表（tokens/cost/turns） | cost `Unknown` 原样（P12 `04` TR-5）；合计只在 server DTO 提供时呈现，**不在浏览器聚合**（I2） |
| `inbox-view` | unconsumed 列表：kind + summary + watermark；消耗态由 server 呈现于后续 refetch | 无"标记已读"类动作（无对应 Human-actionable 命令） |

### Fixture/render coverage（硬要求 2）

每个 view 至少 3 个 fixture：**typical**（全字段）、**minimal**（仅必填/
空集合/`null` 可选）、**unknown-enum**（含未识别枚举值）。render test
断言：关键字段出现、未知值原样、空位语义（§1.3）。

## 3. Freshness 与 refetch

1. 初次进入视图：普通 query；收到 invalidation（TR-W1）后 refetch 同一
   `(viewId, request)`，可附 `FreshnessRequirement` barrier（P10 freshness
   机制，请求形状由 api-contracts/transport 定义）。
2. `projection/stale` Problem（category `stale`）→ 呈现"数据滞后"态 +
   重试动作；不静默吞掉（`03` §5）。
3. 视图卸载即取消在途请求；重入时以 server 响应为准（无本地合并）。

## 4. 导航与信息架构（v1）

```text
顶栏：brand + project 切换（projectId 输入/记忆）+ token 状态
主导航：Tree · Attention · Usage
下钻：tree/detail/attention → workspace-detail；detail 内 ID 链接
      → work-detail / verification / transcript / dependency-view / inbox-view
命令区：detail/attention 上下文中的 governance 动作
      （RecordDecision / SteerWork / AcceptWorkOutcome / StopExecution /
       Grant|RevokePermission / RetryVerification；`02` §2）
```

Blocked Work Detail itself does not provide an Agent retry or projection-clear
button. Recovery guidance points to the existing human/Parent `SteerWork`
boundary or later WorkEpisode; `resolve_work_blocker` is a WorkEpisode-only
control and requires exact later successful-action evidence.

路由为纯 UI 状态（URL path/query），不属于任何 server 语义。

## 5. Problem DTO 呈现（硬要求 3）

按 `category`（frozen Problem 词汇）给出**明确 UI treatment**；`code` /
`safeDetails` / `correlationId` 原样展示于详情展开：

| category | HTTP | UI treatment |
|---|---|---|
| `unauthenticated` | 401 | 全局"未认证"态：token 输入/重连；屏蔽内容区 |
| `forbidden`（含 `authority/denied`） | 403 | 明确"权限拒绝"面板：code + `safeDetails.reason`；**不做**客户端预权限判断 |
| `not-found` | 404 | "对象不存在"空态 + 返回导航 |
| `invalid-request`（含 `transport/*`、`projection/invalid-request`） | 400 | 表单错误态 / 请求构造错误提示；`safeDetails` 展开 |
| `stale`（`projection/stale`） | 409 | §3.2 |
| 其他（`projection/unavailable` 等） | 503 | "服务不可用"态 + 重试（按 `retryDisposition` 呈现可/不可重试） |

- `CommandReceiptView` `TerminalRejected` → 命令面板内联错误（rejection +
  correlation 信息），表单保持可改可重提（新 commandId）。

## 6. Must Not Decide

- 不决定 view 语义/新 view/Search；
- 不决定 status label / severity 的再映射表（原样呈现）；
- 不决定命令结果之外的业务推断（如"rejected 后应该……"的下一步编排）。

## 7. Verification

`06` EC-3（10×3 fixtures render coverage）、EC-4（六 category Problem
render tests + TerminalRejected 内联态）。

## Accepted Native OS Sandbox rendering

Render P10's optional `WorkspaceDetail.executionSummary.sandboxPolicy`
fields as the exact current variant/profile, provider where applicable,
network mode where applicable, policy revision, expiry and
Committed/Unavailable/NeedsDecision state. Render the
`SandboxProviderUnavailable` Attention row with its fixed safe summary and
Execution Workspace target. Do not display host paths, provider diagnostics,
network destinations, environment values or operator-config secrets. Render
`FullAccess` as an explicit high-risk choice requiring separate confirmation;
never infer or select it from provider failure. Render the existing
`sandbox/provider-unavailable` 503 Problem as the standard unavailable state
and keep the Work visibly blocked; no browser retry may bypass the human
command route.

## Accepted V21 derived RecoveryBinding Attention rendering

Render the P10 `SandboxRecoveryBindingFailure` ActionRequired row on its exact
Execution Workspace with the fixed safe summary “Sandbox recovery binding
evidence is missing or invalid; execution is paused.” Use the supplied
immutable `occurredAt` (sourced from `tool_invocations.intent_at`) and stable
`attentionFactId`; repeated query results render identically. Never expose
RecoveryBinding hash/bytes, arguments, resolved regions, host paths or parser
diagnostics. The row is not dismissible and has no repair/rebind control. A
corruption Problem from malformed binding-hash format or invalid intent time
uses the existing corruption rendering; the UI must not fabricate a row or


## V21 policy status and large-summary rendering

Render NeedsDecision as a required-human-policy state distinct from provider
Unavailable and success; show safe preconditions and refetch through existing
Workspace Detail when CAS rejection says inputs changed. Never auto-select a
profile/provider/network policy or reuse stale refs. FullAccess is explicitly
labelled TrustedLocal/Unconfined, high risk, requires affirmative separate
confirmation and is never fallback after OS provider failure. Do not describe
it as OS-isolated or T3 Supported.

Render durable SandboxPolicySummaryTooLarge as the existing HTTP 200
TerminalRejected CommandReceiptView inline hint with no raw fields, no Problem/
409 and no truncation. User reduces policy inputs and submits a fresh
CommandId. Provider unavailable renders fixed safe Attention/503 state, keeps
Work visibly blocked and has no auto-retry/spawn; wait for existing WebSocket
invalidation or explicit manual refetch. Policy-required interruption displays
NeedsDecision without provider-unavailable label or 503. RecoveryBinding
failure Attention has fixed safe summary and immutable intent_at, with no
repair/rebind UI.

## Accepted Sandbox Policy Candidate Read Model V5 rendering

When Workspace Detail supplies `sandboxPolicyCandidateRead`, render its
current safe choices instead of treating the omitted singular
`sandboxPolicyPreconditions` as unavailable. The common preconditions are
read-only CAS context; they do not select a profile or provider by themselves.
Render each OsEnforced option from its exact providerId/version,
profile, and networkMode; render TrustedLocal as explicit
FullAccess/Unconfined and high risk, with the existing separate affirmative
confirmation. Never present TrustedLocal as an OS-isolated choice or fallback.

The human supplies the existing V21 P1 fields after selection: copy the exact
common preconditions and only the selected candidate's
`sandboxHandleBindingDigest` to P1's existing
`expectedSandboxHandleBindingDigest`. Add the OsEnforced registry pair only
for that variant and submit the existing NetworkPolicyV1 matching the selected
networkMode.
Do not submit `candidateId`, candidate reason/list, evidence refs, or any
provider diagnostics; candidate IDs are UI identity only. There is no
automatic choice or submit. On `StaleSandboxPolicyInputs`, wait for existing
invalidation or an explicit refetch, replace the stale candidate list, and
require a new deliberate human choice even if the refreshed option has the
same `candidateId`. Discard the whole stale read; never implicitly reuse or
resubmit it. After any V2 bundle child changes,
including registry-only changes while a TrustedLocal decision is committed,
show NeedsDecision and require explicit reapproval without implying an
OS-provider dependency for TrustedLocal.

## Accepted Option A exact provider selection (2026-10-20)

Under `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`, fixed proposal
SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`,
P13 renders the safe `capabilityRevision` alongside providerId/providerVersion
for each OsEnforced V2 candidate so distinct supported capability tuples are
deliberate, distinguishable human choices. On submission, P13 copies the
selected candidate's exact `providerId`, `providerVersion`,
`capabilityRevision`, profile, matching NetworkPolicy mode, existing registry
pair, common CAS fields and selected handle digest into the P1 OsEnforced
request. It never submits `candidateId`, currentHost, evidence refs or
qualification details. There is no auto-selection, nearest-version choice,
fallback or local authority; stale/refetch behavior is unchanged.

## Accepted pre-intent CandidateRead bootstrap (2026-10-21)

When the exact active Execution has a Pending P3 Executable Action and its
existing P4 Executable approval is Pending/unconsumed after the nonterminal
`ApprovalRequired` pause, P13 renders the same `sandboxPolicyCandidateRead`
variants and common preconditions from Workspace Detail. No ActionId,
ApprovalId, P3 input hash, P4 invocation/binding or source digest is rendered.
The human deliberately submits the existing DecideSandboxPolicy fields first;
P13 does not create or resolve the approval and adds no command or route. The
human then resolves the exact existing Executable approval through the
existing Inbox command. The first P4 invocation intent/approval consumption
continues to use the existing atomic claim transaction.

P1 safe stale fields `ActionRevision` and `ExecutableApprovalRevision` use
the existing generic stale/refetch summary. P13 refetches only through its
existing invalidation/explicit-refetch behavior, requires a deliberate human
choice, and never auto-submits the old payload. The approval expiry detail and
revision numbers are not displayed. No provider diagnostic, host path, target
ref, source digest or secret is added to the view.
