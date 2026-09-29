# P16 Gate C — Live Provider Qualification Contract & Three-Layer Test Plan (FROZEN design)

**Status**: Gate C Design Closure（本轮只设计，不执行真实 provider、不实现）。
**Baseline**: master@6f181f6。

---

## C3 — Live Provider Qualification Contract

### 3.1 Capability 维度（冻结，封闭集合）

```ts
type QualificationCapability =
  | "text"                        // 非流式语义文本往返
  | "streaming"                   // 流式 delta 序列
  | "tool-simple"                 // 单个完整 tool call
  | "tool-fragmented-args"        // 分片参数重组
  | "tool-multiple"               // 并行多 tool call
  | "reasoning"                   // 推理内容往返（作为附件回传）
  | "reasoning-with-tools"        // 推理 + tool 组合
  | "structured-output"           // outputContract JSON 校验通过
  | "cache-usage"                 // canonical cache token 提取（C1 §1.6）
  | "provider-continuation"       // resume/retry 传输续传（C2 §2.1）
  | "reasoning-round-trip"        // reasoning 附件多轮保持（C2 §2.2）
  | "cancellation";               // abort 停止产出
```

### 3.2 资格状态（冻结，封闭 5 值）

```ts
type QualificationStatus =
  | "DECLARED"     // 声明面（profile/capabilityFlags/catalog）声明支持，尚无证据
  | "PROVEN"       // L1/L2/L3 oracle 按该 capability 的证据等级全部通过
  | "UNSUPPORTED"  // 声明面明确不支持（与 DECLARED 互斥；声明即非 UNSUPPORTED）
  | "FAILED"       // 运行了 oracle 且失败（含 declared≠observed）
  | "NOT_RUN";     // 未运行（含：真实端点不可达、本轮豁免、条件不满足）
```

**判定与使用规则（冻结）**：
- `INV-C3-1（NOT_RUN ≠ PROVEN）`：生产选择不得把未运行的能力当作已证明能力。资格记录是唯一事实源；任何 capability 消费方读取状态时必须按 5 值枚举分支，禁止将非 PROVEN 默认为可用。生产 deployment 启用检查：被消费场景引用的 capability 必须 `PROVEN`，否则启动降级/拒绝（实现授权后落为 composition 断言，非运行时自动猜测）。
- `INV-C3-2（declared ≠ qualified ⇒ FAILED）`：沿 INV-P16-9 下推到每 capability：声明支持而 oracle 未复现 = FAILED；未声明而 oracle 观察到 = FAILED（声明面诚实性）。
- DECLARED 是过渡态：生产消费不允许停留在 DECLARED（同 INV-C3-1）。
- UNSUPPORTED 不是失败：是声明面的负向事实，生产永不消费。

### 3.3 记录结构（冻结——CapabilityQualification 的授权后扩展形态）

```ts
interface CapabilityQualificationRecord {
  readonly bindingFingerprint: string;      // Gate B 既有：绑定为 ResolvedModelBinding
  readonly identity: {                      // Gate B 既有全量身份
    readonly adapterId: string;
    readonly providerSite: string;
    readonly wireModelName: string;
    readonly modelRevision?: string;        // 可得时
    readonly serverBuildId?: string;        // 可得时
    readonly parserProfile?: string;        // 可得时
    readonly protocolFamily: string;
  };
  readonly qualificationRunnerVersion: string;   // 新增：oracle 本身可追溯
  readonly capabilities: ReadonlyArray<{
    readonly capability: QualificationCapability;
    readonly status: QualificationStatus;
    readonly evidence: ReadonlyArray<{ readonly layer: "L1" | "L2" | "L3"; readonly artifact: string }>;
  }>;
}
```
artifact 全部落在 `planning/testing/provider-qualification/<deploymentId>/`（L1/L2 为离线 run id，L3 为现有 real-provider evidence 文件引用）。

---

## C4 — Three-Layer Acceptance Plan（L1/L2/L3）

### 4.0 层定义

| 层 | 对象 | 环境 |
|---|---|---|
| **L1 codec/semantic** | adapter 纯翻译函数：native 帧 ↔ canonical（usage 解析、reasoning 提取、tool 重组、continuation checkpoint 编解码） | 离线、确定性、recorded 帧 fixtures |
| **L2 controlled adapter/runtime** | adapter + ProviderRuntime 全链（超时/重试/恢复/取消/持久化） | 注入 transport double（conformance 模式） |
| **L3 real-provider qualification** | 真实 deployment | 真实端点，three-run stability oracle |

### 4.1 每 capability 的 oracle（冻结）

