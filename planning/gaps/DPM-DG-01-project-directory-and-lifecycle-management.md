# DPM-DG-01 — 项目目录、重命名与关闭入口

## 状态

**RESOLVED — v7 accepted；DID + P15 owning contracts 已落地。**

人工治理已在 2026-09-30 接受产品方向及初始规则，见
[`project-management-governance-decision.md`](../proposals/project-management-governance-decision.md)。
该决定未固定被接受草案的不可变版本；审阅
[`project-management-governance-decision.review.md`](../proposals/project-management-governance-decision.review.md)
提出 DPM-R1…R4 四项阻断。修订裁决对象见
[`project-management-decision-draft-v2.md`](../proposals/project-management-decision-draft-v2.md)
与 [`project-management-governance-submission-v2.md`](../proposals/project-management-governance-submission-v2.md)。
v2 独立审阅为 `REVISE / Blocking = 5`，见
[`project-management-governance-decision-v2.review.md`](../proposals/project-management-governance-decision-v2.review.md)。
v3 独立审阅为 `REVISE / Blocking = 3`，见
[`project-management-governance-decision-v3.review.md`](../proposals/project-management-governance-decision-v3.review.md)。
v4 独立审阅为 `REVISE / Blocking = 3`，见
[`project-management-governance-decision-v4.review.md`](../proposals/project-management-governance-decision-v4.review.md)。
v5 独立审阅为 `REVISE / Blocking = 3`，v6 独立审阅为 `REVISE / Blocking = 1`；二者均为历史审计证据。
当前候选治理包由固定 v4 base、v5 amendment、v6 amendment、v7 acceptance-chain amendment 和
[`project-management-governance-submission-v7.md`](../proposals/project-management-governance-submission-v7.md)
组成。Close 不强杀 Execution、不自动 Cancel Work；但会对 Close 时 Active Execution
自动提交既有、协作式 `StopExecution` / Quiescence，禁止新的模型、工具和业务动作，
让已开始操作与执行按 durable recovery/settlement 收敛。
在 v7 治理包被独立审阅、固定并接受，且 owning `docs/design/**` 记录 resolving revision 前，本缺口仍为 OPEN，
实现尚未获授权。

用户已确认产品方向：日常项目管理应支持**新建、重命名、关闭/归档**，不提供硬删除；项目 ID 不应作为日常切换的主要界面。

这不是仅靠前端补按钮可以完成的工作。受影响实现必须停在契约边界，直到治理明确下列问题。

## 已观察到的失败证据

现有 Web 命令目录的自动化规格 `apps/web/test/catalog.test.ts` 明确断言人类可操作命令**恰为八项**，其中只含 `CreateProject`；`RenameProject` 和 `CloseProject` 不在该受冻结的集合中。`apps/web/src/shell/AppShell.tsx` 因此只能让用户手输 `prj_…` 来切换项目。

同时，`ViewId` / `ViewRequestMap` 只定义项目内读模型。`ProjectionQueryPort` 的结果带有一个 `projectId` 对应的 journal watermark；`project-list` 若作为现有 ViewId，既没有单一项目范围，也没有跨项目 freshness 定义。直接读取 SQLite `projects` 表或仅在浏览器维护列表，会绕过权限、传输与一致性边界。

领域层已经存在 `Project.lifecycle = Open | Closed`、`closeProject`、`ProjectClosed` 和 `ProjectRepository.closeIfRevision`，而 DID §4.2 / §12.10 / §12.11 也列出了 `CloseProject`。但 P1 的冻结 command contract 及 P13/P14 的冻结 human-actionable catalog 没有把该命令实现或暴露给用户。`RenameProject` / `ProjectRenamed` 则在领域、事件目录和 DID public command 集均不存在。

## 受影响的设计所有权

| 主题 | 拥有文档 | 为什么需要治理 |
|---|---|---|
| Project canonical mutation / revision / lifecycle / events | DID §3.1、§4.2、§5、§12.10–§12.11 | 重命名需定义 command、authority、CAS revision 与 durable event；关闭需补齐已定义命令的精确前置条件与人类入口。 |
| command authority 与外部提交 | DID §6、§8；P12 authority contracts | 目录读取的主体可见范围、重命名/关闭的 authority 不能由浏览器猜测。 |
| Read model、freshness 与 transport | DID §7、§10.5；P10/P12 read contracts | 跨项目目录不能伪装为一个 project-scoped ViewId / watermark。 |
| Web 人类可操作面 | P13/P14 UI contracts | 当前“exactly eight”命令目录与 switcher 的手输 ID 行为都是已冻结契约。 |

## 需治理裁决的最小合同

1. **项目目录读模型**
   - 新增独立的、principal-scoped `ProjectDirectory` 读口（或明确授权的新 `ViewId` 变体），而不是复用项目内 `ProjectionQueryPort`。
   - 定义项目可见性来源。当前 `Project` 没有 owner/member 字段；在单用户本地部署与未来多主体部署中，目录不能默认泄露全部项目。
   - 定义每行最小字段：`projectId`（供导航、非默认展示）、`name`、`lifecycle`、`rootWorkspaceId`、`revision`、最近更新时间/排序依据；以及目录自身的 freshness/版本语义。

2. **RenameProject**
   - 新 public command：`RenameProject { name, expectedRevision }`，使用 `CommandEnvelope.projectId` 定位目标。
   - `Open` 时、经 project-governance authority、CAS `Project.revision` 后生效；名称非空且规范化规则明确。
   - durable `ProjectRenamed` event 必须保留 old/new name 或可审计等价事实；`Project.revision` 递增，`projectPolicyRevision` 不变。
   - 明确 Closed 项目是否允许改名；建议：禁止，保持 Closed terminal mutation 语义。

3. **CloseProject（界面称“归档”）**
   - 复用既有 `Open → Closed` 语义，正式实现并加入人类可操作目录；界面只称“归档/关闭”，不称“删除”。
   - 明确执行中的 Execution 的处置。DID 当前只保证关闭后不 admission 新 autonomous Execution，并允许 read/recovery/audit；不能在实现时擅自终止、取消 Work 或抹除历史。
   - 明确关闭后的目录可见性与默认过滤：建议默认只显示 Open，提供“已归档”显式筛选；关闭项目仍可读、仍可恢复已存在的运行状态。

4. **不做 Hard Delete / Reopen**
   - 不新增物理删除、级联删除或“删除项目”按钮。
   - `Closed` 在当前 DID 中是 terminal；是否未来允许 Reopen 必须是独立治理决定，本次不假定。

## 建议的实施顺序（裁决后）

1. 治理更新拥有语义的 DID 与受影响 phase/UI contracts，并标注 P13/P14 目录 supersession。
2. 先 TDD 实现目录读口、`RenameProject`、已定义 `CloseProject` 的完整 application/repository/event/authority/transport 链。
3. 为 Closed、权限隔离、CAS 冲突、重放幂等、关闭时 Active Execution、目录 freshness 做机械证据。
4. 最后再把 Web 侧项目选择器改为名称列表；ID 只在项目设置的“复制/诊断”位置出现。

## 非目标

- 不把 Project 与 Workspace/责任树节点合并。
- 不修改 `docs/design/**`；只有人工治理可写入上述 owning documents。
- 不通过本地直读数据库或浏览器缓存伪造项目列表。
- 不实现硬删除、自动取消工作、强杀执行或 Reopen。归档会对当时 Active Execution 自动提交既有、协作式 `StopExecution` / Quiescence；这是收敛既有事实，不是强杀或取消工作。
