# P6 — 04 Human Steer

**Authority:** SD v1.22 §3.4/§7.3（Work contract + quiescence）, §8.1; Scenarios v1.7 S2 全部（尤 §3–§8）; DID v1.59 §2.3, §3.3, §4.2, §5.3, §12.10–§12.11; P2 `01` §6（StopExecution）.
**Status:** FROZEN (manual governance adoption).

**Accepted S2-RDG-01 addendum (2026-10-24):**
`ACCEPT_S2_STEER_WORK_REVISION_CONTRACT_V1`, proposal SHA-256
`C878BBF615F92ED43125C79EFDC0F021F062FEE97BF740795889B65B44394088`.
This is an owner-contract landing only; implementation remains separately
unauthorized.

## 1. Steer 语义总览（S2 直译）

```text
普通纠错（Normal Steer）   →  不抢占；进入 Inbox；下次执行自然吸收
Critical Steer            →  立即 quiescence（SD §7.3 强中断路径）
立即停止（Stop）           →  StopExecution（P2 拥有，P6 只是调用方）
```

S2 §6：用户的纠错不是默认硬抢占；只有明确的立即停止或高风险 Critical Steer 才进入强中断路径。
S2 §5/§7：Agent 在已有工作脉络上吸收纠错，不从头开始；纠错后恢复自治。

## 2. `SteerWork` command handler（P6 实现）

DID §12.10 表行：`RefineWork / SteerWork(DirectionGuidance | ContractAmendment)` → `WorkRefined / versioned WorkSteered or WorkAmended`，precondition = exact authority + revision，效果 = `Open, revision++`（P6 实现 SteerWork 侧；RefineWork 属 producer 自 refine，同一 WorkRevision/history 通道）。

### Payload

```ts
{
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly steer: {
    readonly severity: "Normal" | "Critical";
    readonly guidance: ContentRef;              // 纠错内容，bounded view 进 Context
    readonly scope?: "Direction" | "Constraint"; // 信息性
  };
  readonly expectedWorkRevision: WorkRevision;   // optimistic precondition
  readonly provenance: Provenance;               // HumanInput 来源标记
}
```

FT-DG-03: the registered semantic validator is derived from this exact closed
payload and its `Provenance` / `ContentRef` contracts; it does not change the
existing human-origin authority or UI exposure (DID §4.1B; P13 `02`).

The existing schema-v1 payload above is preserved as `DirectionGuidance` only,
including legacy `scope="Constraint"`; scope is information and never changes
canonical Work requirements. The accepted semantic discriminator is the
following conceptual closed union (illustrative only; it does not freeze the
wire payload field placement or final Effect/API signature):

```ts
type SteerOperation =
  | { readonly kind: "DirectionGuidance"; readonly guidance: ContentRef }
  | {
      readonly kind: "ContractAmendment";
      readonly amendment: HumanAuthoredWorkContract;
    };
```

`HumanAuthoredWorkContract` is the complete replacement of Work objective,
why, full constraints, completion expectation, and structured
VerificationMission (goal, complete criteria/required flags and risk
requirements). Amendment uses a new command schema version and explicit
discriminator; P1 owns the exact receipt/version compatibility. Missing fields,
patch/merge, defaults from the prior contract, and inference from free text are
not valid V1 amendment forms. Only an authenticated human may author/confirm
the complete snapshot on the exact Work route and current expected revision.
The authenticated exact-route command itself is the explicit confirmation; it
does not add a second CAPA/PermissionGrant approval. If an owning product path
later uses an existing ActionApproval, that approval must bind the exact
WorkId/WorkspaceId, old revision, amendment discriminator and complete
snapshot digest. An amendment grants no file, network, Provider,
cross-Workspace or other execution capability and never widens Sandbox or
ResourceBoundary.

