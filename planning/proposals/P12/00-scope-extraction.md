# P12 — Design Closure: Scope Extraction & Classification (PROPOSAL, not frozen)

> 依据治理指令：本轮仅做**范围提取、三分类与治理问题清单**（独立 gap review 后只返回 true
> governance questions）；**不起草 P12 契约、不生成 planning、不修改 design files**。
> 六个只读研究分支（Plugin SDK / providers+tools / remote Worker / PostgreSQL / observability /
> security+perf+收敛项）并行产出后合成，全部论断已在仓库内复核。

**Authority:** DID v1.13 §11 P12, §0.3 (empirical 冻结规则), §6.3 (fencing 范围), §7.2/§7.5/§7.6/§7.9, §8.4/§8.16A, §9.1–§9.13, §10.1/§10.2/§10.4.1/§10.5/§10.6, §12.3/§12.10, §13; v1.13 G4/G6/G7; SD v1.3 §6.1/§6.2/§7.7/§8/§8A/§10.2/§10.7/§12/§13/§14 (No.15/16/45/48/54/56/60); P0–P11 contracts; `planning/results/{P9,P10,P11}.result.md`.
**Status:** SCOPE EXTRACTION (round 1) — awaiting governance decisions **GQ1–GQ8** before any contract drafting.

## 1. Scope (DID §11 P12 七关键词 + 前向引用)

```text
Plugin SDK
more providers/tools
remote Worker
PostgreSQL migration if justified
observability
security hardening
performance
```

前向引用（已冻结、由 P12 承接）：

- DID v1.13 **G4**: External Human/Parent **Stop** 的 authority resolver 归 P12（P6/P10 不实现 resolver）。
- DID v1.13 **G6**: P12 owns HTTP/WebSocket/CLI/web shell/auth/deployment **transport**；不重新解释 view semantics；绑定 P10 的 `api-contracts` DTO。
- DID v1.13 **G7**: `HumanInterventionApplied` payload 冻结 `{actor,targetWorkspaceId,summaryRef,occurredAt,kind}`，human-originated command 同事务发射（含 **Critical-Steer 路径**）。
- P9 deferrals: recovery daemon/composition surface (`P9/00:43`)；distributed/multi-host lease & recovery (`P9/03 §5:112`)。
- P11 deferrals: drift watcher (`P11/05 §2`)、snapshot pruning (`P11/02 §3`)、resolver caching (`P11/04 §3`)、以及三条 P12 收敛项 (`P11.result.md:53-59`)。
- P10 deferral: Search view transport (`P10/01:19`)。

明确**不在** P12：view semantics（P10）、dependency coordination（P7）、verification verdict/acceptance（P8）、canonical domain 语义（DID-owned）、SQLite→PG 的强制迁移（`if justified`）。

## 2. Classification

### A. Upstream design defects / ambiguities（需治理裁决）

