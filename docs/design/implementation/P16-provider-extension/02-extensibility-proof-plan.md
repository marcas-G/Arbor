# P16 Extensibility Proof Plan — 机械验收方案 (Gate B 定义)

**前置**: `01-provider-extension-contracts.md` FROZEN 且评审 Blocking=0。
**本文档定义**: "新增一个兼容 Provider 不改 core"的**机械可判定**验收，以及 Gate B 的 exit criteria。Gate B 启动须治理方显式授权。

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

### E4 不改 core 证明（proof-by-construction，核心验收）

两个组件：

**(a) 脚本**: `scripts/testing/verify-provider-extension.mjs`
```
用法: node scripts/testing/verify-provider-extension.mjs --base <commit> --head <commit> [--family <id>]
判据: git diff --name-only base..head 的路径集 D：
      D ⊆ (adapters/provider-<family>/** ∪ WL ∪ tests/** ∪ scripts/** ∪ docs/** ∪ planning/** ∪ *.md ∪ package.json/pnpm-lock 只读边)
      且 (D ∩ CORE) = ∅            → exit 0
      否则列出违规路径              → exit 1
```

**(b) Proof 家族**: Gate B 实现一个 `provider-testecho`（in-process 确定性家族，**非真实 provider**，遵守 Scope guard 1）：回显请求摘要的极简 adapter。验收动作：
1. 以 Gate B 起点 commit 为 base，testecho 完成点为 head，跑 (a) 脚本 → exit 0。
2. testecho 通过 E3 conformance 全绿。
3. E1/E2 架构测试在 head 上绿。
4. `git diff base..head -- packages/agent-runtime` 输出为空（Scope guard 2 的直接证据）。

三者同时成立 = **命题 P 成立的构造性证明**（存在一个真实完成的新增家族，其 diff 满足全部机械约束）。

**判据**: 脚本 exit 0 + conformance 绿 + arch 绿 + agent-runtime 空 diff。

### E5 资格证据（deployment 级）

生产 deployment（当前唯一：DeepSeek 端点）必须有：
1. three-run evidence（现有 `planning/testing/core-capability/evidence/real-provider/**`，B 系列已有 ≥3 份/用例）。
2. `verify-provider-extension.mjs --check-qualification --deployment-id <id>`：机械检查 evidence 目录存在性 + provider-config 与 `ModelDeployment` 字段一致性 + conformance run 引用存在。
**判据**: 脚本 exit 0。

---

## 2. Gate B Exit Criteria（授权后逐项机械核对）

```
B-1  packages/ports/src/provider-extension.ts 落地，字段与 01 文档逐字一致（新增文件，ports 无其他 diff）
B-2  ProviderRegistry 于 Composition Root 落地；selectProviderLayer 由 registry 取代（语义等价重构，P12 `12` §2 单点不变）
B-3  providerFromEnv 正式化为 ModelDeployment 构造（env 映射按 01 §5；缺省回落 fake 不变）
B-4  E1/E2 落地（tests/architecture/p16-architecture.test.ts）且绿
B-5  E3 落地（tests/provider-conformance/ + run 脚本）；provider-openai、provider-fake 双基线全绿
B-6  E4 落地（verify-provider-extension.mjs + provider-testecho proof 家族）；base/head 验收 exit 0；agent-runtime diff 为空
B-7  E5 落地（--check-qualification 对 dep-env/DeepSeek 通过）
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
