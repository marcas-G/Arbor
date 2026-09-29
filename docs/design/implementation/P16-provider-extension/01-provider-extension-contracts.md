# P16 Provider Extension Architecture — Contracts (FROZEN)

**Phase**: P16（P15 编号已被 `P15_MIGRATIONS` provider_runtime_correctness DDL 占用，phase 计数顺延）
**Status**: Gate A — 设计合同冻结。Gate B（实现）**未授权**，须本文档闭合评审 Blocking=0 后由治理方显式授权。
**Authorization**: 治理方直接指令（2026-09-29）："不接真实新 provider，不修改 Agent Runtime，不顺手补 cache usage/continuation。先冻结 ProtocolAdapter / ProviderProfile / ModelProfile / ModelDeployment / ResolvedModelBinding / ProviderRegistry / CapabilityQualification，然后给出新增一个兼容 Provider 不改 core 的机械验收方案。"
**Scope guards（违反即越权）**:
1. 不接入任何真实新 provider 家族。
2. 不修改 Agent Runtime（`packages/agent-runtime` 在 Gate B 中 diff 必须为空）。
3. 不实现 cache-token 提取与 continuation 生产来源（P16 仅冻结**声明性能力位**；实现在后续 phase 另行授权）。

---

## 0. 与既有合同的关系

P16 **不推翻任何已冻结语义**。全部概念是对现有实现形态的正式化与泛化：

| P16 概念 | 现有雏形 | 关系 |
|---|---|---|
| ProtocolAdapter | `ProviderPort` Layer 构造器（`OpenAIProviderLive` / `FakeProviderLive`） | 正式化：命名接口 + 家族 id |
| ProviderProfile | （隐含在各 adapter 行为中） | 新增：协议行为的数据化声明 |
| ModelProfile | `ModelCatalogEntry`（model-context/model-catalog.ts） | 正式化：字段冻结，向后兼容 |
| ModelDeployment | `providerFromEnv`（main.ts 三 env 变量手工接线） | 正式化：显式部署描述符 |
| ResolvedModelBinding | composition.ts 内联的 modelRef→adapter 交叉校验 | 正式化：typed 解析结果与错误 |
| ProviderRegistry | `selectProviderLayer` + 封闭 union `ProviderAdapterConfig` | 泛化：封闭 union → 静态注册表 |
| CapabilityQualification | L3 capability 体系（B01–B14 + three-run oracle） | 封装：deployment 级资格 |

Supersede 列表：**空**。继承 P3 `01`（ProviderPort/CanonicalProviderEvent/Must Not Decide）、P3 `04`（provider_turns/attempts/manifests DDL）、P12 `12`（TR-4 封闭失败 union、composition 单点选择、无自动发现）、P12 `03`（SecretStore/no-leak）、DID §6A.8/§6A.9/§7.5（failure model、Turn/Attempt、port 签名）、SD §6.1–§6.2（Agent/Model/Provider 分离、无 silent fallback）、SD 不变量 20/45/56。

---

## 1. 概念层次

```
            ┌───────────────────── Composition Root（唯一持有） ─────────────────────┐
            │                                                                        │
  ModelProfile ──catalog──▶ ModelDeployment(env/config 构造) ──resolve──▶ ResolvedModelBinding
       │                          │                                        │
       │ adapterId                │ endpoint/wireName/secretRef/policy      │ adapter + policy + capability
       ▼                          ▼                                        ▼
  ProviderRegistry ──────▶ ProtocolAdapter ◀──────────────────── ProviderRuntime 消费 Layer
       (静态表)                 │
       │                        └─ profile: ProviderProfile（协议行为声明）
       ▼
  CapabilityQualification（deployment 级资格证据，进生产的准入条件）
```

语义分工（一句话版）：
- **ModelProfile**：模型**是什么**（能力声明，纯数据）。
- **ModelDeployment**：**怎么调它**（一个具体可调用端点 + 凭证引用 + 策略覆写，纯数据）。
- **ProviderProfile**：协议家族**怎么表现**（auth 模式、流式形态、能力位，纯数据）。
- **ProtocolAdapter**：协议**翻译代码**（唯一含代码的概念；`ProviderPort` Layer 工厂）。
- **ProviderRegistry**：adapterId → ProtocolAdapter 的静态封闭映射。
- **ResolvedModelBinding**：确定性解析的产物（数据+Layer+策略），resolve 失败是 typed error，绝不回退。
- **CapabilityQualification**：(adapter, deployment) 组合进入生产前的机械资格证据。

---

## 2. ProtocolAdapter（冻结）

