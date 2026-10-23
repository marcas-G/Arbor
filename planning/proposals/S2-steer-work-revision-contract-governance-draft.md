# S2 SteerWork Revision Contract — Governance Draft

状态：**草稿，待人工治理；不构成接受或实现授权**  
建议接受标识：`ACCEPT_S2_STEER_WORK_REVISION_CONTRACT_V1`  
Design Gap：`S2-RDG-01`  
固定基线：Problem & Goals v1.3、Scenarios v1.6、System Design v1.21、DID v1.58；本稿不修改 `docs/design/**`。

## 1. 提案摘要与边界

真实 public S2 Normal Steer 发现一个跨 owner 的合同缺口：用户可改变目标/约束，S2 §8 要求原责任单元继续并更新工作；P6 SteerWork 当前只接纳 bounded guidance、推进 `WorkRevision` 并把 guidance 送入 Inbox；P8 则按 Work revision 固定 `VerificationMission` 快照。一次符合当前 public command 的 steer 因而改变了期望文件字节，却没有任何已接受命令能把 canonical `CompletionExpectation` / `VerificationMission` 一并改到新目标。独立 Verifier 按旧 mission 判 Fail 是正确行为。

本稿只请求人工裁决以下语义：

1. 纯方向指导与规范性目标/约束修订必须是不同的 typed operation；自然语言文本不得自行决定其一。
2. 目标/约束修订必须由有权人类显式提交，CAS 绑定完整当前 revision，并在一个原子边界内形成新 Work contract 与可审计历史；模型可以提供建议，但不能自行批准或隐式改变 mission。
3. P8 只接受 exact 当前 revision 的 Verification / Acceptance；旧 revision 的 Open Verification 不得结论化成当前结果，也不得接受或完成新 revision。
4. Normal / Critical 只改变中断时序，不改变两类 Steer 的字段语义、authoring authority 或 verification 绑定。

不在本稿范围：改写 S2 体验目标、弱化 required criteria、自动接受 Fail/Unknown、让 Agent 自行改 mission、引入新的执行权限、实现代码、迁移或 UI、修改任何冻结设计。以上均须在治理接受后再授权实现。

## 2. Owner chain 与不可越权的基线

| Owner | 本稿依赖的已冻结事实 | 本稿不能替其改写的部分 |
|---|---|---|
| Problem & Goals §P6–P8 | 人可观察/局部干预；执行、验证、接受分离；canonical truth 与模型认知分离 | P1–P8 目标、权限根本语义 |
| Scenarios §S2.4.5–8 | 人可提出新约束、否定方案、改变优先级；§8 明确“目标、约束或接口调整”后原责任单元继续并更新工作 | S2 场景本身与高层重组边界 |
| System Design §3.3、§15.2 | Work 是 canonical Goal；有 objective、constraints、completion expectation、mission、revision；producer 不得削弱受保护要求 | Domain 与 Runtime 的最终语义 |
| DID §2.3、§3.3、§12.10、§12.11、§4.2 | semantic Refine/Steer 推进 WorkRevision；Verification/Acceptance 绑定 revision；CompleteWork 要求 current-revision PASS + Acceptance | Work/Verification truth tables、命令与持久化合同 |
| DID v1.58 / P8 F18 | v2 Verification row/event/result/receipt 完整绑定 Work/revision、mission snapshot、criteriaResults、verdict、summary/reason 与精确 wake signal；既有版本化 receipt/replay 必须保持 strict | 不重标或改写既有 v2 快照；新 Work amendment 只建立后继 Work revision，不更改历史 Verification |
| P6 `04-human-steer`、`06-acceptance` | payload 当前为 `guidance` + 可选信息性 `scope`；HumanInput provenance；Normal 不抢占，Critical 的治理事实与 Stop 同边界；WorkSteered revision++ | steer authority、Inbox 和 quiescence 所有权 |
| P8 `01-verification-commands`、`04-evidence-binding`、`06-acceptance` | StartVerification 快照当前 Work mission；Verification 为 immutable/version-bound；验收归 Parent；Fail/Unknown 不等于 PASS | 独立验证、verdict、Acceptance 与 CompleteWork 链 |
| Application/UI/API/Persistence phase owners | 严格 codec、receipt/gateway、revision CAS、transport 与展示是各自实现 owner | 本稿不预先定最终 Effect API、表结构细节或 Web 外观 |

冲突/未裁决点：S2 要求 outcome/constraint 更新；P6 当前只将指导文字送 Inbox，`scope` 是信息字段；P8 用现有 Work mission 创建验证快照。仅增加 prompt 指令不能形成新的 canonical Work revision，也不能安全改变 Verifier 的判据。该空隙由 S2-RDG-01 提交 owner 治理，实施不得用 prompt 或测试夹具自行解释。

