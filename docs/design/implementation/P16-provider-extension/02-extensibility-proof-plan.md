# P16 Extensibility Proof Plan — 机械验收方案 (Gate B 定义)

**前置**: `01-provider-extension-contracts.md` FROZEN 且评审 Blocking=0。
**Gate B 裁决（治理方，2026-09-29）**: Design Closure = ACCEPTED；implementation = AUTHORIZED。两项澄清并入 acceptance contract：
1. E4 拆分为 **E4a Compatible Provider Extensibility**（同协议族新增 Provider = 纯 profile/model/deployment/qualification 数据与测试，不改 core 或 ProtocolAdapter）与 **E4b Protocol Extensibility**（新增协议族 = 仅新增 ProtocolAdapter implementation + registry 注册，不改 Provider Runtime / Model Context / Agent Runtime / CanonicalProviderEvent）；弃用"纯数据新增 protocol family"表述。
2. CapabilityQualification 绑定 `ResolvedModelBinding` fingerprint 并记录完整身份/版本（model revision、server build、parser profile 可获得时纳入）；冻结 INV-P16-9（declared ≠ qualified ⇒ FAIL）与 INV-P16-10（evidence 不修改声明面）。
**Scope guards（重申）**: 不接真实新 Provider；不修改 Agent Runtime；不扩 Model Context semantic compilation；不实现 cache usage / native continuation；不扩大 CanonicalProviderEvent。**E4a/E4b 任一无法成立时 STOP，不进入后续 Provider 扩族。**

---

## 0. 命题的形式化

**命题 P（扩展性）**：新增一个兼容 provider 家族 F，所需全部变更为：
```
A. 新目录 adapters/provider-F/**            （新增）
B. 注册表数据文件追加一行                    （数据追加，白名单路径）
C. catalog 数据文件可选追加条目              （数据追加，白名单路径）
D. tests/** 与 scripts/** 与 docs/**         （测试/工具/文档）
```
且 **不包含** 任何 core 路径变更：
```
CORE = packages/domain/**, packages/ports/**, packages/application/**,
       packages/model-context/**, packages/agent-runtime/**,
       packages/execution-runtime/**, packages/provider-runtime/**,
       packages/projection-runtime/**, packages/tool-runtime/**,
       apps/single-workspace/src/**, apps/web/**, adapters/(非 provider-F 的既有包)/**
```
其中 B/C 的白名单：
```
WL = apps/single-workspace/src/provider-registry.table.ts   （纯数据表：数组字面量，禁止逻辑）
     packages/model-context/src/model-catalog.data.ts        （纯数据表：DEFAULT_MODEL_CATALOG 迁出）
```
"机械验收" = 存在脚本，输入 (base, head) 两个 commit，输出 exit 0/1，无人为判断。

---

## 1. 验收 Gates E1–E5

### E1 依赖方向（architecture test）

