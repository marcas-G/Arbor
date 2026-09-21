# P8 — 04 Evidence & Version Binding (DRAFT for contract review)

**Authority:** DID v1.11 §3.5:1161-1185, §3.7:1237, §8.4A, §12.8 C7; SD v1.3 §9.2/§9.5/§9.6; 不变量 26/27/44/49; P4 blob/artifact 基建; P7 `01` §3（Deliverable 不可变）; P6 `01` §2（占位 mission）。
**Status:** DRAFT (first draft for contract review; GQ2 decided: criteria structured per v1.11 G1)。

## 1. EvidenceRecord（runtime record，DID §3.7——非聚合、无 domain event）

```ts
interface EvidenceRecord {
  readonly evidenceId: EvidenceId;                 // evd_ 冻结前缀
  readonly verificationId: VerificationId;
  readonly criterionId: string;                    // mission criterion 引用
  readonly kind: "ToolObservation" | "ArtifactRef" | "ReasoningTrace" | "ReproductionLog";
  readonly artifactRef?: ArtifactId;               // 内容进 P4 blob（sha256 寻址）
  readonly observedEnvironmentRevision?: string;   // 可执行验证时必填（§3）
  readonly recordedByExecutionId: ExecutionId;     // Verifier Execution 绑定
  readonly recordedAt: string;
}
```

- append-only、immutable；仅 VerifierExecutionAuthority 可 append（`01` §2）。
- trust metadata（DID §8.4A）：evidence 片段进 Model Context 时 `provenanceKind: ToolObservation/…` 默认 `DataOnly`——verdict 推理链不得自我提升 authority。

## 2. Criterion 级 verdict（GQ2 已裁决：mission schema 结构化——v1.11 G1）

`VerificationMission.criteria`（M-2 迁移：P0 Schema→结构化、P1 载荷/测试、P6 placeholder——v1.11 G1）:`ReadonlyArray<{ criterionId: string; requirement: string; required: boolean }>`；聚合域纯函数按 v1.11 G1 冻结语义。CriterionResult 仍是结论快照的 value object（聚合整体 Verdict 不变）。

```ts
interface CriterionResult {
  readonly criterionId: string;
  readonly requirement: string;                    // 快照（mission criterion 原文）
  readonly required: boolean;
  readonly verdict: "Pass" | "Fail" | "Unknown";
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;  // 每条 criterion 必绑（不变量 26 criterion 级）
}
```

- 确定性聚合（SD §9.6，域纯函数 L1）：任一 required Fail → Fail；无 Fail 有 required Unknown → Unknown；全 required Pass → Pass；optional 透明展示不影响整体。
- 存储：`verifications` 行内 missionSnapshot/criteriaResults JSON（criterion 结果是结论快照的一部分）。

## 3. Version binding 规则（不变量 26/49 精确化）

| 绑定 | 规则 |
|---|---|
| targetWorkRevision | Start 时乐观绑定；refine 后旧 Verification/Acceptance 保留但不适用（DID §12.8 冻结） |
| targetDeliverables | 引用 P7 不可变 Deliverable（`DeliverableRepository` 只读消费）；其 sourceWorkRevision 必须 == targetWorkRevision（不一致 → StartVerification 拒绝 AuthorityDenied reason） |
| targetArtifactVersions | 从 deliverables 的 artifacts 派生（role→artifactId 集合）——恒必填（不变量 26 Artifact 部分） |
| targetEnvironmentRevision | mission 含可执行验证（运行 tests/复现实验）→ **必填**（从 P2 EnvironmentRevisionStore.current 读）；纯静态审查可缺省——B-7 细化 |

## 4. Verifier 工具/沙箱写面（L5 落点细化）

- Verifier 可写：临时验证 Artifact（blob 专用前缀 `verify:`，ArtifactMetadataRepository 记录绑定 verificationId）。
- Verifier 不可写：Producer 正式 Artifact、works/dependencies/deliverables 任何行——P4 SandboxPort 路径策略 + InvocationAuthority 的 capability 集在 Verifier 上下文中收紧（P4 `06` 能力面裁剪点，P8 契约声明期望、实现归任务）。

## 5. P6 占位 mission 收紧

- P8 冻结 minimal mission schema：goal 非空、criteria: 至少一条 required、每 criterion 有 requirement 文本；riskRequirements 结构化可空。
- 迁移：formation-plan 的 `"p6-placeholder"` 空 mission 在 StartVerification 时按 schema 校验失败 → 显式 typed 拒绝（reason: mission invalid）——存量 Work 需 RefineWork 补 mission 后可验证（不自动填充——mission 是 Producer/Parent 的语义责任）。

## 6. Must Not Decide

- No matcher/verdict/聚合规则修改；No evidence domain event；No Environment 生产语义（P11）。
- No blob/沙箱实现细节冻结（P4 基建复用，任务级）。
