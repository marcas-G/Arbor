# 项目管理治理提交 v2 — 审阅意见

日期：2026-09-30。

审阅对象：

- `planning/proposals/project-management-decision-draft-v2.md`
- `planning/proposals/project-management-governance-submission-v2.md`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`

审阅时 SHA-256：

- v2 draft: `2035300702F9BE8A3333786DFEA258CBD7F21C410434C6DD4BBE333FB3237DB9`
- v2 submission: `A5529F55C52713972431BF07A69EB33DC504C2C8E0D550D0D1C408E505F7D018`
- Design Gap: `7672E7F6CFF3523B040D297331F54282EEBFAD198323DA2CCFA6DB1BA8F9FEE1`
- first review: `42679DA6B974FC86388EA67A8C88ED39B4360417BB2D72B6C307EBE336D4FEE5`

提交单所列三项输入哈希均与当前文件一致。

## 结论

v2 已实质闭合 DPM-R1…R4：接受对象被固定；Closed command matrix 和 close/admit gate 已定义；目录 token 的 principal/scope/visibility 隐私语义已冻结；重名策略选择为允许重名并要求无歧义 discriminator。

但 Closed conversation 的失败结算和 `Declined` 的用户可观察语义仍有两项 P1 缺口。因此当前建议为 **REVISE**，暂不提交 ACCEPT。DPM-DG-01 保持 OPEN、实现不获授权的状态正确。

## DPM-R5 / P1：Close 前已 admission 的执行失败后仍会回到永久 Pending

位置：v2 draft DPM-3b 第 81–88 行，尤其第 85 行。

草案规定 Close 前已经成功 admission 的消息保持 Claimed，并由既有 execution settlement 规则收敛。但冻结 P14 的既有规则是：

- Completed → Answered；
- Interrupted → Answered(null)；
- Failed / OutcomeUnknown → `Pending(attempt_no + 1)`，创建新的 conversation attempt，直到产生回复。

因此，若已 admitted Active Execution 在项目关闭后以 Failed 或 OutcomeUnknown 结算，消息会被释放成 Pending；Closed command matrix 又禁止新的 admission。结果正是 v2 想消除的“Closed 项目永久 Pending”。“由既有失败终态规则收敛”在 Closed 条件下并不成立。

建议在 DPM-3b 增加 Closed 专用的 branch-specific disposition，并与 settle write-back 线性化：

- Completed → Answered(body)；
- Interrupted → Answered(null)，沿用 P14；
- Failed / OutcomeUnknown 且 Project 仍 Open → 沿用 P14 retry-until-response；
- Failed / OutcomeUnknown 且 Project 已 Closed → 不得回滚为 Pending，应转为可审计的 `Declined(ProjectClosed)`（或治理明确的另一 terminal state），保留原 execution/settlement reference；
- settlement 与 Close 并发时，以同一个 project lifecycle/closed-admission gate 决定唯一分支，重复 sweep 幂等。

验收必须包含：Close 后 Active conversation 分别 Completed、Interrupted、Failed、OutcomeUnknown；settlement commit 与 Close commit 两侧的 crash/竞态；最终 Closed Project 中 Pending=0，且 Claimed 只允许对应仍 Active 或待 settlement write-back 的 execution。

依据：`docs/design/implementation/P14/02-conversation-execution.md` §4.2；当前 `rollbackForRetry` 明确把 Failed/OutcomeUnknown 从 Claimed 改回 Pending 并增加 attempt。

## DPM-R6 / P1：Declined 没有冻结 transcript/read-model 表达，Web 会继续显示“正在处理”

位置：v2 draft 第 69–88 行及第 104–109 行。

`Declined(ProjectClosed)` 被定义为持久终态，但草案没有规定用户如何从 transcript 或其他权威 read model 看见该 disposition。当前 transcript 对每条 HumanMessage 都投影 Human turn，仅在 Answered 且有 response body 时投影 Assistant turn；Web 把“没有匹配 Assistant turn”的 Human turn派生为“正在处理”。

所以即使后台正确停止 retry，用户界面仍会把 Declined 消息永久显示成处理中。仅在数据库增加状态不足以关闭产品问题。

建议由 P14/P10 contract 冻结一种明确表达：

- 扩展 `HumanConversationTurn`，携带 bounded server-authored disposition/status；或
- 新增与 messageId 关联、可重放幂等的 `HumanConversationDisposition` transcript entry。

Web 对 Declined 必须显示“项目已归档，消息未执行”等终态，不得显示 queued/processing，也不得伪造 Assistant 回复。该状态应经过现有 authoritative transcript 查询和 invalidation 链到达浏览器。

验收必须覆盖：Pending→Declined 和 Claimed-without-admission→Declined 后的 transcript DTO、分页/重放、Web 呈现，以及 Declined 不计入待处理状态。

依据：当前 `apps/single-workspace/src/projection-query.ts` 始终输出 Human turn；`apps/web/src/pages/workspace/ConversationTab.tsx` 对缺少匹配 Assistant 的 Human turn显示“正在处理”。

## DPM-R7 / P2：治理提交应固定本轮 v2 审阅，而非只固定指出旧缺口的首轮审阅

位置：v2 submission 第 7–24 行。

当前提交固定了 v2 draft、更新后的 Design Gap 和首轮 review。首轮 review 的审阅对象是旧 draft，结论是存在 DPM-R1…R4；它不能单独证明 v2 的修订已被独立核对。本文件完成了该核对，同时提出 DPM-R5/R6。

建议修订 v2 后生成新的不可变草案哈希，并在下一份 governance submission 中同时固定：上一轮阻断审阅、本轮 v2 审阅及对 R5/R6 的处置审阅。不要在修改草案后复用当前 submission 或当前 ACCEPT 候选哈希。

## DPM-R1…R4 复核

| 原意见 | v2 结果 |
|---|---|
| R1 可变接受对象 | 已闭合：草案要求接受记录固定 SHA；submission 中 draft/gap/review 哈希均匹配。 |
| R2 Closed 队列/命令 | 部分闭合：新消息、Pending、claim/admit 竞态和 Active recovery 已覆盖；Active execution 的 Failed/OutcomeUnknown 分支仍缺失，见 R5。 |
| R3 目录隐私/版本 | 已闭合：token 绑定 principal/scope/visibility/sort/filter，visibility 变化失效，resolver fail closed，不可见变化不得泄露。 |
| R4 同名项目 | 已闭合：明确允许重名，resolver 提供稳定、非 raw-ID、scope 内无歧义 discriminator。 |

## 审阅范围

本次读取了三个目标文件、首轮审阅、冻结 P14 conversation/transcript contracts，以及当前 HumanMessage store、conversation settlement、transcript projection 和 Web queued-state 实现。未运行测试，未修改 v2 草案、治理提交、Design Gap、冻结设计或实现代码。