| # | 事项 | 证据 | 建议 |
|---|---|---|---|
| UD-1 | **"Plugin SDK" 零定义**：全冻结语料仅 P12 关键词一处；DID §10.1/§10.4.1 只有 `packages/*`/`adapters/*`/`apps/*`，无 plugin 类别；执行/隔离/信任模型（进程内 adapter / 外部进程 / 声明式）与 allowed-edge 影响未定 | `DID:3893`（唯一出现）；`DID §10.1:3456-3488`；`§10.4.1:3539,3574` | **GQ1** |
| UD-2 | **扩展 SPI 无对外兼容/版本化政策**：`api-contracts` 被称 "外部 API/产品契约"，但 ports / tool schemas / prompt programs / provider adapters 无 compat/semver/deprecation/breaking-change 规则（全库仅内部 `eventVersion` 前向兼容） | `DID §10.2:3504`；`§10.5:3584`；`P10/05 §3:48-58`；`P1/05 §3` | **GQ1** |
| UD-3 | **`ToolDefinition.source:"Project"` 的信任/注册模型零定义**：类型已冻结但无 project/第三方工具语义（注册、schema 校验、capability/authority ceiling、catalog 作用域）；catalog 仅 `BUILTIN_TOOLS` | `ports/tool.ts:41`；`P4/01 §1`；`tool-runtime/src/catalog.ts`；`DID §7.6:2402-2408`；SD §8.2 | **GQ1** |
| UD-4 | **tool `InvocationAuthority` 的生产者无 phase**：P4 G1 明示 resolver 延后，P1/P2/P6 均写 "a later phase"；DID v1.13 G4 只把 **External Stop** resolver 点名给 P12，未覆盖 tool capability resolver | `DID:67-70`；`DID v1.13 G4:97-101`；`P4/03 §1/§6:7-10,83-87`；`P1/01 §9:340-349` | **GQ2** |
| UD-5 | **`ToolCatalogPort` 无法提供 model-facing tool schema/description**（跨 phase 冻结契约冲突）：DID §7.6 要求 catalog 提供 Schema/description；P3/P4 收窄为 `ToolDefinitionRef`；model-context 因 `!-> tool-runtime` 只能发占位符 | `DID §7.6:2367-2378` vs `P3/01 §1:8-15`、`P4/01 §1:24-28`；`model-context/src/compiler.ts:106-110`（`description:name, schemaJson:"{}"`） | **GQ3** |
| UD-6 | **"observability" 无契约**：无 Logger/Metrics/Tracing/Telemetry port；SD 把资源/性能数据归 "Telemetry" 但无契约、无保留期、无 producer/consumer | `DID §11:3897`；`SD §10.2:1102`；`SD §6.1:652`/`§13.7:1405`；`DID §7.2:2205-2224`（无 telemetry port） | **GQ4** |
| UD-7 | **operational/health 可见性无 owner/view**：durable ops 记录存在（leases / agent_execution_state / command_attempts / consumer_offsets），但 SD §12 权威 view 清单无 ops/health；health/readiness 语义未定；P9 把 "recovery daemon/composition surface" 延后却未定义 "surface" | `P10/01:6-20`；`SD §12:1266-1332`；`P9/00:43`；`DID §9.6/§9.7/§9.9` | **GQ4** |
| UD-8 | **Usage Cost + Compute time 被 SD §7.7 要求但无 canonical 来源**：P10 交付 tokens/turns，`cost` 硬编码 0、无 compute-time 字段；schema 无 pricing/compute 来源 | `SD §7.7:834-838`；`P10.result.md:69`；`projection-runtime/src/usage.ts:51-60`；`DID §9.10` | **GQ4** |
| UD-9 | **PostgreSQL "if justified" 无冻结度量方法/阈值**：触发条件是定性三条；DID §0.3 要求 empirical 项冻结 measurement method，§9.1 未给 | `DID §9.1:3163`；`DID §13:4366`；`DID §0.3:307-314` | **GQ5** |
| UD-10 | **`DurabilityEnvelope` 备份/恢复 + RPO/RTO 演练无 phase owner**：G7/SD §10.7 要求 "必须声明并测试"；P2 `06` 明确把 backup/replication/RPO/RTO 列为 **Not covered**；P9 把 media/region loss 排除在 envelope 外；DID §11 P12 未列该项 | `00-problem-goals.md:314-320,363`；`SD §10.7:1199`；`P2/06:129-131`；`P9/02:245` | **GQ5** |
| UD-11 | **Worker identity 语义零定义**：只冻结列与 "replaceable" 性质，未定义 scope/lifetime（进程实例 / 节点 / lease-holder token）与远程持有者如何证明；lease acquire/renew/release 是 Runtime port 操作而非 Command，无认证提交面 | `DID §9.7:3287-3295`；`SD §10.5:1161-1166`；`P2/03 §1-§2:13-45`；`P2/02 §9:274-286` | **GQ6** |
| UD-12 | **单写者 vs worker-originated fenced writes 跨进程矛盾**：§9.1 禁 worker 直接开 DB；§6.3 要求 worker-originated durable write 与 generation check 同事务。仅在 worker 是进程内 Fiber 时自洽 | `DID §9.1:3148-3151` vs `DID §6.3:1753-1792`、`§12.3:3959-3969`；`P2/03 §3:49-69`；`P2/02 §3:72-100` | **GQ6** |
| UD-13 | **"remote Worker" 是否意味着分布式/水平 control plane 未定**：T1 startup recovery "exactly once per daemon" 与 scheduler single-flight 假设单 control-plane 进程 | `P2/05 §8:179-180`；`P9/03 §2:44-75`、`§5:112`；`P2/06 §8:142`；`DID §9.1:3163`；`SD §14 No.15` | **GQ6** |
| UD-14 | **`SecretStorePort` 无 adapter、无 owner，且签名无法表达失败**：`resolve:(secretRef:string)=>Effect<string>`（`E=never`、raw string 而非 DID §7.9 的 `SecretRef`）；无 `Live`；P3 引用但不在其 scope；DID §11 P0–P12 未点名 owner | `DID §7.9:2469-2474`；`ports/provider.ts:354-361`；`P3/01 §9:153-157` | **GQ2** |
| UD-15 | **Runtime Safety Envelope closure 不一致**：DID §8.16A 六维 "机制必须存在"；P2 契约认领全部六维；实现只有 repeated-fingerprint 一维；P2 result 断言 "no open Design Gap" | `DID §8.16A:3005-3033`；`P2/02:165-190`；`execution-runtime/src/runtime-safety.ts:9-40`；`P2.result.md:49-51,61-63` | **GQ7** |
| UD-16 | **DID 列 `verification-runtime` 包但仓库无此包**（P8 把 verification 放 `domain`/`application`；P8 `00:70` 记录该边界决定） | `DID:3471,3500,3549`；`packages/` 无；`P8/00:70` | **GQ8**（低） |