## 3. 拟议操作模型

### 3.1 `DirectionGuidance`：只改变方法，不改变完成条件

方向指导适用于“先检查另一条路径”“优先验证假设 X”等仍须满足原 Work contract 的输入。它保留 bounded 人类 guidance、精确 Work/Workspace、当前 revision CAS 与 provenance。每个被接受的 `DirectionGuidance` 都按现有 P6 语义使 `WorkRevision` 恰增一；canonical contract snapshot 内容保持不变。此 revision 的旧 Verification/Acceptance 不再满足 current-revision completion 条件，避免以旧版本结果完成已被重新指导的责任。

显式类型（示意，不是 API 冻结）：

```ts
type SteerOperation =
  | { readonly kind: "DirectionGuidance"; readonly guidance: ContentRef }
  | {
      readonly kind: "ContractAmendment";
      readonly amendment: HumanAuthoredWorkContract;
    };
```

`DirectionGuidance` 禁止携带 objective、constraints、completion expectation 或 mission 字段；server codec 对额外字段 fail-closed。其 `guidance` 可以说明用户意图，但不得作为 canonical criteria 的隐式来源。

### 3.2 `ContractAmendment`：显式更改 Objective / Constraint / Outcome

任何会改变 Work“必须产出什么、哪些条件必须满足、Verifier 如何判定”的更改，都属于规范性 amendment，而不是普通 guidance。V1 唯一 authoring 形式为：

**唯一 V1 形式：完整 replacement snapshot。** 人类明确提交完整的新 WorkContract：`objective`、`why`、完整 `constraints`、`completionExpectation`、完整结构化 `verificationMission`（goal、criteria/required、risk requirements）。即使字段与旧值相同，也必须在 payload 中完整出现。V1 不定义 patch/merge 变体，不接受缺省继承、基于自由文本的字段推断或服务端补齐。理由：VerificationMission 是 P8 判定快照；完整 replacement 是最小可审阅、可重放、不会悄悄脱离人类确认的表达。

Amendment 必须由人类直接 author/确认。模型可将用户话语整理成供预览的草案，但在治理要求的显式确认之前它只是 cognition，不得改变 Work 行、revision、Inbox authority 或 Verifier mission。`scope="Constraint"`、自然语言里“改成/现在应该”等词、Work Agent 的 `RefineWork` 或 Claim Completion 都不能替代 typed amendment 与人类确认。

### 3.3 Authority、CAS、审批与权限边界

- 只接受现有 authenticated human origin / provenance 与对 exact Workspace→Work 的授权；现有 authority resolver 必须继续校验 Work 属于目标 Workspace、owner/route、Work Open、有效授权和 exact `expectedWorkRevision`。不得把对一个 Work 的授权提升为 Workspace 全局或未来 Work 的权限。
- 旧 `expectedWorkRevision` 返回既有 typed RevisionConflict，无 Inbox 引导、Work mutation 或新 revision。缺少 human provenance、错误 Workspace、无 authority、terminal Work、失效/拒绝的精确审批均零 canonical mutation。
- 直接 authenticated exact-route human SteerWork 命令本身就是对该完整 amendment payload 的明确人类确认；不得再凭空增加 CAPA 二次审批。若产品路径另行采用 Inbox/ActionApproval 中转，审批必须绑定 exact WorkId、WorkspaceId、old revision、完整新 snapshot digest、amendment kind 和提交者；批准后仅能应用此 tuple，revision 再变化则 stale / 重新确认，不拓宽 Sandbox、ResourceBoundary、PermissionGrant 或 tool capability。
- Work amendment 不授予文件/网络/Provider/跨 Workspace capability，不更改 PermissionGrant；技术权限仍走现有 CAPA/P4/P11/P12 authority/policy。

## 4. 原子提交、历史与版本绑定

### 4.1 单次写入的 canonical 结果

一个获准的 amendment 应在同一个 Gateway/transaction 边界中：

1. 复核 exact owner、human authority、Open lifecycle、expected revision 与审批 digest（如有）。
2. 固化旧/新完整 contract 快照或有确定性定义的完整 patch 前后值；计算确定性 canonical digest。
3. 将 Work 的规范性字段整体替换为人类确认的新 snapshot，`revision` 恰增一。
4. 写入不可变 revision-history 事实、版本化 WorkSteered/WorkAmended 事件及 command receipt，提交同一 P6 Inbox steer guidance/人类 intervention（沿现有边界）。
5. `Normal` 只安排安全边界后吸收；`Critical` 在同一冻结的 P6/P2 quiescence 边界内阻止该 Execution 再发 Provider/工具/Canonical Command。副作用 cancel/confirm/reconcile 遵守 P4；Steer 不隐式 CancelWork 或 CompleteWork。

