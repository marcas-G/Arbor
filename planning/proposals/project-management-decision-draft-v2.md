# 项目管理决策草案 v2

## 状态与取代关系

**DRAFT — 尚未接受，不授权实现。**

本草案取代 `project-management-decision-draft.md` 作为后续治理裁决对象。它保留已认可的产品方向，并补齐审阅
`project-management-governance-decision.review.md` 提出的 DPM-R1…R4。

任何接受记录必须固定本文件的 SHA-256；对本文件的语义修改必须产生新哈希和新的 ACCEPT / REVISE / REJECT 记录。

## DPM-1：Project Directory 是主体绑定、无泄露的独立读口

`ProjectDirectory` 不属于现有 project-scoped `ViewId` / `ProjectionQueryPort`。它以认证后的 principal 和其被授权的 directory scope 为输入；浏览器不得声明可见集合、scope、排序 cursor 或项目成员关系。

目录行的最小输出为：

```text
projectId                // 仅导航/诊断；日常卡片默认不展示
name
lifecycle: Open | Closed
rootWorkspaceId
revision
updatedAt
displayDiscriminator     // 仅同名时展示；见 DPM-4
```

### DPM-1a：目录版本、分页和故障

1. 目录分页 token 是服务端生成的不透明 capability，绑定 `(principal, directory scope, visibility revision, sort/filter)`；它不得包含或可推导全局项目数量、全局顺序、其他主体的变更或不可见 Project 的时间。
2. 可见集合的 grant/revoke，或任一可见行的 create/rename/close/字段变化，都会使现有 snapshot token 失效。后续分页返回显式的 `DirectorySnapshotExpired`，客户端从第一页重新读取；不得静默重复、遗漏或保留已失去可见性的行。
3. resolver 无法确定 visibility 时 fail closed，并返回显式目录读取失败；绝不返回空列表来伪装“没有项目”。
4. 本地单用户 composition 中，`local root` 的 directory scope 可看见本地数据库中全部 Project；任何多主体 composition 必须安装 visibility resolver，缺失 resolver 即无法提供目录。
5. 目录使用自己的 opaque snapshot/version 语义，不声称拥有某个单 Project journal watermark。

## DPM-2：RenameProject 是 CAS、授权、审计化的 canonical command

新增：

```text
RenameProject
payload: { name: ProjectName, expectedRevision: Revision }
target: CommandEnvelope.projectId
```

它只在 `Project.lifecycle = Open`，且持有 exact project-governance authority 时执行。它以 `expectedRevision` CAS 更新 `Project.name` 与 `Project.revision`；不改变 `projectPolicyRevision`。成功写入：

```text
ProjectRenamed { projectId, previousName, name, revision }
```

名称采用冻结的非空 Unicode 规范化规则。Closed 项目改名是 `TerminalLifecycleMutation`。命令 receipt 及相同 command 重放按既有 command idempotency 规则收敛。

## DPM-3：CloseProject（产品名“归档”）及关闭竞态矩阵

`CloseProject { expectedRevision }` 是 DID 已有 `Open → Closed` canonical mutation 的完整实现与人类入口。它受 exact project-governance authority、revision CAS 和显式二次确认保护，写入既有 `ProjectClosed` event。UI 叫“归档项目”，不叫“删除”。

### DPM-3a：关闭后的命令边界

| 类别 | Closed 后规则 |
|---|---|
| 新 `SubmitHumanMessage` | 终端拒绝；不得创建 Pending 记录。 |
| 新 autonomous `AdmitExecution` / 新工作或结构扩张 | 拒绝。 |
| 已在 Close 线性化点前成功 admission 的 Active Execution | 可运行至 settlement/recovery；其 session append、已启动 tool 的结果接收、outbox/inbox 对账和 `SettleExecution` 允许完成。 |
| 已在 Active Execution 中、但会产生新的 business/governance mutation 的动作 | 拒绝；execution 必须以已有事实收敛/settle，不能在归档项目中扩张 Work、Workspace、Dependency、Permission 或 Policy。 |
| `StopExecution`、安全性 revoke、recovery / lease / settlement | 允许，因为它们减少风险或使已有事实收敛；仍受各自已有 authority/fencing/precondition 约束。 |
| Rename / 再次 Close / Reopen | Rename 与 Reopen 拒绝；重复 Close 仅以既有相同 command receipt 重放收敛，新的 Close 因 lifecycle terminal 拒绝。 |

