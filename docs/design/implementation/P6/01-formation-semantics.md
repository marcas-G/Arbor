# P6 — 01 Formation Semantics

**Authority:** DID v1.9 §8.15, §11 P6, G3 (v1.9), G5 (v1.7), §1.4A, §1.6, §3.4, §5.4, §12.10; SD v1.3 §7.6, §8.1; S1.4 步骤 3–6; P1 `01` §6/§8, P2 `01` §5, P3 `03` §3, P5 `03` §2. Resolved D1, D3.
**Status:** FROZEN (manual governance adoption).

## 1. Formation 语义总览

`ProposeChildWorkspace` 与 `SpawnSpecialist` 是两条不同的 delegation 路径：

```text
ProposeChildWorkspace  →  长期责任实体（新 Workspace + primary Session）
SpawnSpecialist        →  一次性执行角色（ExecutionBound Execution，不建 Workspace）
```

- Workspace 是 long-lived responsible identity；specialist 是 runtime execution role，无 AgentId、无长期认知（DID §1.6）。
- 两者都只改变组织结构/执行结构，不产生外部副作用；canonical 变更全部经 `CommandGateway`（P3 `03` §3）。

## 2. `ChildWorkspaceProposal`（P6 冻结载荷，补齐 P3 `03` 留名）

```ts
interface ChildWorkspaceProposal {
  readonly name: string;                          // non-empty
  readonly responsibilityDraft: ResponsibilityDefinition;   // draft; P1 §6 payload 形态
  readonly resourceBoundaryDraft: ResourceBoundary;         // 必须 ⊆ parent 有效边界（03 §2）
  readonly rationale: string;                     // 为什么要这样拆（S1.4 步骤 4）
  readonly initialWork:                           // 可选：创建后立即 AssignWork
    | { readonly objective: string;
        readonly why: string;
        readonly constraints: ReadonlyArray<string>;
        readonly completionExpectation: string; }
    | undefined;
  readonly formationDepthHint?: "Single" | "Recursive";     // 信息性，不作为权威
}
```

- `responsibilityDraft.resourceBoundary` 的 `basisResponsibilityRevision` 一致性由 P1 `01` §6 precondition 承担；P6 不重复校验。
- `initialWork.verificationMission` 不在 proposal 中：P6 不拥有 Verification 语义（P8）；`AssignWork` 需要该字段时使用 P1 冻结的 minimal 占位 mission，P8 到位后收紧。

## 3. `SpawnSpecialist`（P6 冻结载荷；含 D3 约束）

```ts
interface SpecialistSpec {
  readonly mission: string;                       // non-empty；成为 AdmitExecution(ExecutionBound).mission
  readonly constraints: ReadonlyArray<string>;   // 注入 specialist Session 的控制上下文
  readonly skillIds: ReadonlyArray<string>;       // 可选预载 Skill（P3 progressiveLoad）
}
```

- spawn = 向 `CommandGateway` 提交 `AdmitExecution { _tag: "ExecutionBound", workspaceId: 当前 Workspace, parentExecutionId: 当前 Execution, mission, sessionId: caller-preallocated }`（P2 `01` §5 全部 precondition 适用）。
- P2 不加 specialist 并发限制（DID v1.7 G5）；瞬时上限由 Safety Envelope 兜底（SD §7.7）。
- `StopExecution` 已提交后，当前 Execution 禁止新的 Specialist spawn admission（DID §3.4 quiescence 列表）。

**Specialist settlement 回流（D3 冻结约束）：**

```text
specialist Execution settle
  → SpecialistSettled 观察 { specialistExecutionId, settlementFingerprint, summary }
  → 只进入 Parent Workspace Inbox projection（admission upsert-by-key）
  → wake（reevaluation 触发）
```

- **禁止直接写 Parent Session**（任何路径：driver、consumer、recovery 均不得）。
- **replay-safe dedup（冻结）**：dedup key = `specialistExecutionId + settlementFingerprint`；at-least-once 投递与 projection rebuild 下，同 key 的重复 admission 是 no-op（Inbox 至多一条）。
- wake 幂等：重复 wake 无害（P2 durable wait 语义天然幂等）。
- settlementFingerprint 由 settlement ADT 判别式与载荷派生（确定性），不由模型文本派生。

## 4. Formation 链与第一层 human gate（D1 冻结闭合）

规则（S1.4 步骤 4 / 步骤 6 的直译）：

```text
depth(parent == Root)        →  第一层：需 human confirmation
depth(parent != Root)        →  深层：parent authority 自主执行
```

### 4.1 FormationProposal（有 revision 的 governance 实体）