Both operations use the same SteerWork handler, authority and WorkRevision CAS.
DirectionGuidance increments WorkRevision while preserving the complete
canonical snapshot; ContractAmendment increments it and replaces the complete
snapshot. Each accepted revision is retained in immutable Work revision
history with provenance/source command/time/digest. The logical history
guarantee is owned by DID v1.59; no table, column, DDL, migration ID or Effect
signature is selected here.

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| work not found / 不属于 workspace | `CommandRejection.WorkNotFound`（**P6 冻结新增枚举**，P1 未定义） |
| work lifecycle != Open | `DomainError.TerminalLifecycleMutation` |
| authority 无 steer 权（R1–R3 结构判定 + Human） | `DomainError.AuthorityDenied` |
| `work.revision != expectedWorkRevision` | `DomainError.RevisionConflict` |
| ContractAmendment 不完整或 mission 不合法 | typed validation rejection；无 Work/history/Inbox/event 部分提交（具体 rejection codec 由 P1/P6 command contract 冻结） |
| producer 不能弱化受保护的 upstream 需求（DID §12.10 表注） | `DomainError.AuthorityDenied` |

### Events

```text
WorkSteered { workId, fromRevision, toRevision, severity }
```

`WorkSteered` remains the direction-guidance event. A normative
ContractAmendment is represented by the versioned `WorkAmended` event and the
same exact WorkRevision history chain. These events are distinct; no guidance
text is promoted into criteria. Event version/payload shapes follow DID/P1's
closed event contract and are not expanded by this P6 landing.

- `DirectionGuidance` 与 `ContractAmendment` 都使 `WorkRevision` 恰增一；方向指导不改规范 contract，amendment 只接受 complete replacement。下游 `Deliverable/Verification/Acceptance` 仍绑定 exact revision。
- For an accepted Blocked WorkEpisode, the same authorized SteerWork
  transaction that advances the Work revision changes Open blockers bound to
  the old revision to `Resolved` and writes their resolution facts. It does
  not clear the WorkWait directly; P2 clears that wait only while consuming
  the corresponding `InboxAdvanced` wake. A terminal Work transition instead
  supersedes its Open blockers atomically. Revisions and typed events remain
  auditable; no historical Blocked evidence is deleted.

- For an accepted RAI-DG-02 terminal Provider hold, the same authenticated
  exact-revision `SteerWork(DirectionGuidance | ContractAmendment)` advances
  `r→r+1` and is the sole v1 execution-resumption path. Provider credential or
  configuration repair, time passage, restart and Attention acknowledgement do
  not authorize retry. An independently authorized CompleteWork/CancelWork
  makes retry-oriented presentation inactive without deleting the immutable
  terminal Provider chain. No same-revision RetryWork command is introduced.

## 3. HumanInput 通道

- Human steer 输入是 `AuthenticatedHuman` provenance 的 Message（DID §8.4A），进入目标 Workspace Inbox（02 §4 Admission：验证来源、authority、结构）。
- DirectionGuidance 的内容是 bounded non-normative input。ContractAmendment 的规范 truth 是同事务提交的完整 Work revision snapshot；Inbox/Session 文本不是另一份 contract，也不能覆盖 canonical mission。
- `Normal` steer：promotion 仅触发 runnable reevaluation；吸收由 Agent consumption 完成（S2 §5"先理解再纠错"由认知侧保证，不由 runtime 强制中断）。
- 局部纠错不需要从 Root 重新描述整个项目（S2 §5）：steer 目标精确到 Workspace/Work，不广播。
- 每次后续 Work Context 从当前 canonical Work revision 重注入完整 contract；DirectionGuidance 单独标为非规范性，不把 ContractAmendment 仅当作自由文本传递。

## 4. Critical Steer / Stop 的 quiescence 集成

SD §7.3 冻结语义的 P6 接线（机制 P2 拥有，P6 是发起方）：

```text
Critical Steer 提交
  = 同一外层 SteerWork 可靠提交边界内：
    1) SteerWork(severity=Critical, DirectionGuidance | ContractAmendment)
       → 对应的 WorkSteered / WorkAmended 治理事实 + HumanInput Inbox
    2) 在该事务内按目标 Workspace 读取当前 active main（不按 WorkId 筛选）
       ├─ 存在 → StopExecution(该 active main)，禁止新 ProviderTurn /
       │          ToolInvocation / Execution-originated canonical Command /
       │          Specialist spawn
       └─ 不存在 → Stop 无目标；不发起 StopExecution，不产生
                  ExecutionStopRequested；仍提交 SteerWork 与 HumanInput
  ↓
in-flight 副作用按 SideEffectSemantics cancel/confirm/reconcile（P4）
无法确认 → Execution 只能 OutcomeUnknown(ReconciliationRequired)（P2）
  ↓
Work 保持 Open；纠错内容已在 Inbox；下次 admission 的 bootstrap Context
按 DID §8.13 Control Reinjection 从 Canonical State 重注入（Steer 属 Constraints/Current Work 面）
```