### B. P12 phase-scoped closure（契约权限内；含对 A 的依赖）

1. **Transport shells**（HTTP/WS/CLI/web/auth/deployment）绑定 `api-contracts` DTO，仅呈现不重解释 view semantics（DID v1.13 G6；`P10/05 §3`）。
2. **External Stop / external AdmitExecution authority resolver**（DID v1.13 G4）——**依赖 GQ2**。
3. **真实 provider adapter + model catalog/resolution**（当前仅 `provider-fake`；`ModelCapabilityPort` 静态）。
4. **`SecretStorePort` adapter + 接线**（driver 现硬编码 `secretRef:"secret"`）——**依赖 GQ2**。
5. **非 builtin 工具 / project-tool 注册与发现**——**依赖 GQ1/GQ3**。
6. **Runtime Safety Envelope 补全**（其余五维：max transient retries / recursion depth / no-progress turns / concurrency ceilings / rate-runaway）——**依赖 GQ7**。
7. **Rate / runaway protection**（当前无限流；`RateLimited` 只是 provider retryable kind）。
8. **Information Trust Plane 落地执行**：`ContextFragment` 未携带 `provenance`，ToolObservation/ExternalRetrieved/Message/ModelDerived 未在 context 边界标记 DataOnly（`InformationTrustMetadata` 仅在测试中使用）。
9. **Recovery daemon / composition surface**（`P9/00:43`）+ consumer-loop（verification/completion）daemon 接线（`P8.result.md`、`P10.result.md`）。
10. **Remote worker transport + fenced submission mediation**（不新增 durable dispatch 表，保留 sweep 自愈）——**依赖 GQ6**。
11. **Distributed / multi-host lease & recovery drives**——**依赖 GQ6**。
12. **P11 三条收敛项**：`advanceAnchor` 公共面收窄（b）；**region encoding 收敛（b，正确性缺陷）**——resolver 产出 `resourceSpaceId:"fs"` + raw path，而冻结编码是 object（`filesystem`）+ comparator 对非 object 返回 `null`，致窄化失效（`environment-impact.ts`/`environment-staleness.ts` 恒 false，Story A 靠重包裹掩盖）；`parseSnapshotBlob` mtime 往返（c，退化方向安全）。
13. **Observability / ops-health 视图**——**依赖 GQ4**。
14. **Search view transport**（`P10/01:19`）。
15. **Plugin SDK 面**——**依赖 GQ1**。
16. **PostgreSQL adapter**——**依赖 GQ5**（`adapters/* → domain,ports` 已允许，无需新 edge）。
17. **Architecture allow-list 扩展**：`tests/architecture/package-dag.ts` 的 `ALLOWED_EDGES` 逐名列举 adapter，新包会触发 `unknown package`。

### C. Implementation / empirical choice

PostgreSQL 触发（若 GQ5 判 `if justified`）；lease TTL / sweep 间隔 / consumer poll 批次；provider SDK 与 transport 技术选型；shell allow/deny 列表与限额；retry 次数/退避；context/budget 数值；备份 RPO/RTO 具体数字；若 GQ4 落地则含日志/指标后端与阈值；worktree 物化策略与探测粒度（P11 遗留）。

## 3. True governance questions（GQ1–GQ8）

