# 项目管理治理决定 — 审阅意见

日期：2026-09-30。

审阅对象：

- `planning/proposals/project-management-governance-decision.md`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`
- 被决定引用的 `planning/proposals/project-management-decision-draft.md`

审阅时 SHA-256：

- governance decision: `5B95F713081CF6C572A96B5F319111ACD4F1D722E89CF76F56B81A0CCE864A62`
- decision draft: `ABA5D42E1020803CA504D6278D3D9A005EE89BAB62D8F51C957BD2EB08339655`
- design gap: `C86008A6A460D6707237472B9BF5A0E135147A5988AF6A2E67324B5749402FA8`

## 结论

项目目录、重命名、Close-as-archive、无硬删除及 Workspace/Project 分离的总体方向成立；决定和 Design Gap 对“尚未落入 owning design、尚未授权实现”的表述也正确。

但当前文本仍有三项阻塞性治理缺口和一项产品合同缺口。建议在 owning design 落字前修订并重新固定裁决对象；否则 phase contract 或实现仍须替治理决定关键语义。

本文件是审阅意见，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-R1 / P1：ACCEPTED 决定没有固定被接受草案的版本

位置：治理决定第 7–9 行。

决定接受 `project-management-decision-draft.md` 中 DPM-1 至 DPM-5 的“完整规则”，但只通过可变路径引用草案，没有记录内容哈希或不可变 revision。后续对草案的任何编辑都会让同一 ACCEPTED 文件看起来接受了治理者从未审阅的新语义。

建议：在治理决定中写入被接受草案的 SHA-256（当前为 `ABA5D42E...9655`）或不可变 Git revision，并规定任何语义修改都产生新哈希和新的 ACCEPT/REVISE 记录。Design Gap 的 resolving revision 也应引用同一固定对象。

## DPM-R2 / P1：Closed 后的命令与队列处置没有闭合

位置：治理决定第 25–26 行；决策草案 DPM-3 第 62–73 行；Design Gap 第 46–49 行。

“Close 仅阻止新的 autonomous Execution admission”没有定义以下边界：

- Close 后新提交的 `SubmitHumanMessage`；
- Close 提交前已经 Pending、但尚未 claim/admit 的 HumanMessage；
- 已 claim 或已 Active 的 conversation Execution；
- 为现存 Execution 收敛所需的 Session、Tool、Application Command、settlement 和 recovery 写入；
- `StopExecution`、权限治理、Steer/Work mutation 等非 lifecycle command。

当前代码给出一个机械反例：`SubmitHumanMessage` 不检查 Project lifecycle，会先持久化 Pending；conversation trigger 随后 claim，并调用 `AdmitExecution`；`AdmitExecution` 对 Closed Project 返回 `TerminalLifecycleMutation`，trigger 再把消息回滚为 Pending。后续 tick 会无限重复，既不回答，也不形成明确的 terminal disposition。

另一个恢复风险是生产 consumer discovery 默认只枚举 Open Project；若项目在 Active Execution 存在时关闭并重启，必须有独立于 Open-project discovery 的恢复路径，才能兑现“已有 Execution 自然收敛、recovery 继续”。

建议：在 DID/phase contract 冻结 Closed command matrix 与 close-race 规则，至少覆盖上述五类状态。对聊天必须明确选择并机械验证一种语义，例如：

- Close 后拒绝新 HumanMessage，且 Close 事务或确定性 sweep 对既有 Pending/Claimed 消息给出明确处置；或
- 明确把 human-triggered Coordination admission 作为允许的非-autonomous 路径，并说明这为何不等同于 Reopen。

已有 Active Execution 的恢复、停止、对账和 settlement 必须继续；哪些业务 mutation 仍可由该 Execution 提交也必须逐类冻结，不能由一个 `lifecycle === Open` 通用判断隐式决定。

验收至少加入：Close 与 submit/claim/admit 的每个竞态点、Close 后重启并恢复 Active Execution、Closed 项目无永久 Pending HumanMessage。

## DPM-R3 / P1：principal-scoped 目录版本没有覆盖 visibility 变化与隐私边界

位置：决策草案 DPM-1 第 22–39 行；Design Gap 第 35–38 行。

草案要求 principal-scoped rows，却只说使用 `directoryRevision` 或等价单调 cursor。以下语义仍未决定：

- visibility grant/revoke 发生时，即使 Project 本身未变化，目录版本是否变化；
- 全局 cursor 是否会通过跳号、时间或缓存失效泄露不可见 Project 的活动；
- 同一 principal 翻页时，visibility 或 rename/close 并发变化如何避免重复、遗漏或越权残留；
- resolver 失败时是空目录还是显式失败。

这些属于读授权、信息泄露和 freshness 合同，不只是 SQLite 索引或 DTO 细节。若留给 phase contract，自身就会作出新的治理决定。

建议冻结最低语义：目录 token 对调用 principal 不透明且绑定该 principal/visibility scope；可见集合或可见行字段变化都会使旧 token 失效或产生新版本；不可见 Project 的变化不得通过 token 语义可观察；resolver 失败 fail closed 且显式返回错误。分页一致性可在 phase contract 选择 snapshot/cursor 机制，但必须满足这些不变量。

## DPM-R4 / P2：名称作为主要界面时，重复名策略不能继续下放

位置：决策草案 DPM-2 第 51–60 行、DPM-5 第 79–83 行；治理决定第 27–29 行。

草案一方面把精确“重复名策略”留给 phase contract，另一方面要求日常切换主要显示名称、隐藏 ProjectId。若同一 principal 可见两个同名 Project，名称列表无法可靠区分；若禁止重名，则 Rename/Create 需要目录范围的唯一性与并发规则。这两种选择会改变用户行为、命令 rejection、索引和授权范围，属于产品合同。

建议由治理明确选择：

- 允许重名：目录/UI 必须展示稳定的非 ID 辅助区分信息，并定义无歧义选择；或
- 在某个明确 scope（如 principal-visible namespace）内规范化名称唯一，并定义 Create/Rename 的并发冲突语义。

ProjectId 继续作为 identity 没有争议，但不能同时隐藏 ID、允许潜在重名且不给用户其他区分依据。

## 已确认正确的边界

- 不把 Project 与 Workspace 责任树合并。
- Close 不等于物理删除，不级联抹除历史。
- 本次不引入 Reopen。
- Rename/Close 必须是授权、CAS、可审计、幂等的 canonical commands。
- ProjectDirectory 不应伪装成单 Project `ViewId`，浏览器缓存或 SQLite 直读不能成为权威目录。
- DPM-DG-01 在 owning design 落字前保持 OPEN，代码实现未获授权。

## 审阅范围

本次读取了目标决定、Design Gap、被引用草案、冻结 Problem/Goals、DID 的 Project/command/truth-table 条款、P13 command exposure contract，以及当前 SubmitHumanMessage、conversation trigger、AdmitExecution 和项目扫描实现。未运行测试，未修改治理决定、Design Gap、冻结设计或实现代码。