```ts
// packages/ports/src/provider-extension.ts（Gate B 新增文件）

export type ProtocolAdapterId = string;
// 冻结存量值: "provider-openai" | "provider-fake"
// 新家族命名规则: `provider-<family>`，小写、连字符、glob 无特殊字符

export interface ProtocolAdapter {
  readonly adapterId: ProtocolAdapterId;
  /** 该家族的协议行为声明（§3）。Registry 校验唯一性。 */
  readonly profile: ProviderProfile;
  /**
   * Composition Root 专用的 Layer 工厂。接收 deployment 绑定面；
   * 同一 adapter 可为不同 deployment 产出不同 Layer 实例（endpoint/凭证
   * 不同），但行为语义必须一致（conformance suite 保证）。
   */
  readonly layerFor: (
    binding: AdapterDeploymentBinding,
  ) => Layer.Layer<ProviderPort>;
}

export interface AdapterDeploymentBinding {
  /** base URL；无网络家族（in-process deterministic）省略。 */
  readonly endpoint?: string;
  /** wire 模型名覆写（如 modelRef "model-openai" → wire "deepseek-chat"）。 */
  readonly wireModelName?: string;
  /** 凭证引用；raw secret 仅由 ProviderRuntime 在执行边界解析（INV-P16-8）。 */
  readonly secretRef?: SecretRef;
  readonly extraHeaders?: ReadonlyArray<Record<string, string>>;
  /** conformance 测试注入口（生产留空）。 */
  readonly transportOverride?: unknown;
}
```

**义务**（全部继承 P3 `01`，无新增语义负担）：
1. 翻译协议事件为 `ProviderPortEvent`（Canonical | Observation），不产出未冻结 tag。
2. 错误按 `PROVIDER_FAILURE_KINDS`（TR-4 phase1-v2，封闭 12 类）归一；未知归一 `UnknownProviderFailure`，禁止透传 SDK/transport 异常类型。
3. Must Not Decide（P3 `01` §10）：不执行 tool call、不持 prompt 语义、不做 Work/Agent 决策、不写 Session。
4. 消费 `ProviderExecutionContext` 的 cancellationSignal（abort 后立即停止产出）与三段超时/deadline 语义（P15 runtime 合同）。

---

## 3. ProviderProfile（冻结）

```ts
export type ProviderProtocolFamily =
  | "openai-chat-completions-sse"   // 现存真实家族
  | "in-process-deterministic"      // 现存 fake 家族
  | (string & {});                  // 新家族声明（登记于 registry，enum 不冻结以允许扩展；值域由注册表封闭）

export interface ProviderProfile {
  readonly protocolFamily: ProviderProtocolFamily;
  readonly authMode:
    | { readonly _tag: "BearerSecret" }   // 无凭证必须 fail-closed（conformance A7）
    | { readonly _tag: "None" };          // 显式豁免（本地/确定性端点）
  readonly capabilityFlags: {
    /** 是否在 usage 帧报告 cacheRead/cacheWrite tokens。P16 仅声明；
     *  提取实现未授权（Scope guard 3）。存量 adapter 一律声明 false。 */
    readonly reportsCacheTokens: boolean;
    /** 是否产出 ContinuationState/checkpoint。P16 仅声明；生产实现未授权。存量一律 false。 */
    readonly supportsContinuation: boolean;
    /** 是否流式产出 TextDelta（true 时 conformance A1 必测）。 */
    readonly streamsDeltas: boolean;
  };
  /** 错误分类 taxonomy 版本；当前唯一合法值 "phase1-v2"。 */
  readonly failureTaxonomy: "phase1-v2";
}
```

**能力位诚实性**（INV-P16-5）：capabilityFlags 声明 `true` 的每一项，都必须有对应 conformance 用例（§02 E3）覆盖，且该 adapter 的 qualification evidence 引用之。声明 false 而实际产出（例如偷偷报 cache tokens）视为 ProtocolViolation 级合同违背——事件校验在 ProviderRuntime 侧丢弃并记 audit（Gate B 落地，行为与 P15 observation 校验一致）。

---

## 4. ModelProfile（冻结）

```ts
// 正式化 packages/model-context/src/model-catalog.ts 的 ModelCatalogEntry。
// 字段集为现有字段的超集；现有字段语义不变（向后兼容，无迁移）。

export interface ModelProfile {
  readonly modelRef: string;            // 全局唯一（registry 校验）
  readonly adapterId: ProtocolAdapterId; // 必须存在于 ProviderRegistry
  readonly capability: ModelCapability;  // 现有类型（contextWindow/outputCeiling/toolProtocol/…）
  /** Usage cost only（P12 `04`）；never authority。 */
  readonly priceSheetVersion?: string;
  /** 可选：该模型声明的已知 deployment id（资格证据查找用；省略=未声明）。 */
  readonly knownDeployments?: ReadonlyArray<string>;
}

export interface ModelCatalog {
  readonly entries: ReadonlyArray<ModelProfile>;
  readonly defaultModelRef: string;
}
```

