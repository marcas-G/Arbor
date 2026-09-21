# P6 — 03 Parent/Child Authority & Delegation

**Authority:** SD v1.3 §8.1–§8.3, §14 不变量 1–14; DID v1.9 §6.2 Enforcement Matrix, §3(Retired), §4.1(P2 authority facts); P1 `01` §2A/§9, P2 `01` §2A.
**Status:** PROPOSAL DRAFT.

## 1. 结构性 authority（P6 范围）与 deferred Authority Resolver 的边界

P1 `01` §9 冻结：Authority Resolver（PermissionGrant lookup / principal resolution / RBAC…）deferred。P6 **不实现** Resolver。P6 实施的是 SD §8.1 authority model 中可结构判定的部分，由 L2（Command Handler / Application）强制（DID §6.2 "Parent/Sibling authority" 行）：

```text
R1  治理权严格依附 Responsibility Tree（纵向）
R2  Parent 只日常治理 Direct Children
R3  Sibling 之间无 Assign / Steer / Stop / Responsibility Change 权
R4  Child 不能自行修改自己的 Parent（不变量 7）
R5  Parent immutable 作为日常不变量（不变量 6；DID §6.2 L1+L2 双层强制）
R6  User 是最终治理来源（Human Override；P6 体现为 01 §4 第一层 gate 与 04 human steer）
R7  治理权 ≠ 执行/写所有权（不变量 11）：parent 可 Steer child，不因此获得 child 资源的日常写权
```

判定所需事实全部来自 canonical tree（parentWorkspaceId 链）+ P2 `01` §2A 的 command-specific trusted authority fact。不做语义文本推断。

## 2. Capability Ceiling（validate-only 投影检查）

SD §8.2 公式的 P6 落地：child 的初始能力是 parent 有效能力的**投影交集**，只能收紧：

```text
ChildEffective
  = ParentEffectiveCeiling
    ∩ responsibilityScope(responsibilityDraft)
    ∩ resourceBoundaryDraft
    ∩ effectiveConstraints
    ∩ workspacePolicy
```

P6 冻结的机械检查（create/modify 时，Command Handler 层）：

| 检查 | 规则 | 失败拒绝 |
|---|---|---|
| 边界子集 | `resourceBoundaryDraft ⊆ parent 有效 ResourceBoundary`（基于 parent 当前 Responsibility revision） | `DomainError.AuthorityDenied` |
| 策略收紧 | `workspacePolicy` 不放宽 parent / Project policy 的 hard deny | `DomainError.AuthorityDenied` |
| 不放大 | delegation 不得给出 ancestor 没有的治理权（不变量 13） | `DomainError.AuthorityDenied` |
| 不递归委托 | 临时 Permission Grant 默认不可继续委托（不变量 14） | `DomainError.AuthorityDenied` |

- validate-only 模式沿 P4 v1.8 G4 先例：P6 不在此实现 ownership 变更（那仍是 `UpdateResourceBoundary` 等 governance 命令）。
- `CreateChildWorkspace` 已有的 `basisResponsibilityRevision` precondition（P1 `01` §6）是本节子集检查的既有特例。

## 3. Execution-originated formation 的 authority fact

深层自主 formation（01 §4）与 specialist spawn（01 §3）中，command 的 trusted authority fact 由 Application 从 Execution 上下文投影：

```text
VerifiedCommandAuthority {
  kind: WorkspaceAgentAuthority,
  workspaceId: <Execution.owning workspace>,   // P2 R6：Execution 记录 owning Workspace
  projectId, commandKind, target, semanticRequestFingerprint, submissionOrigin
}
```

- 对 `CreateChildWorkspace`：要求 `authority.workspaceId == payload.parentWorkspaceId`（P1 `01` §2A 已有同型检查）。
- 对 `AdmitExecution(ExecutionBound)`：要求 specialist 的 owning workspace == 发起 Execution 的 owning workspace。
- Retired Workspace 不得 AssignWork / AdmitExecution / CreateChildWorkspace / 修改 Responsibility（DID §1.4A；作为 precondition 遵守，Retire 语义本身 P6 不拥有）。

## 4. 观察与信息流的横向自由

```text
Authority flows vertically; information flows graphically.（SD §8.1）
```

- Observability 可覆盖 subtree（不变量 8）；`Query` 的收件人集合由此授权（02 §2），但读观察不产生治理权或写权。
- Sibling 消息（Report 副本、横向 Query）不违反 R3：信息流不是治理流。

## 5. Must Not Decide

- No Authority Resolver / PermissionGrant / principal 体系（deferred seam，P1 `01` §9）。
- No ResourceOwnership 变更语义（governance 命令拥有）。
- No Project Policy 内容语义（`UpdateProjectPolicy` 拥有）。
- No Retire / Successor 完整语义。
- No 任何"以文本相似度/模型判断"裁决 authority 的机制。