- A pre-transaction active-main lookup is only preparation, not the decision:
  the current Workspace active main is re-read inside the outer SteerWork
  transaction. If a main Execution becomes active after preparation, the
  transaction resolves StopExecution authority for that exact Execution and
  stops it in the same transaction; it must not commit the no-target branch
  based on the stale preparation result. If the transaction-time read finds no
  active main, commit only SteerWork and HumanInput, with no Stop request or
  `ExecutionStopRequested` event. If the exact Stop authority or Stop handler
  cannot be applied for a transaction-time active main, the composite does not
  commit a partial steer.
- `CancelWork` 与 Stop 分离（SD §7.3）：P6 的 steer 永不隐式 Cancel Work。
- Safety Envelope 触发的中断是另一通道（SD §7.7），不与 human steer 混用 Attention 归因。
- Normal 与 Critical 对 DirectionGuidance / ContractAmendment 的 authority、完整字段、WorkRevision CAS、history、receipt replay 与 Verification 绑定完全一致；Critical 只增加已冻结的 exact active-main Stop/quiescence leg。
- DirectionGuidance 的 History 快照与前一 revision 相同；ContractAmendment 的 history 快照是人类完整 replacement。两者都追加不可变 revision history，不改写旧快照；无法证明的 legacy 历史保持 unavailable。
- 新 Verification 只读取 exact current revision 的 canonical VerificationMission。旧 Open Verification 可在其 immutable mission/revision 上结论化，wake 只作用于该旧 revision，旧结果永不满足新 revision；Work revision 前移不隐式 cancel/relabel。

## 5. S2 行为验收要点（供 06 引用）

```text
- 用户可对树上任意 Workspace 的 Open Work 发 Normal DirectionGuidance，不产生执行中断
- Normal DirectionGuidance 后的下一次 Execution Context 含 bounded guidance，且 canonical Work contract 不变
- ContractAmendment 必须显式、human-authored、完整 replacement；文本、旧 scope 或缺字段均不变成规范变更
- 每次被接受的 Steer 都恰增 WorkRevision 并保留完整 snapshot；stale/invalid amendment 不产生部分 Work/history/Inbox/event 事实
- 新 Work revision 的 Verification Mission 与 canonical snapshot 精确一致；旧 Verification 仍只结论化/唤醒旧 revision
- Critical Steer 且事务内存在 active main：同一外层 SteerWork receipt/事务提交
  对应 WorkSteered 或 WorkAmended + HumanInput + 对该 Workspace 当前 active main 的 Stop；该
  Execution 进入 quiescence，无新动作
- Critical Steer 且事务内没有 active main：同一外层 SteerWork receipt/事务仍提交
  对应 WorkSteered 或 WorkAmended + HumanInput；不调用 StopExecution，不产生
  ExecutionStopRequested，Work 保持 Open
- 若事务内 active main 与事务外准备结果不同（包括准备时无 active main、事务内
  新 admission 已 active），必须以事务内当前 active main 为准并为其解析精确
  Stop authority；不得因准备结果为无目标而漏停
- Active main Stop authority/handler 失败：SteerWork、Inbox 与事件无部分提交
- 纠错后恢复自治：无需人工重启 Work；reevaluation 自行再admission
- Sibling/Child 不能 steer（R3 权限拒绝，typed rejection 可测）
```

## 6. Must Not Decide

- No `CancelWork` / `CompleteWork` 语义（前者后续阶段接线，后者 P8）。
- No StopExecution/quiescence 机制本体（P2 拥有；P6 只规定发起时序与同一提交边界要求）。
- No Critical 判定自动化（severity 由 human 显式声明；runtime 不做语义升级/降级）。
- No steer 历史/审计 UI（P10 projection）。