解析语义不变：`resolveModelCatalogEntry` / `resolveModelCapability` 的确定性、typed `ModelCapabilityError`、无 silent fallback 全部继承。

---

## 5. ModelDeployment / ResolvedModelBinding（冻结）

```ts
export interface ModelDeployment {
  /** 稳定标识（资格 evidence 绑定键）。命名规则 `dep-<family>-<site>`，如 dep-openai-deepseek。 */
  readonly deploymentId: string;
  readonly modelRef: string;            // 必须存在于 catalog
  /** 端点（无网络家族省略）。 */
  readonly endpoint?: string;
  /** wire 模型名；省略 = 使用 modelRef。 */
  readonly wireModelName?: string;
  /** 凭证引用（SecretRef=env 变量名/file 引用；raw 值永不落入本结构，INV-P16-8）。 */
  readonly secretRef?: SecretRef;
  /** P15 执行策略覆写（三段超时/deadline/maxAttempts/backoff）。 */
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly extraHeaders?: ReadonlyArray<Record<string, string>>;
}

export interface ResolvedModelBinding {
  readonly deployment: ModelDeployment;
  readonly adapter: ProtocolAdapter;            // registry 命中
  readonly capability: ModelCapability;         // catalog 命中（providerRef=adapterId）
  /** 解析后的最终策略（默认值 ⊕ deployment 覆写）。 */
  readonly executionPolicy: ProviderRuntimeExecutionPolicy;
}

export type ResolveModelBindingError =
  | { readonly _tag: "UnknownModelRef"; readonly modelRef: string }
  | { readonly _tag: "UnknownAdapter"; readonly adapterId: string }
  | {
      readonly _tag: "DeploymentIncomplete";
      readonly deploymentId: string;
      readonly missing: ReadonlyArray<string>;   // 缺失字段名（如 endpoint/secretRef）
    }
  | {
      readonly _tag: "AdapterModelMismatch";
      readonly modelRef: string;
      readonly adapterId: string;
      readonly catalogAdapterId: string;
    };
```

**构造来源**（唯一）：Composition Root。生产 env 映射冻结为（正式化现 `providerFromEnv`）：

```
ARBOR_PROVIDER_DEPLOYMENT_ID   → deploymentId（缺省 dep-env）
ARBOR_MODEL_BASE_URL           → endpoint（要求非空才构造真实 deployment）
ARBOR_MODEL_NAME               → wireModelName
ARBOR_MODEL_API_KEY_VAR        → secretRef（SecretRef = env 变量名；缺省 ARBOR_MODEL_API_KEY）
ARBOR_MODEL_POLICY_JSON        → 可选 executionPolicyOverrides（JSON）
```

三个必填变量任一缺失 = 回落 `provider-fake`（CI 无网络语义不变，P12 `12` §2 沿袭）。

**解析规则**（纯函数，`resolveModelBinding(registry, catalog, deployment): ResolvedModelBinding | ResolveModelBindingError`）：
1. `deployment.modelRef` → catalog 条目；未命中 → `UnknownModelRef`。
2. 条目 `adapterId` → registry 命中；未命中 → `UnknownAdapter`。
3. 交叉校验（现 composition 内联 throw 的正式化）：catalog 条目 adapterId 与 registry 命中一致，否则 `AdapterModelMismatch`。
4. profile.authMode = BearerSecret 且 deployment.secretRef 缺失 → `DeploymentIncomplete`。
5. 有 endpoint 要求的协议族（非 in-process）缺 endpoint → `DeploymentIncomplete`。
6. 策略合成：`resolveProviderExecutionPolicy`（P15）默认 ⊕ overrides。

---

## 6. ProviderRegistry（冻结）

```ts
export interface ProviderRegistry {
  /** 静态封闭列表；构造于 Composition Root。 */
  readonly adapters: ReadonlyArray<ProtocolAdapter>;
  readonly find: (
    adapterId: ProtocolAdapterId,
  ) => ProtocolAdapter | undefined;
  /** 重复 adapterId 在构造时即 throw（fail-fast）。 */
}

export const makeProviderRegistry = (
  adapters: ReadonlyArray<ProtocolAdapter>,
): ProviderRegistry;   // 重复 id → throw "duplicate adapterId"
```

**注册协议（"新增一个兼容 Provider"的完整动作集）**：
1. 新包 `adapters/provider-<family>/`（依赖边仅 `domain`+`ports`，同现存家族，DAG §9）。
2. 包内导出 `ProtocolAdapter` 值（adapterId + profile + layerFor）。
3. Composition Root 注册表**追加一行**（声明式数据表，非逻辑代码）。
4. （若引入新 modelRef）catalog 追加 `ModelProfile` 条目（纯数据）。
5. 通过 conformance suite（E3）→ 才允许注册进**生产** registry（测试 registry 不受限）。