**位置**: `tests/architecture/p16-architecture.test.ts`（挂入现有 pnpm architecture）。
**断言**:
1. `package-dag.ts` 的 `ALLOWED_EDGES` 增加规则：任意 `provider-*` 包（含未来家族）依赖仅 `["domain","ports"]`——对 `packages/*/package.json` 动态枚举实现，新家族**自动**落入（新家族不需改此测试）。
2. 反向断言：core 包集合（§0 CORE 的 packages/*）的 internalDependencies 与 `provider-*` glob 求交集必须为空（INV-P16-1）。
3. agent-runtime 源码 import 扫描：`packages/agent-runtime/src/**` 中不出现 `provider-extension` 合同符号（INV-P16-6 的 import 面）。
**判据**: 测试绿 = E1 过。

### E2 单点构造（封闭集合扫描）

**位置**: 同 E1 测试文件。
**断言**: 全仓（除白名单）源码中，`ProviderPort` Layer 的构造调用（`Layer.succeed(ProviderPort` / `Layer.effect(ProviderPort` / 直接 `ProviderPort.of(`）只出现在：
```
adapters/provider-*/src/**
apps/single-workspace/src/composition.ts（registry 装配点）
packages/testkit/**（测试替身）
```
**实现**: 现有 p2/p3 architecture 测试的源码扫描模式（读文件 + 正则），封闭路径集合硬编码于测试。
**判据**: 测试绿 = E2 过（INV-P16-2/3）。

### E3 Provider Conformance Suite（"兼容"的机械定义）

**位置**: `tests/provider-conformance/`（新目录）+ `scripts/testing/run-provider-conformance.mjs`。
**设计**: 用例集**面向 `ProtocolAdapter` 接口**编写（非面向具体家族），transport 全部注入 fake（复用 `OpenAICompatibleFetch` 注入口模式；in-process 家族自带确定性）。每项用例 = 一个冻结编号：

| # | 用例 | 断言要点 |
|---|---|---|
| A1 | text-delta-order | delta 顺序保持、聚合等于完整文本 |
| A2 | tool-call-reassembly | 分片/乱序 index 重组、并行 call 参数流隔离 |
| A3 | sse-arbitrary-chunking | 事件流任意字节分块下无损 |
| A4 | usage-extraction | prompt/completion tokens 提取进 UsageReported |
| A5 | error-taxonomy-table | 429/401/403/400/422/5xx/ECONNRESET/畸形帧 → 封闭 12 类映射正确；未知→UnknownProviderFailure；异常对象不跨 port 边界 |
| A6 | cancellation-propagation | abort 后 ≤ 一个微任务内停止产出，无残余事件 |
| A7 | auth-fail-closed | BearerSecret 且无凭证 → AuthenticationFailed 拒绝；豁免须显式 |
| A8 | three-phase-timeout | connect/firstEvent/streamIdle 各自触发对应 Timeout 相位 |
| A9 | observation-persistence | attempt 观测/checkpoint 经 ProviderRuntime 落库（跑 runtime 集成小夹具） |
| A10 | contract-noise-drop | 产出未冻结事件 tag / 声明 false 的能力位事件 → runtime 丢弃并 audit |

**跑法**: `node scripts/testing/run-provider-conformance.mjs --adapter <moduleId>`——每个 adapter 包导出标准 harness 入口（`conformanceTarget(): ProtocolAdapter + transportDoubles`）。**新家族通过同一 suite 全绿 = 机械意义上的"兼容 Provider"**（INV-P16-5 的 Q1）。
**判据**: provider-openai 与 provider-fake 双基线全绿；proof 家族（见 E4）全绿。

### E4 扩展性证明（proof-by-construction，核心验收；Gate B acceptance 澄清 1 拆分）

扩展性有两个**不同**的命题，必须分别证明。~~"纯数据新增一个新 protocol family"~~ 的表述不成立，弃用。

**脚本**: `scripts/testing/verify-provider-extension.mjs`（两命题共用；`--mode compatible|protocol`）

```
用法: node scripts/testing/verify-provider-extension.mjs --mode <compatible|protocol> --base <commit> --head <commit> [--family <id>]
判据: D = git diff --name-only base..head 的路径集
      exit 0 ⇔ D ⊆ 允许域 且 D ∩ 禁止域 = ∅；否则列出违规路径 exit 1
```

#### E4a Compatible Provider Extensibility（同协议族新增 Provider）

**命题 P-a**：在**已有协议族**下新增一个 Provider（新供应商端点/新模型，复用既有 ProtocolAdapter），所需全部变更为 **profile / model / deployment / qualification 数据与测试**：

```
允许域:  WL（registry 表 + catalog 数据 + deployment 数据文件）
         tests/**, scripts/**, docs/**, planning/**, *.md
禁止域:  CORE 全集（§0）∪ adapters/**（含所复用的 adapter——同族新增必须零 adapter diff）
```

**Proof 主体（Gate B）**: `dep-openai-compat-echo` —— 一个 openai-chat-completions-sse 族的新 provider：新 `ModelProfile`（model-openai-compat-echo）+ 新 `ModelDeployment`（dep-openai-compat-echo，fake endpoint 数据）+ 离线 qualification 记录 + conformance 测试（走 provider-openai adapter + 注入 transport）。**base = C1（B-1..B-5+脚本完成点），head = C2**：
1. verify 脚本 `--mode compatible --base C1 --head C2` → exit 0
2. 该 deployment 的 conformance 用例绿（E3 同套件）
3. `--check-qualification --deployment-id dep-openai-compat-echo` → exit 0

#### E4b Protocol Extensibility（新增协议族）

**命题 P-b**：新增一个**真正的新协议族**，所需全部变更为**新增 ProtocolAdapter implementation + registry 注册（WL 一行）+ 测试**：

```
允许域:  adapters/provider-<family>/**
         WL（registry 表追加一行；catalog 可选数据条目）
         tests/**, scripts/**, docs/**, planning/**, *.md, workspace 配置（package.json/pnpm-workspace.yaml/pnpm-lock.yaml）
禁止域:  packages/provider-runtime/**, packages/model-context/**, packages/agent-runtime/**,
         packages/ports/src/provider.ts（CanonicalProviderEvent 及全部既有 port 合同）,
         其余 CORE
```

（注：E4b 的 base 取 C2——ports 的 `provider-extension.ts` 等 Gate B 基础设施在 C1 已落地，属命题外的前置。）

**Proof 主体（Gate B）**: `provider-testecho` —— in-process 确定性回显家族（**非真实 provider**，遵守 Scope guard 1），声明 in-process 确定性协议族（`protocolFamily: "in-process-deterministic"`；值域开放性已由 ProviderProtocolFamily 类型证明）。**base = C2，head = C3**：
1. verify 脚本 `--mode protocol --base C2 --head C3 --family provider-testecho` → exit 0
2. testecho 通过 E3 conformance 全绿（作为新家族的机械"兼容"判据）
3. E1/E2 在 head 上绿
4. `git diff C2..C3 -- packages/agent-runtime packages/provider-runtime packages/model-context packages/ports/src/provider.ts` 输出为空（禁止域直接证据）

**两命题任一不成立（脚本 exit 1 或 conformance/arch 不绿）⇒ STOP：Gate B 不得关闭，不进入后续 Provider 扩族。**

### E5 资格证据（deployment 级）

生产 deployment（当前唯一：DeepSeek 端点 dep-env）必须有：
1. three-run evidence（现有 `planning/testing/core-capability/evidence/real-provider/**`，B 系列已有 ≥3 份/用例）。
2. `verify-provider-extension.mjs --check-qualification --deployment-id <id>`：机械检查——
   - `planning/testing/provider-qualification/<deploymentId>/qualification.json` 存在；
   - `identity` 字段与当前 deployment/adapter/profile 一致；
   - `bindingFingerprint` 与当前 ResolvedModelBinding 重算值一致（不一致 ⇒ 证据过期 FAIL）；
   - `declaredCapability` = 当前 ModelProfile.capability（不一致 ⇒ FAIL，INV-P16-9 前半）；
   - `declaredCapability` = `qualifiedCapability`（不一致 ⇒ FAIL，INV-P16-9）；
   - `conformanceRun` 引用存在；`stableRuns ≥ 3`（真实端点 deployment）。
**判据**: 脚本 exit 0。离线 proof deployment（dep-openai-compat-echo）Q2 按 `in-process/fake endpoint` 语义豁免 three-run（identity.providerSite 声明非真实端点）。

---

## 2. Gate B Exit Criteria（授权后逐项机械核对）

```
B-1  packages/ports/src/provider-extension.ts 落地，字段与 01 文档逐字一致（新增文件，ports 无其他 diff）
B-2  ProviderRegistry 于 Composition Root 落地；selectProviderLayer 由 registry 取代（语义等价重构，P12 `12` §2 单点不变）
B-3  providerFromEnv 正式化为 ModelDeployment 构造（env 映射按 01 §5；缺省回落 fake 不变）
B-4  E1/E2 落地（tests/architecture/p16-architecture.test.ts）且绿
B-5  E3 落地（tests/provider-conformance/ + run 脚本）；provider-openai、provider-fake 双基线全绿
B-6  E4a/E4b 落地（verify-provider-extension.mjs + dep-openai-compat-echo 同族 proof + provider-testecho 新族 proof）；
     E4a: --mode compatible --base C1 --head C2 exit 0；E4b: --mode protocol --base C2 --head C3 exit 0；
     conformance/arch 绿；禁止域 diff 为空。E4a/E4b 任一不成立 ⇒ STOP
B-7  E5 落地（CapabilityQualification + bindingFingerprint + --check-qualification 对 dep-env 与 dep-openai-compat-echo 通过）
B-8  pnpm check 全绿（lint + typecheck + architecture + 全部 test + web）
B-9  capability B 系列（B01–B14）无回归
B-10 Scope guards 复核：无真实新家族接入；无 cache/continuation 实现；agent-runtime diff 为空
```

## 3. CI 接线

- E1/E2 随 `pnpm architecture` 常驻。
- E3 双基线（openai/fake）随 `pnpm test` 常驻（离线 fake transport，无网络）。
- E4 脚本不进 CI（PR 级验收工具：base=merge-base，head=HEAD，供 review 与 gate 流程调用）。
- E5 不进 CI（生产 deployment 准入流程工具）。

## 4. 风险与显式不做

- **不做** registry 的运行时热更新/多 deployment 路由（v1 单 deployment，01 §10.6）。
- **不做** conformance 对真实网络的依赖（A 系全部离线；真实端点行为归 E5/capability）。
- **风险 R1**: WL 文件被塞入逻辑代码 → E2/E1 的扫描同时覆盖 WL（WL 中禁止出现除数据字面量外的可执行语句，lint 级检查并入 p16 architecture 测试）。
- **风险 R2**: 新家族绕过 registry 直接被 composition 引用 → E2 封闭集合不含新家族路径即红。