- **GQ1（UD-1+UD-2+UD-3）Plugin SDK / 扩展面身份 + 对外兼容 + Project 工具信任**：
  (a) plugin 是什么——进程内 `adapters/*` 包（现状模型）／独立部署进程（与 remote Worker 重叠）／纯声明式 manifest？隔离与信任边界如何？
  (b) 是否承诺对外版本化/兼容政策（semver/deprecation/breaking-change），还是仅 "SDK 随 Arbor release、源码级、无对外兼容"？`api-contracts` 是否作为唯一对外版本化面？
  (c) `source:"Project"` 是受支持的一等扩展面（需治理化注册 + capability ceiling + sandbox 约束），还是保留/未实现（标注 reserved）？

- **GQ2（UD-4+UD-14）权限生产面归属**：
  (a) tool `InvocationAuthority` 的 trusted 生产者是否归 P12（与 G4 的 External Stop resolver 同一 resolver），还是归某 feature phase，或显式声明 v1 仅 P4 exact-match + default-deny？
  (b) `SecretStorePort` 归属与签名：P12 实现 adapter 并治理化补 `SecretRef` 类型 + typed error channel，还是声明 v1 仅 env 注入并记录延期？

- **GQ3（UD-5）`ToolCatalogPort` ↔ model-facing schema 跨 phase 契约冲突**：按 DID §7.6 加宽 `ToolCatalogPort`（或新增 read port）返回完整/投影 `ToolDefinition`，还是保持 refs 并由 driver 以 `PrepareTurnInput.toolSurface` 注入 schema/description？（改动 P3/P4 冻结契约之一）

- **GQ4（UD-6+UD-7+UD-8）observability / ops / usage**：
  (a) "observability" 范围——仅 P10 projection 面（无新 telemetry 管道）／在 SD 冻结最小非 canonical telemetry 契约（结构化日志+计数器+trace，明确排除 journal/authority）／仅交付对既有 durable 表的只读运维查询？
  (b) ops/health 可见性——transport-only（admin CLI/endpoint 读 canonical 表）／新增 SD view（P12 拥有 read-model）／仅 endpoint 契约（liveness=进程；readiness=DB open+migration baseline+T1 完成）？
  (c) SD §7.7 的 Cost / Compute time——修 SD 标记 v1 可选/出范围／冻结 pricing 表+compute 度量契约／P12 在 transport 边缘按配置价表推导（非 canonical）？

- **GQ5（UD-9+UD-10）PostgreSQL 触发度量 + DurabilityEnvelope 归属**：
  (a) 由治理在 DID §9.1 补冻结的 justification 判据 + measurement method，还是 P12 契约冻结 benchmark 阈值（conditional scope），或声明单 Runtime v1 下 out of scope 仅闭合 portability 缝？
  (b) DurabilityEnvelope backup/restore + RPO/RTO 演练归 P12，还是新增 ops/deployment phase，或声明为部署文档模板并移出 v1 phase deliverables？

- **GQ6（UD-11+UD-12+UD-13）remote Worker**：
  (a) worker identity 语义——认证的进程实例身份（ephemeral，node 不参与 fencing）／节点/主机身份／control-plane 铸造的 lease-holder token（绑定已认证 dispatch ticket）？
  (b) 跨进程 fenced 写模型——**mediated**（remote worker 不写 DB，携带 `executionId+fencingGeneration` 提交 ExecutionOrigin mutation，由 control plane 原子 fence-check+mutate+receipt+event）／worker-as-Runtime（直接开 DB，需重划 §9.1）／混合（读写 mediated + 只读投影）？
  (c) "remote Worker" 是否引入分布式 control plane——单 control plane + 仅 worker 远程（P2/P9 保证不变）／多 Runtime 共享一 DB + 分布式 single-flight/T1 选举（需新不变量 + 可能 PG）／leader election 单活写者 + 热备？

- **GQ7（UD-15）Runtime Safety Envelope closure 对账**：DID §8.16A 六维 vs P2 仅实现一维且 result 断言无 gap——(1) 记录为 inherited deferral 由 P12 补全；(2) 修订 P2 closure 标注部分交付；(3) 收窄 §8.16A 至 v1 已实现维度？

- **GQ8（UD-16，低）** `verification-runtime` 包对账：更新 DID §10.1/§10.4.1 反映 P8 的 phase-scoped 边界决定（verification 在 domain/application），还是补建该包？（citation/completeness 级）

## 3A. P12 completion blockers（治理裁决后追加，关闭前必须保持显式）

未闭合任一项不得宣告 **P12 COMPLETE**：