任何部分失败均不得造成“Work mission 已更新、audit/revision event 未落盘”或“审批已消费、Work 未更新但无回执”的不一致；由 P1/P6/P2 owners 固定实际事务和 stop 边界。

### 4.2 历史与 migration/legacy

- 历史 mission 不覆写成新内容。每个 Work revision 对应不可变完整 WorkContract snapshot，可由 exact Work/revision 查询供审计和 Work Detail 使用。新 verification 持久化其 exact mission snapshot/digest 与该 revision 的关联。
- V1 固定为 Work owner 的 durable append-only revision snapshot ledger：每条以 `(WorkId, WorkRevision)` 唯一绑定完整字段、作者/provenance、source command、时间与 canonical digest。具体表名、编码与 DDL 是实现细节；任何实现都须提供此等价不可变读取/保留保证。迁移不得把事件重放的偶然可用性当作历史永久保留。
- 新 Work 的初始 revision 与所有新 contract revision 必须都有完整 snapshot；RefineWork、AssignWork、SteerWork 各 writer 均需统一写入，避免只有 Steer 留档。
- migration 只可精确 backfill migration 时当前 Work 行所代表的当前 revision，且需标注为 `LegacyCurrentSnapshot` / history unavailable；不得从 Inbox、Session、模型文本、summary、Verification 旧任务反推出历史 contract。旧 revision 的 exact snapshot 若不可证明，保持不可用，不伪造。既有 event / receipt / DB 字节严格版本解码，不重标版本、不静默补写。
- fresh、旧 schema → 新 schema、失败中断重试、foreign/duplicate snapshot、current row 与 snapshot 不匹配均需 disposable DB 资格。不得写 preserved / live database。

### 4.3 verification、acceptance 与返修

- `StartVerification` 只从 exact 当前 Work revision 的 canonical `VerificationMission` 创建 mission snapshot；Mission 不由 Verifier prompt 或 Work message 重写。
- 旧 revision 的 Verification/Acceptance 继续可审计，但不能 satisfy 新 Work revision，也不能 Parent Accept 或 `CompleteWork`。
- 已运行中的旧 Verification 继续按其不可变旧 `missionSnapshot` 读取证据并可在旧目标上 Conclude；Verification 记录的 `targetWorkRevision` 不变。P8 wake 按该 Verification 的 `(WorkId, targetWorkRevision)` 精确匹配旧 Wait；不得唤醒/清除新 revision 的 Wait。该旧 PASS/FAIL/UNKNOWN 保留审计，但永不满足当前 Work revision 的 Acceptance/CompleteWork 前置条件。Work revision 改变本身不自动 Cancel 旧 Verification、Verifier Execution、外部副作用或改写结论；Critical Steer 若另行触发 StopExecution，则只按 P6/P2/P4 的 exact stop/quiescence 路径处置其 active Execution。该规则与 P8 immutable/version-bound Verification、旧 revision verification/acceptance “保留但不适用”一致。
- 新 revision 的 FAIL/UNKNOWN 不改变 Work lifecycle（仍 Open），不产生 Acceptance/CompleteWork。`VerificationReturned` 只把 Agent 引回真实可修订状态：Agent 在不放宽 canonical 条件下修正实现/补证；若要求变化，必须请求人类再作 typed amendment。只有新 revision exact PASS + Parent acceptance 才按 P8 完成链闭合。

## 5. Context、public API、UI 与 command replay

### Model Context

- WorkEpisode 每次编译时明确注入 `WorkId + WorkRevision + 完整 canonical current contract snapshot/digest`，并将该 revision 的方向 guidance 单独呈现为非规范性上下文。
- VerificationEpisode 只注入创建时持久 `missionSnapshot`、target Work revision 与可见 evidence；注明这是不可由 agent/summary/Inbox 文字覆盖的判据。
- Parent/Root current Work read 应呈现 current revision 与完成条件，防止人类在下钻后基于过期 mission 纠偏。
- 不把其他 Workspace/session history 注入，保持 EGP/SCRC/CRAC owner 的现有隔离。

### API/UI

- API严格区分 `DirectionGuidance` 与 `ContractAmendment`。现有 SteerWork schema v1 payload 在兼容读取时只解释为 `DirectionGuidance`，包括旧 `scope="Constraint"`；它永不升级为 canonical contract amendment。含 objective/constraints/completion expectation/mission 字段但缺少显式 discriminator 的输入一律 strict reject。`ContractAmendment` 使用新 schema version 和显式 discriminator；unknown/missing fields fail closed。
- UI先显示当前 objective/constraints/completion expectation/mission，Direction 默认只收 guidance；Amendment 需单独进入完整 contract editor/明确切换，展示前后 diff、将失效的旧 Verification/Acceptance、权限/效果不变提示，并要求人类提交当前 revision。普通 steer 文本不自动解析为要求更新。
- public Work Detail、Verification Detail、Inbox 应能关联查看 revision snapshot、steer/amendment 类型、审批与失效的验证版本。具体路由/DTO 由 P13/P14/P10 owners 裁决。