**禁止**（INV-P16-2/3）：文件系统扫描、dynamic import、环境变量驱动发现、LLM/运行时决策选择 adapter。`selectProviderLayer` 的封闭 union 在 Gate B 由 registry 取代（该函数为 P12 `12` §2 冻结实现的**泛化重构**，语义不变：仍是 Composition Root 单点）。

---

## 7. CapabilityQualification（冻结）

资格对象 = **deployment**（不是 adapter、不是 modelRef）：同一 adapter 家族在不同 endpoint/模型上有不同行为，资格必须绑定具体部署。

```ts
export interface CapabilityQualification {
  readonly deploymentId: string;
  readonly adapterId: ProtocolAdapterId;
  readonly modelRef: string;
  /** capability 证据根（现有 planning/testing/core-capability/evidence/…）。 */
  readonly evidenceDir: string;
  /** three-run stability oracle 的通过计数（≥3）。 */
  readonly stableRuns: number;
  readonly serverBuildId?: string;      // 现有 HttpProviderRuntime.serverBuildId
  readonly modelRevision?: string;
  readonly qualifiedAt: string;         // ISO 8601
  /** conformance suite 结果引用（离线 fake-transport 跑，见 E3）。 */
  readonly conformanceRun: string;
}
```

**资格项**（生产 deployment 准入 = 全部满足）：
| # | 项 | 机械判据 |
|---|---|---|
| Q1 | 离线 conformance | E3 suite 全绿（fake transport，无网络） |
| Q2 | 真实端点 three-run | `run-capability.mjs --repeats 3` 全过，evidence 文件 ≥3 份（现有 oracle） |
| Q3 | 身份绑定 | evidence 目录含 provider-config（endpoint/model/serverBuildId），与 deployment 字段一致 |
| Q4 | 能力位一致 | profile.capabilityFlags 与 evidence 中实际观察一致（Q2 观察到 cache token 报告而 flags 声明 false → 拒绝） |

CI 不依赖资格（CI 永远 fake）；资格是**生产 deployment 启用**的流程前置（main.ts 显式配置 + evidence 存在性检查，Gate B 落地为 `verify-provider-extension.mjs --check-qualification`，非运行时强制）。

---

## 8. 包边界与依赖 DAG（冻结增量）

`ALLOWED_EDGES` 增量（tests/architecture/package-dag.ts）：

```
provider-<family>（任意新家族）: ["domain", "ports"]
```

不变量（INV-P16-1）：`domain | ports | application | model-context | agent-runtime | execution-runtime | provider-runtime` 的 `internalDependencies` 中**永不出现**任何 `provider-*`（现存 provider-fake/provider-openai 同样满足）。反向边仅存在于：Composition Root（apps/single-workspace/src）与 tests。

## 9. Invariants 汇总

```
INV-P16-1  core 包不得依赖任何 adapters/provider-*（DAG 机械断言）
INV-P16-2  ProviderPort Layer 构造封闭于 adapters/provider-*/src + composition 注册表单点
INV-P16-3  registry 静态封闭；禁止自动发现（fs 扫描 / dynamic import / env 发现 / LLM 决策）
INV-P16-4  binding 解析失败 = typed ResolveModelBindingError；无 silent fallback（SD §6.2）
INV-P16-5  capabilityFlags 声明 true ⇔ 对应 conformance 用例 + qualification 证据存在
INV-P16-6  P16 不引入 agent-runtime 的任何 import/行为变更（Gate B diff 为空）
INV-P16-7  Profile/Deployment/Registry 是纯数据（函数字段仅 ProtocolAdapter.layerFor）；可 JSON 序列化
INV-P16-8  deployment 只携带 SecretRef；raw secret 仅执行边界解析（P12 `03` no-leak 全覆盖）
```

---

## 10. 明确范围外（Out of Scope）

1. 真实新 provider 家族接入（含 Anthropic/Google 等；Gate B 只用 in-process fake 家族做 proof）。
2. cache-token 提取与 ContinuationState 生产实现（仅冻结能力位）。
3. Agent Runtime 任何改动。
4. P12 usage/cost 面板、pricing 引擎。
5. 运行时资格强制（资格是流程 + 机械存在性检查，非 runtime gate）。
6. 多 deployment 同时在线/路由策略（单 deployment per process，v1 语义不变）。

—— Gate A 文档止于此。实现授权见 `02-extensibility-proof-plan.md`（Gate B 清单）。
