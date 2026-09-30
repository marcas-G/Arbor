# 项目管理决策草案

## 要解决的用户问题

Arbor 的 Project 是长寿命工作容器；Workspace 是该项目内部、按责任组织的节点。当前产品却要求用户记住并输入 `prj_…` 才能切换 Project，且没有受支持的改名或归档入口。这使“项目”和“责任树节点”在界面上混淆。

本草案仅为人工治理准备决策文本；它**不**修改 `docs/design/**`，也**不**授权实现。

关联缺口：[DPM-DG-01](../gaps/DPM-DG-01-project-directory-and-lifecycle-management.md)。

## 决策

采纳以下项目管理模型：

```text
Project 管理：创建 / 从项目目录切换 / 重命名 / 归档（Close）
Workspace 管理：仅在一个 Project 内创建、组织和浏览责任结构
删除：不提供物理删除
Reopen：本次不引入
```

### DPM-1：目录是独立的、主体范围内的读契约

新增 `ProjectDirectory` 读口，不把它伪装成现有 project-scoped `ViewId`。它以已认证 principal 为输入，返回该主体可见的项目，不接受由浏览器声明的“可见项目”集合。

本地单用户 composition 可把 local root principal 可见范围定义为本地数据库中全部 Project；未来多主体 composition 必须由一个显式的 visibility resolver 提供可见范围，不能以“扫描 projects 表”替代授权。

目录返回的最小项目条目为：

```text
projectId                 // 导航/诊断需要，默认不在日常 UI 展示
name
lifecycle: Open | Closed
rootWorkspaceId
revision
updatedAt
```

目录使用自己的 `directoryRevision`（或等价单调 cursor）标明目录快照，而不是谎称它拥有单一 Project journal watermark。`updatedAt desc` 为默认排序；UI 默认过滤 `Closed`，并提供显式“已归档”筛选。

### DPM-2：RenameProject 是有审计记录的 canonical command

新增：

```text
RenameProject
payload: { name: ProjectName, expectedRevision: Revision }
target: CommandEnvelope.projectId
```

它必须：

- 仅在 Project 为 `Open` 时执行；
- 经 exact project-governance authority；
- 以 `expectedRevision` compare-and-swap；
- 令 `Project.revision` 递增，但不改变 `projectPolicyRevision`；
- 写入 `ProjectRenamed { projectId, previousName, name, revision }` durable event；
- 使用规范化后的非空名称。精确长度、Unicode 规范化和重复名策略在 phase contract 固化；同名不代表相同 Project，ProjectId 仍是 identity。

`Closed → RenameProject` 是 terminal lifecycle mutation，拒绝。

### DPM-3：CloseProject 的产品名为“归档”，但语义仍是 Close

将 DID 已有 `CloseProject` 完整接入 application、authority、transport 和人类可操作目录。UI 以“归档项目”呈现，并要求显式确认；不使用“删除”措辞。

```text
Open --CloseProject--> Closed
Closed --任何 lifecycle mutation--> illegal
```

关闭只阻止**新的** autonomous Execution admission。它不会自动取消 Open Work、停止已有 Execution、删除 Session、删除事件或抹除工作区。read、recovery、audit 均继续可用；已有 Active Execution 依现有 recovery/settlement 语义自然收敛。

关闭请求本身受 exact project-governance authority 和 `expectedRevision` CAS 保护，并写入既有 `ProjectClosed` durable event。该 command 需要定义明确的 result receipt 和幂等重放行为。

### DPM-4：无硬删除、无本次 Reopen

不新增物理删除、级联删除、清空历史、或常规“删除项目”按钮。`Closed` 是审计保留状态；以后若业务需要 Reopen，须提交独立设计决策，不能绕过 DID 现有 terminal lifecycle 真值表。

### DPM-5：Web 信息架构

左栏顶部为“项目”：显示当前项目名称、切换列表、创建入口。项目 ID 仅放在项目设置页的“复制 ID / 诊断”区域。

“项目内部导航”只在选中 Project 后可用；其中的“责任树”明确标示为 Project 内部 Workspace tree，不作为 Project 列表。工作台页展示当前 Project 的概览与责任树，两者不复用同一种 node。

## 必须随治理更新的拥有契约

1. DID：Project 字段/命令/事件/authority/transition truth table，以及 read/transport 读边界。
2. P1/P10/P12：`RenameProject` / `CloseProject` 命令、repository CAS、目录读口与目录一致性、外部 transport 与权限解析。
3. P13/P14：人类可操作命令目录从“exactly eight”受控 supersede，项目切换不再以手输 ID 为正常路径。
4. 新 phase contract：准确的 schema、名称规范、目录 cursor、授权 resolver、SQLite 索引、API DTO 与验证矩阵。

## 接受条件

治理接受本草案时，同时确认：

1. 本地单用户目录可见全部本地 Project；多主体 deployment 必须使用 visibility resolver。
2. 默认只显示 Open，Closed 可过滤查看。
3. 归档不会自动中断正在运行的 Execution 或取消 Work。
4. 本次无 hard delete / Reopen。
5. `RenameProject` 与 `CloseProject` 都是 CAS、可审计、有幂等 receipt 的 canonical commands。

## 推荐的后续工作

人工治理将决定写入 owning documents 后，关闭 DPM-DG-01，并按“目录读口 → Rename/Close 后端链路 → Web 项目管理面 → 端到端证据”顺序实施。任何与上述决策冲突的发现都要重新打开设计缺口。