### DPM-3b：HumanMessage 的关闭竞态与终态

HumanMessage 增加可审计终态：

```text
Pending | Claimed | Answered | Declined(ProjectClosed)
```

`Declined` 保存 disposition time、reason 与（如有）claim/execution reference；它不再出现在待处理队列，也不会被 retry sweep 重新变成 Pending。

`CloseProject` 与 claim/admission 必须在一个可线性化的 closed-admission gate 上竞争。其结果固定为：

| Close 线性化点时的消息状态 | 处置 |
|---|---|
| Pending | 原子转为 `Declined(ProjectClosed)`，并撤销其 conversation inbox entry。 |
| Claimed，且尚未有 committed Active Execution | 转为 `Declined(ProjectClosed)`；随后的 admission 必须因 closed gate 拒绝，且不得 rollback 成 Pending。 |
| Claimed，且已成功 admission 为 Active Execution | 保持 Claimed；该 execution 依 DPM-3a 完成 recovery/settlement，最终 Answered 或由既有失败终态规则收敛。 |
| Answered / Declined | 不变。 |

生产扫描与重启恢复必须分别枚举：(a) Open 项目可 admission 的 Pending 消息，(b) **不以 Project Open 过滤**的已 admitted Active Execution / Claimed conversation message，用于 settlement、lease/recovery 与上述收敛。验收必须覆盖 submit/claim/admit 每一个与 Close 的竞态点、Close 后重启、以及“Closed 项目不存在永久 Pending 或无主 Claimed 消息”。

归档不物理删除 Project、Workspace、Work、Session、消息或事件，也不自动取消 Work 或强杀 Execution。

## DPM-4：允许同名，但同名选择不依赖 raw ProjectId

Project name **允许重复**；`ProjectId` 继续是唯一 identity，名称不承担唯一约束、Create/Rename 不因同名失败，也不探测不可见项目名称。

当当前目录页中存在规范化后相同的 `name`，每条同名行必须展示 `displayDiscriminator`：由 directory resolver 在该 principal/scope 中生成、稳定且非 raw `ProjectId` 的人类辅助标识（例如该 scope 内的项目序号与创建日期）。同名行必须以 `name + displayDiscriminator` 无歧义选择；非同名项目不额外展示技术 ID。该辅助标识的解析及 token 均不得暴露 scope 外或不可见项目的存在/计数。

## DPM-5：Web 信息架构

左栏顶部为“项目”：显示当前项目**名称**、目录切换、创建入口和归档筛选。项目设置页提供“复制项目 ID / 诊断信息”。

仅在选中 Project 后显示“项目内部导航”；其中“责任树”明确为 Workspace tree。工作台的 Project 概览与 Workspace 节点保持不同组件与不同数据契约。

## 必须随接受落入 owning contracts 的内容

1. DID：Project command/event/authority/transition truth table；Closed command matrix；HumanMessage 的 `Declined(ProjectClosed)` 状态及 close/admit linearization gate；目录读/隐私/版本不变量。
2. P1/P10/P12/P14：命令 payload/result、repository CAS 与原子 gate、事件 schema、目录 resolver/snapshot transport、authority、P14 conversation/recovery matrix。
3. P13/P14 UI：human-actionable catalog 的受控 supersession、目录切换与归档确认行为。
4. 实施 phase：名称规范、displayDiscriminator、SQLite 迁移/索引、错误 DTO、token 存储、完整 TDD 验收矩阵。

## 非目标

- 不合并 Project 与 Workspace。
- 不做 hard delete、级联删除、自动 Work cancel、强制 kill Active Execution 或 Reopen。
- 不让浏览器直读 SQLite 或在客户端伪造目录/权限。
- 在 owning design 更新前，不实现上述能力。