1. **region-encoding correctness fix**：resolver 产出 `resourceSpaceId:"fs"` + raw path，与冻结
   object 编码（`filesystem` + `{kind,...}`）不一致 → `resourceRegionComparator` 恒 false，
   窄化失效。修 resolver/编码并恢复窄化路径（Story A 不得靠重包裹掩盖）。
2. **ToolCatalogPort inherited contract correction**：`ToolCatalogPort` 必须 resolve
   model-facing `ToolDefinition`（真实 description/schema/version）；修复 P3/P4 refs-only +
   compiler 占位符（`schemaJson:"{}"` / `description:name`）。
3. **full §8.16A Runtime Safety closure**：六维全部 mechanically evidenced
   （observation source / state semantics / reset semantics / evaluation rule /
   configurable threshold-policy / violation action / restart-durability behavior / tests）。
4. **Authority Resolver production plane**（pure/deterministic；只产 trusted facts；不 invoke
   CommandGateway / 不 mutate / 不 consume InvocationApproval / 不 execute tools）。
5. **SecretStorePort / SecretRef + real adapter**（opaque `SecretRef`/`SecretMaterial`、typed
   failures；secret 禁入 prompt/session/event/log/artifact）。
6. **observability / health / usage plane**（derived operational state，非 canonical 权威替代；
   unknown cost 保持 Unknown/None；pricing versioned）。
7. **StorageScaleAssessment + DurabilityEnvelope**（SQLite 默认；backup/restore/RPO-RTO/drill）。
8. **Remote Worker transport / identity boundary**（single-writer control plane；
   `WorkerId`+`WorkerIncarnationId`；worker-originated durable write 由 control plane 提交）。
9. **Plugin SDK / compatibility / trust model**（`PluginId`/`PluginVersion`/`PluginSdkApiVersion`
   + compatibility policy；Project tool explicit registration，project-local 不自动可信）。

**Phase state**：`P12 design closure in progress` / `P12 planning NOT AUTHORIZED` /
`P12 implementation NOT AUTHORIZED`。

## 3B. 治理裁决落点（v1.14）

GQ1–GQ8 已裁决并落入 DID v1.14（`docs/design/03-detailed-implementation-design.md`
"Governance changes (v1.13 → v1.14)" G1–G8）：Plugin SDK/SPI + compatibility、Authority
Resolver production plane + SecretStore 修正、ToolCatalog 权威化、Observability/Health/Usage、
SQLite 默认 + StorageScaleAssessment + DurabilityEnvelope 归 P12、remote Worker
single-writer + WorkerId/WorkerIncarnationId、Runtime Safety 六维 cross-phase closure、
移除空壳 `verification-runtime`。System Design 未改。

## 4. Review record (independent gap review, round 1)

- 6 个只读研究分支并行产出；所有 load-bearing 论断在仓库内复核：`compiler.ts:106-110`（占位 schema）、`environment-resolver-local:148`（`resourceSpaceId:"fs"`）、`runtime-safety.ts:9-40`（1/6）、`ports/provider.ts:354-361`（无 error channel / raw string）、`packages/` 无 `verification-runtime`、round-1 工件位置。
- 合并去重：UD-6/7/8→GQ4；UD-9/10→GQ5；UD-11/12/13→GQ6；UD-1/2/3→GQ1；UD-4/14→GQ2。
- **P11 convergence C2（region encoding）判定为正确性缺陷**，但设计编码无歧义（P1 `04 §3.3` object 编码）→ 归 P12 phase-scoped 修复（B-12），非 upstream。
- 已确认**非** gap（non-vacuous）：Attention/freshness/status 契约（P10 全冻结且实现）；Exact-Intent Approval 端到端；sandbox 轨迹（P4→P11）；provider retry/attempt 语义；`SideEffectSemantics` 重试代数；组织动作非工具；`RepositoryFailure` 分类；partial unique index 单活主执行；durable timer；DurabilityEnvelope 已声明并测试（process/worker/runtime/host）；`api-contracts` deps 仅 domain；P10/P12 transport 边界与 External Stop 归属（G4/G6）。

## 5. Status

```text
SCOPE EXTRACTION COMPLETE (round 1). No P12 contracts, planning, or implementation.
No design file modified. Awaiting governance decisions GQ1–GQ8.
Next (after GQ1–GQ8): P12 contracts → four-way review → Blocking=0 → planning → implementation authorization.
```
