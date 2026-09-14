# STEP P1-02 — Domain Core

**Gate/决策**：P1_DOMAIN_CONTRACT（含 D-031 type shape：WorkspaceContract 全 string、Effect Schema 载体、effect 于 P1-01B 提前引入——amend）。

**实现地图**（`src/domain/`）：
- `ids.ts` 扩展：ChangeId / VerificationId / EffectiveResultId（uuid 守卫矩阵）
- `workspace-contract.ts`：intent/responsibility/deliverables: string, inheritedConstraints: string[]（Root=[]）
- `resource-mapping.ts`：writable 前缀数组——每项 canonical（normalize 后等于自身）且无 glob 字符；至少一项
- `effective-result.ts`：四字段精确形状（D-026 无自引用 store SHA——键集合断言锁定）
- `implementation-change.ts`：changeId + optional baseEffectiveResultId
- `local-verification.ts`：PASS/FAIL/INCONCLUSIVE 字面量（拒绝 pass/MAYBE 等拼法）
- `workspace-state.ts` / `project.ts`：组装 + 最小身份

**不变式**：decoded 键集合 == 定义字段集合（"不含 transcript/WorkingCopy/pendingChange"的运行时证据）；禁止清单（Child Workspace/Tree/Boundary/Governance/Communication/...）零实现。

**验收**：round-trip + invariant 全绿（68 tests 时点）；Effect 4 内置 Schema（`@effect/schema` 独立包只配 effect 3，主包直接导出——零新依赖）。

**偏差**：Schema API 三处 v4 形态（refine 类型谓词 / Literals([...]) / Schema 单类型参数）。