### Receipts 与 replay

- 每个 command identity 绑定包含 discriminator、expected revision、目标 identities、human provenance、完整 snapshot 或规范化 patch、approval reference/digest 的 canonical request fingerprint。
- 同 CommandId + 同 payload exact replay 返回原 committed/rejected receipt 与原 revision/snapshot；同 CommandId + 不同 patch/snapshot/provenance/approval digest 返回 IdempotencyConflict，不重复推进 revision、重写 snapshot、重复 Inbox/event/Stop。
- 同 WorkRevision 的并发 amendments 至多一个 CAS winner；输家收到 stale RevisionConflict，不自动 rebase，不复用已获批准的过期 snapshot。
- normal/critical replay 与 stop/quiescence receipt 遵循 P1/P2 当前 fenced recovery contracts；Provider request 不是 command receipt 的替代事实。

## 6. 反例与不变量

| 反例 | 必须结果 |
|---|---|
| 普通方向提醒含“最好试另一种实现” | 只存 bounded guidance；canonical mission 完全不变；不把文本转成 criteria |
| 指导说“文件改成新字串”但未提交 Amendment snapshot | 视为指示与当前 mission 冲突；Agent 可解释/请求人类明确修订，不得宣称新 mission 已接受 |
| Agent 自己把 required criterion 改弱、删掉、换 expected output | 拒绝；无 revision/snapshot/receipt success/Inbox mutation |
| 人类 amendment 带不完整 mission / 没有 required criterion / 约束与 mission 矛盾 | typed validation rejection；旧 Work snapshot/revision 不变 |
| amendment 的 expectedRevision stale 或 approval digest 不匹配 | typed stale/conflict；不重放到新 revision、不自动重确认 |
| old Verification 为 PASS，但 target revision 比 current 小 | Parent Accept 与 CompleteWork 拒绝；Work Open |
| old Verification 正在执行时人类提交新 revision | old verifier 不得完成新 revision；由治理选定的 exact stale/settlement path 保持可恢复且无副作用谎报 |
| new revision Verification 为 Fail/Unknown | Work Open、无 Acceptance；原 Agent可在固定标准下返修，或向人类请求 typed amendment |
| Critical amendment 提交期间仍有 in-flight effect | 采用现有 stop→cancel/confirm/reconcile；不得把 amendment 成功说成副作用已撤销 |
| 同 ID payload 相异、进程在事务边界 crash | exact receipt replay 或事务回滚；不双增 revision，不丢历史快照，不重复 human action |

## 7. 固定语义裁决与接受请求

本稿固定请求人工治理接受以下闭合语义，不留实现方自行选择：

1. S2 的 Goal/Constraint/Outcome amendment 必须是 typed、human-authored `ContractAmendment`；与 `DirectionGuidance` 完全分离，文本不隐式升级。
2. 唯一 V1 authoring 形式是完整 replacement snapshot；不实现 patch/merge。
3. 当前 revision 的完整 snapshot 持久记录；迁移仅回填可证明的 legacy current row，并标为 legacy current-only/history unavailable，不推测旧 revision。
4. 旧 Open Verification 可在原不可变 mission / revision 上继续读证据并结论；只 wake 相同旧 revision 的 Wait；永不应用于新 revision，不自动 cancel/relabel。Critical Stop 独立遵守冻结 P6/P2/P4。
5. authenticated exact-route human command 是直接提交 amendment 的显式人类确认；如产品路径另外使用 Inbox/ActionApproval，其审批精确绑定完整 snapshot digest 和 revision。权限不扩张。
6. Normal/Critical 执行完全相同的 contract/CAS/history/replay 语义；Normal 不抢占当前执行，Critical 另外严格执行冻结 P6 同事务 StopExecution/quiescence 路径（目标 exact active main 由 P6/P2 规则确定）。

治理接受此固定 package 可关闭 `S2-RDG-01` 的语义裁决，并仅授权 owning documents 的确切 landing。landing 与独立 consistency review 后，产品实现仍须另行取得 implementation authorization，再由 P1/P6/P8/P10/P13/P14 owners 固定 Effect API、schema/DDL、UI/DTO、prompt version、测试与 disposable qualification；本稿不授予代码、迁移、部署或数据库写入授权。