| capability | 层级要求 | PASS oracle | FAIL oracle | NOT_RUN 条件 | UNSUPPORTED 条件 | evidence artifact |
|---|---|---|---|---|---|---|
| text | L1+L2+L3 | 语义答复与请求相关性断言 + conformance A1/A4 + L3 3-run 稳定 | 任一层失败/响应无语义内容 | 真实端点未配置 | profile 未声明 text | L1 run id · L2 run id · L3 evidence ×3 |
| streaming | L2+L3 | A1 delta 序列 ≥2 增量且聚合=L3 完整文本；3-run | 单块到达（非流）/顺序错乱 | 同上 | `streamsDeltas=false` | L2 conformanceRun · L3 evidence |
| tool-simple | L1+L2+L3 | 完整 tool call（name+合法 JSON args）+ A2 | 无 call/args 非法 | 端点未配或模型未配 tools | capability 无 "tools" | 三层引用 |
| tool-fragmented-args | L1+L2+L3 | A2 分片重组 == 完整发送的 args | 重组错字/丢片 | 同上 | 同上 | 同上 |
| tool-multiple | L2+L3 | A2 双 call 并行隔离 | 参数串流 | 同上 | 同上 | 同上 |
| reasoning | L1+L3 | L1: reasoning 帧→ReasoningDelta+附件提取正确；L3: 响应含 reasoning 且 3-run | 无 reasoning 产出但已声明 | 模型未开推理 | 声明无 reasoning | L1 run id · L3 evidence |
| reasoning-with-tools | L3 | 同一响应同时含 reasoning 与 tool call | 二者缺一（已声明） | 条件不满足 | 声明不支持组合 | L3 evidence |
| structured-output | L2+L3 | 响应通过 outputContract schema 校验（decodeTurn 无 violation） | violation 且 repair 耗尽 | 未配置 contract | 模型无 JSON 模式声明 | L2 · L3 evidence |
| cache-usage | L1+L3 | C1 §1.6：native cache 字段与 canonical 值逐次相等×3 | 值不等/伪造 0 | 端点无 cache 报告帧 | `reportsCacheTokens=false` | L1 · L3 evidence |
| provider-continuation | L2 | checkpoint resume 重放 == 前缀 + 续传（SafeResume 路径复现） | resume 后语义损坏 | 无 L2 夹具条件 | `supportsContinuation=false` | L2 run id |
| reasoning-round-trip | L3 | 多轮会话中第 2 轮请求携带第 1 轮 reasoning 附件（wire 抓帧证明） | 附件丢失/格式错 | 单轮场景 | 声明无 reasoning | L3 wire evidence |
| cancellation | L2 | A6：abort 后 ≤ 微任务级停止产出 | 继续产出 | —（离线必测） | —（必测项） | L2 conformanceRun |

### 4.2 机械入口（授权后实现，本轮仅定义）

- `scripts/testing/run-provider-qualification.mjs --deployment-id <id> --layer L1|L2|L3` → 产出/更新 `CapabilityQualificationRecord` + capabilityRecords 状态机。
- L1/L2 随 `pnpm check` 常驻（离线）；L3 手动/治理触发（真实端点，three-run）。
- `verify-provider-extension.mjs --check-qualification` 扩展：按 3.2 规则校验状态机合法性（非 PROVEN 冒充、DECLARED≠PROVEN 消费、FAILED 仍启用 ⇒ exit 1）。

---

## PERSISTENCE_OWNERSHIP（汇总冻结）

| 数据 | owner 层 | 位置 |
|---|---|---|
| attempt canonical 事件前缀（含 usage 帧） | ProviderRuntime（写）/ adapter（产） | `provider_attempts.canonical_event_prefix_json` |
| Turn 级 canonical usage 聚合 | ProviderRuntime | `provider_turns.usage_json`（§C1 1.5 形状） |
| continuation checkpoint | ProviderRuntime | `provider_attempts.continuation_checkpoint_json` + retry decision |
| reasoning 附件 | Model Context（引用）/ conversation history（体） | projected turn history + manifest contextRefs |
| capability 资格记录 | 治理/qualification runner | `planning/testing/provider-qualification/<dep>/` |

## CHANGED_FROZEN_CONTRACTS（全部为"授权后"最小变更，本轮零代码）

1. `CanonicalProviderEvent.UsageReported` + `reasoningTokens?: number`（C1 §1.7 三条件论证成立；缺省=未报告）。
2. `CapabilityQualification` → `CapabilityQualificationRecord`（capabilities 状态矩阵 + qualificationRunnerVersion；向后兼容保留旧字段）。
3. `provider_turns.usage_json` JSON 形状 = CanonicalUsage（null 语义）。
不变更：CanonicalProviderEvent 事件 tag 集、ProviderContinuationCheckpoint、PortableModelRequest、Agent Runtime、AgentAction、Model Context semantic compilation。

## UNCHANGED_INVARIANTS

INV-P16-1…10 全部保持；SD 20/45/56；P12 TR-4/TR-5；DID §6A.8/§6A.9。新增：INV-C1-1/2/3、INV-C2-0/1/2、INV-C3-1/2。

## DESIGN_GAPS

无阻塞性缺口。两项实现期注意（非缺口）：
1. reasoning 附件的 conversation-history 物理载体在 P13/P14 projected history 中的具体列/JSON 附件形态——实现授权时按最小 DDL 变更提案另行冻结。
2. L3 wire 抓帧（reasoning-round-trip 证据）需要 capability 体系已有 http-sdk-client 证据通道，直接复用。

## GATE_C_IMPLEMENTATION_AUTHORIZATION（未授权——本轮仅定义 exit criteria）

```
C-1  CanonicalUsage 落地（ports 类型 + UsageReported.reasoningTokens 最小变更 + settleTurn 聚合 + observation 校验）
C-2  L1/L2 capability oracle 落地并随 pnpm check 常驻（12 项中离线可测子集）
C-3  qualification runner（记录状态机 + --check-qualification 状态机合法性校验）
C-4  E1–E5 复归绿 + pnpm check 全绿 + scope guards 复核
C-5  真实新家族接入（含 cache/continuation 的生产实现）仍需独立授权（不在 Gate C 实现内）
```
