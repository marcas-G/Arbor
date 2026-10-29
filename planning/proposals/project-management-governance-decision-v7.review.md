# 项目管理治理包 v7 — 最终独立审阅意见

日期：2026-09-30。

## 不可变审阅对象

本审阅只适用于以下六个候选对象的固定字节版本：

1. `planning/proposals/project-management-decision-draft-v4.md`  
   SHA-256 `BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25`
2. `planning/proposals/project-management-decision-amendment-v5.md`  
   SHA-256 `1F17C4F1F4D8C4610562E72A2BFFA0B96DAB95EE213684B910164CEEBE71B2E6`
3. `planning/proposals/project-management-decision-amendment-v6.md`  
   SHA-256 `D692C2F1E206CF8E6043590C25919ACC44A998D52229E9D2F7D8003BEDA01C74`
4. `planning/proposals/project-management-decision-amendment-v7.md`  
   SHA-256 `1B79D2EF990A2CABE5AE086ACAF00E9F06CD420EA47DA7EEC7C052EAB7EC2509`
5. `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
   SHA-256 `FD615F976743467399FE562686E07B7A926CE5E412D9B35FB75552DF9527F321`
6. `planning/proposals/project-management-governance-submission-v7.md`  
   SHA-256 `4088C15C5FC80F7A5937BAA9279578BD0567A20BD8D3D6FA9A1FC8B08757D94E`

六个 SHA-256 均已与磁盘字节复核一致。任一候选对象发生字节变化，本审阅自动失效。

## 结论

**ACCEPT 建议 — Blocking = 0。**

v7 已关闭 v6 review 的唯一 Blocking：当前候选对象集、历史证据集和最终接受对象集现在只有一种解释，不再残留 v5/v6 current-chain 要求。

本结论表示：人工治理可以对上述固定六对象及本 review 的固定 SHA-256 签发 ACCEPT，并据此由人工治理更新 owning `docs/design/**`。它本身不是治理 ACCEPT，不直接授权代码实现，也不允许提前把 DPM-DG-01 标为 RESOLVED。只有 accepted semantics 实际写入 owning design、记录 resolving revision、再将 Gap 标为 RESOLVED 后，实施授权门才可能打开。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## 接受链核验

### 1. 唯一 current candidate set

v7 amendment 第 11–21 行与 v7 submission 第 7–16 行列出的对象完全一致：

```text
v4 base
+ v5 amendment
+ v6 amendment
+ v7 amendment
+ current Design Gap
+ v7 submission
+ independent v7 review
```

前六项是 review 输入；本 review 是第七项。最终人工决定固定七个 SHA-256，不存在候选遗漏、重复或自引用哈希循环。

### 2. 旧 v5 chain 已被明确 supersede

v7 amendment 第 9 行明确规定：v5 submission/review 仅为历史 `REVISE` 证据，并显式 supersede v5 amendment 中“最终决定固定 v5 submission/review”的旧接受链措辞。因而继续把 v5 amendment 作为产品/恢复语义层时，不会把它过时的 submission/review 要求带入当前 acceptance object。

### 3. 旧 v6 chain 不再是 current

v7 amendment 第 9、21、23 行与 v7 submission 第 16 行共同规定：v6 submission/review 仅为历史 `REVISE` 证据，最终决定**只**固定 v7 的六候选对象与 v7 review。v6 amendment 继续承载已通过的技术修订，但 v6 submission/review 不再具有 current acceptance 身份。

### 4. Gap 状态已推进到 v7

Gap 第 20–27 行：

- 记录 v5 `REVISE / Blocking = 3` 与 v6 `REVISE / Blocking = 1` 为历史审计证据；
- 当前候选明确为 v4 base + v5 amendment + v6 amendment + v7 amendment + v7 submission；
- 状态明确写为 v7 被独立审阅、固定、接受并写入 owning design 前保持 OPEN；
- 没有再把 v5 或 v6 submission 称为 current candidate。

Gap 的 cooperative Stop 正文与非目标也保持一致：Close 自动提交既有 cooperative `StopExecution`/Quiescence，但不强杀 Execution、不自动 Cancel Work。

### 5. 历史对象 disposition 清楚

v1 decision 以及 v2/v3/v4/v5/v6 submission/review 均只保留为历史审计证据。其中：

- v1 decision 是被后续固定治理包 supersede 的历史接受记录；
- v2–v6 reviews 保留各轮 `REVISE` 证据；
- v4 draft 本身不是“旧 submission/review”，而是以固定 SHA 作为当前 base 继续纳入；
- v5/v6 amendments 同理作为当前组合语义层继续纳入。

该区分没有把技术 base/amendment 错误降为历史，也没有把失败 submission/review 错误升级为当前语义。

## v6 技术语义继承检查

v7 第 7 行明确只归并接受链，不修改已通过技术语义；未发现文字重新打开以下合同：

- `StepEffectsCommitted` 在 stop fact 下形成既有 terminal proposal，不虚构 successor；
- `NextStepReady` / `OutputRejected(Retry)` 先 AHT-6 `ensureSuccessor`，不发新 Provider 请求；
- Provider-only interruption 不伪造无 Tool refs 的 `OutcomeUnknown`；
- legacy ProjectName 不允许 raw SQL/adapter/治理外 rewrite，只能等待独立审计化 repair contract；
- ProjectDirectory token/revoke/no-oracle、名称 policy/UTS #39/discriminator、Submit/claim/admit/Close/settle/writeback/Inbox replay 规则保持原组合语义；
- cooperative Stop 不等于强杀或自动 Work cancel。

因此 v7 不需要重新打开 v2–v6 已关闭的技术审阅项。

## 人工 ACCEPT 记录的精确要求

若人工治理采纳本建议，最终决定必须：

1. 逐项记录本 review 开头六个候选 SHA-256；
2. 记录本 `project-management-governance-decision-v7.review.md` 的最终 SHA-256；
3. 明确解释顺序为 `v7 amendment > v6 amendment > v5 amendment > v4 base`，只在后层明示替换处 supersede；
4. 明确 v1 decision 与 v2–v6 submission/review 仅为历史证据，不属于 current accepted object；
5. 只授权人工治理把 accepted semantics 写入 owning `docs/design/**`，不把 ACCEPT 本身误写成代码实施授权；
6. 在 design landing 完成并记录 resolving revision 后才把 DPM-DG-01 改为 RESOLVED；实现阶段仍须另有明确授权及 TDD/迁移/恢复证据。

若六个候选对象或本 review 在签发决定前有任何字节变化，必须重新计算 SHA 并重新独立审阅，不能复用本 ACCEPT 建议。

## Blocking 统计

```text
Acceptance-chain ambiguity      0
Stale current-object reference  0
Old submission/review leakage   0
Gap status contradiction        0
New technical semantic change   0
---------------------------------
Blocking                        0
```

## 审阅范围

本次重点复核 v6 review 的唯一接受链 Blocking，并确认 v7 没有重新打开此前已经通过的技术合同。对照了 `AGENTS.md`、v4 base、v5/v6/v7 amendments、当前 Gap、v7 submission，以及 v2–v6 review 的 disposition。未运行实现测试；未修改 `docs/design/**`、实现代码或六个被审阅对象。