```ts
interface FormationProposalRecord {
  readonly proposalId: FormationProposalId;       // caller-preallocated
  readonly parentWorkspaceId: WorkspaceId;
  readonly proposal: ChildWorkspaceProposal;
  readonly revision: ProposalRevision;            // 初始 1；modify 递增
  readonly state: "Pending" | "Approved" | "Rejected";  // Approved/Rejected terminal
}
```

- Admission（Governance Runtime）：验证来源、authority（提议者必须是 parent Workspace 的 agent 或 User）、结构并持久化。
- state 进入 terminal 后禁止再 modify / 再 decide。

### 4.2 第一层链路（全部使用冻结命令集）

```text
Agent directive: ProposeChildWorkspace(proposal)
  ↓ directive handler（Execution 边界内）
RequestGovernance { kind: FormationApproval, proposalId, proposalRevision: 1 }
  ↓ Governance Runtime routing
FormationProposal admitted (Pending, revision=1) + human Inbox 引用
  ↓ human 裁决（绑定 exact revision — D1）
RecordDecision { proposalId, expectedProposalRevision, outcome }
  ├─ outcome = modify(proposal')  → proposal' 替换内容，revision+1，仍 Pending
  ├─ outcome = approve            → DecisionRecorded { proposalId, proposalRevision }   [governance fact，到此为止]
  └─ outcome = reject             → DecisionRecorded（reject），proposal state=Rejected
  ↓ 仅 approve 路径：Application 作为 consumer（DID §5.4）
CreateChildWorkspace（P1 §6 全契约；CommandId = deterministic f(proposalId, proposalRevision)）
  [→ AssignWork（若 initialWork；同链 deterministic CommandId）]
```

**D1 冻结约束：**

- `RecordDecision` payload **必须**携带 `expectedProposalRevision`；`proposal.revision != expectedProposalRevision` → `DomainError.RevisionConflict`（stale 裁决不生效）。
- `RecordDecision → DecisionRecorded | DecisionRepository` 是 DID §12.10 冻结表行（表注：supersede, no in-place history rewrite）；`modify` 产生新的 DecisionRecorded 记录并使 proposal revision+1，不就地改写历史。
- Approve **只形成 governance fact**（`DecisionRecorded` 事件 + proposal state=Approved）；它本身**不执行**任何 Workspace 变更。
- `CreateChildWorkspace` 由 Application 后续经 `CommandGateway` 执行（事件驱动接线；consumer 至少-once 重投由 deterministic CommandId 幂等吸收，DID §5.4）。
- 幂等：同 `(proposalId, proposalRevision)` 的 approve 重投 → 既有 Receipt（P1 §8 规则）；对已 Approved 的 proposal 再 RecordDecision → terminal-state rejection。
- human gate 的裁决不跳过任何 P1 precondition；裁决不是 authority 豁免。
- 裁决结果（含 reject）作为 Observation 回到发起 Execution 的 Workspace Inbox。

### 4.3 深层链路（无 gate）

```text
Agent directive: ProposeChildWorkspace(spec)
  ↓ directive handler 验证 authority fact（03 §3）
CreateChildWorkspace（P1 §6）[→ AssignWork]
  ↓
WorkspaceCreated → 子 Workspace 进入 scheduler 的 runnable reevaluation
```

- 两条链路的 `CreateChildWorkspace` 是同一 P1 命令；P6 不新增 formation 命令。
- depth 判定是确定性结构计算（Workspace 树深度），不是模型判断。

## 5. Bootstrap / Handoff（子 Workspace 初始认知）

- 子 Workspace 创建即获得 `WorkspacePrimary` Session（P1 `01` §6，原子）。
- 初始 Model Context 由 Runtime 编译，来源仅限：

```text
Responsibility（含 revision）
ResourceBoundary
parent 提供的 initialWork（objective / why / constraints / completionExpectation）
proposal.rationale
Project 层 scoped instructions（S3）
```

- Bootstrap 内容是 `CanonicalInstruction`；`rationale` 等模型衍生文本按 DID §8.4A 标 `ModelDerived / DataOnly`，不得自我提升 authority。
- P6 不实现 Successor/Retire 迁移（DID §1.4A Retired 禁止列表仅作为 precondition 遵守）。

## 6. Must Not Decide

- No `Deliverable` / `DeclareDependency` / runnable reevaluation（P7）。
- No `AssignWork` 命令语义修改（P1 拥有；P6 只作为调用方）。
- No `AdmitExecution` 语义修改（P2 拥有 generic admission）。
- No Authority Resolver / PermissionGrant 语义（deferred；`03` §1）。
- No Verification mission 内容语义（P8）。
- No workspace 数量/深度硬限制值（属于 Project Policy 配置，非 P6 契约常量）。
- No Parent Session 直写路径（D3 禁令的逆向表述）。
