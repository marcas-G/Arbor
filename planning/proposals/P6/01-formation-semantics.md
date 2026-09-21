# P6 — 01 Formation Semantics

**Authority:** DID v1.9 §8.15, §11 P6, G3 (v1.9), G5 (v1.7); SD v1.3 §7.6, §8.1; S1.4 步骤 3–6; P1 `01` §6, P2 `01` §5, P3 `03` §3, P5 `03` §2.
**Status:** PROPOSAL DRAFT（人工定稿后落位 `docs/design/implementation/P6/01-*.md`）.

## 1. Formation 语义总览

`ProposeChildWorkspace` 与 `SpawnSpecialist` 是两条不同的 delegation 路径：

```text
ProposeChildWorkspace  →  长期责任实体（新 Workspace + primary Session）
SpawnSpecialist        →  一次性执行角色（ExecutionBound Execution，不建 Workspace）
```

- Workspace 是 long-lived responsible identity；specialist 是 runtime execution role，无 AgentId、无长期认知（DID §1.6 概念约定）。
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

## 3. `SpawnSpecialist`（P6 冻结载荷）

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
- specialist settle → `SpecialistSettled` 观察（open decision D3）：进入 parent Workspace Inbox，作为 wake source 触发 reevaluation；不直接写 parent Session。

## 4. Formation 链与第一层 human gate

规则（S1.4 步骤 4 / 步骤 6 的直译）：

```text
depth(parent == Root)        →  第一层：需 human confirmation
depth(parent != Root)        →  深层：parent authority 自主执行
```

第一层链路（全部使用冻结命令集，open decision D1）：

```text
Agent directive: ProposeChildWorkspace(spec)
  ↓ directive handler（Execution 边界内）
RequestGovernance { kind: FormationApproval, proposal, correlationId }
  ↓ Governance Runtime routing（P6 实现最小路由）
human Inbox（User 是最终治理来源，SD §8.1）
  ↓ human 裁决
RecordDecision { approve | reject | modify(proposal') }
  ↓ Application（幂等，deterministic CommandId）
approve/modify → CreateChildWorkspace（P1 §6 全契约）[→ AssignWork（若 initialWork）]
reject         → 不执行；裁决结果作为 Observation 回到发起 Execution 的 Inbox
```

深层链路：

```text
Agent directive: ProposeChildWorkspace(spec)
  ↓ directive handler 验证 authority fact（03 §1）
CreateChildWorkspace（P1 §6）[→ AssignWork]
  ↓
WorkspaceCreated → 子 Workspace 进入 scheduler 的 runnable reevaluation
```

- 两条链路的 `CreateChildWorkspace` 是同一 P1 命令；P6 不新增 formation 命令。
- depth 判定是确定性结构计算（Workspace 树深度），不是模型判断。
- human gate 的裁决不跳过任何 P1 precondition；裁决不是 authority 豁免。

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
