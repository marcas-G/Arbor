# F23 Exact-Tuple Receipt Integrity — Runtime Implementation Authorization Plan

状态：**DRAFT — 固定实现范围；待 token 授权。未授权、未执行**

建议授权 token：
`AUTHORIZE_F23_EXACT_TUPLE_RECEIPT_INTEGRITY_RUNTIME_IMPLEMENTATION`

基线：DID v1.35 F23 exact-tuple receipt-integrity owner amendment；P1
`01/02/03/07` 与 P9 `07` 已接受并落地。当前 P13 registry 是 **28 个必需
Command descriptors**，`ResolveControlApproval` 在其 handler composed 时为
可选第 29 项。Receipt decoder registry 还必须核对 P1 `CommandHandlerRegistry`
中可产生持久 receipt 的 application-owned 内部命令（例如
`UpdateResourceBoundary`）；这类命令不计入 P13 外部 descriptor 数，但也不能
被 exact-tuple receipt decoder 漏掉或用外部 codec count 替代。

本计划只请求实现与资格化既有合同，不重开 tuple 顺序、receipt 格式、权限、
历史 ID、AH10 binding 或跨 schema-version 语义。当前 HEAD 已包含
`command-result-codec.ts`、Gateway tuple-first 调用与六类 prior-consumer
调用路径；Wave1/2 结果是相邻候选的既有证据，不替代对本基线 28+可选29
descriptor 和当前 integration 状态的核对。获准后先做只读差异清点，仅实现
缺项并按本计划验证；不得重复或回退已有符合合同的代码。

## 固定合同与实现边界

1. **一个 receipt 线性化点。** `CommandStore.findResolution` 继续只返回
   raw `result_json` / `terminal_error_json` 与 stored tuple 元数据，不解析。
   Gateway 保留现有 `BEGIN IMMEDIATE`：在同一事务内先比较
   `(semanticRequestFingerprint, Handler.schemaVersion,
   fingerprintAlgorithmVersion)`，再处理 existing receipt。任何 tuple
   mismatch 仍返回原有 `IdempotencyConflict`，不得解码、读取或披露 JSON。
2. **可信、严格 decoder registry。** 用 Composition/注册表持有的
   `(CommandType, Handler.schemaVersion)` descriptor 选择 Committed result
   validator 和完整 `CommandRejection` validator。P13 外部 surface 必须覆盖
   28 个必需 descriptors；只有可选 `ResolveControlApproval` 实际 composed 时
   才需要第 29 descriptor。另须覆盖 Handler registry 中所有能写 receipt 的
   internal command descriptors，并明确标记其 internal source。未知
   type/version、缺 decoder、非法 JSON、错误
   resolution、错误 DTO/union shape、缺必需字段或额外字段均映射为固定安全的
   `PersistenceCorruption<"CommandStore">`。不从 corrupt row 自选版本，不作
   fallback，不猜测历史 schema。
3. **Gateway 错误效果。** exact tuple decode corruption 在原
   `BEGIN IMMEDIATE` 内回滚；不写 repair、receipt、attempt、handler effect、
   canonical row、Event 或 semantic rejection。外部继续使用现有非重试且不回显
   JSON/parser/detail 的 `persistence/corruption` Problem。tuple mismatch 的
   优先级不变，即使对应 JSON 已损坏也不进入 decoder。
4. **AH10 prior-consumer 是另一条路径。** 不称其为 Gateway tuple replay。
   六个调用路由按 P1 `07` 的可信 caller mapping 提供 CommandType，并从可信
   Handler registry 提供 schema version：AssignWork（含两个 prior 路径）、
   AcceptResult/`AcceptWorkOutcome`、SendMessage、SelectCurrentWork、
   DeclareDependency、ProduceDeliverable。先精确核对派生 prior CommandId 与
   当前 Project；只有随后才调用共享 strict decoder。缺 handler/decoder、坏
   JSON/shape 或 unsupported stored version fail closed，无 handler replay、
   新 Gateway Command、成功 Observation、row repair 或泄露。
5. **Direct-child AssignWork P9 disposition 保持专属。** proof-complete
   `assignWorkReplay` 的 syntax-corrupt A1 保留内部
   `PersistenceCorruption<"CommandStore">` 分类并走既有 P9
   `ReceiptMismatch` fact/event 事务，最终 `AgentActionRecoveryBlocked`；A2
   parseable wrong shape 与结构 binding/effect mismatch 遵从既有 P9 failure
   codes。P9 identity/dedup/atomicity/提交前后 crash 行为不变。普通 prior
   consumer 的 corruption 不写这个 P9 fact。不得把原始 JSON、sentinel 或解析器
   cause 放入 fact/event/transport。
6. **明确不做。** 无 DDL/migration、无 online/preserved DB 操作、无新
   P10 Attention source、无 operator-visible log/diagnostic sink、无跨
   schema-version prior receipt 解码/fallback。跨部署旧 schema 仍按 accepted
   owner contracts fail closed；如要兼容，另行治理与授权。

## 分阶段实施和验收

### Phase A — 当前 registry 差异核对

- 分别枚举 P13 的 28 required descriptors/可选 `ResolveControlApproval`，及
  P1 `CommandHandlerRegistry` 中能写 receipt 的 internal descriptors。核实 decoder
  registry 对两类来源既无缺项，也未把 internal handler 误报为 P13 外部 surface。
- 核对 schema-v1 结果/完整 rejection union样例与当前 F21 合入后的
  `ProjectResourceUnavailable{commandId}`、CreateProject schema v2 descriptor；
  不接受孤立 Wave1 的旧 26-command/schema-v1-only 清单作为当前验证结论。
- 核对 P1 `07` 六路调用与 direct-child AssignWork A1/A2/B 分流；输出 baseline
  清单和任何差异。发现接受合同之外的结果字段语义时停止并提 Design Gap，
  不由 decoder 作者自行补语义。

### Phase B — 实现并验证

- Unit：每个当前 descriptor 至少一个正例；错误/缺失/额外字段、非法 enum/tag、
  unknown CommandType/schema、语法损坏与完整 rejection union 负例。
- Gateway adapter/application：exact valid Committed/Rejected replay；tuple
  mismatch + corrupt raw JSON 仍先冲突且 decoder 未调用；exact match + malformed
  JSON/wrong shape 返回 typed corruption；事务回滚且 receipt bytes、attempt、
  Event、canonical state 不变。
- Transport：精确安全 non-retry Problem；sentinel/raw JSON/parser detail
  不泄露。
- 六个 prior consumer：针对每个 trusted CommandType 和当前 schema 做 exact
  valid、bad JSON、wrong shape、unknown version、CommandId/Project mismatch；均
  无 handler replay/new Command/Observation。跨版本输入 fail closed。
- Direct-child AssignWork：A1 syntax corruption、A2 parseable wrong shape、B
  mismatch；P9 fact/event exact identity、无原始 JSON，commit 前杀进程不留下半
  fact/event，commit 后 restart 幂等收敛，Action Pending/RecoveryBlocked，无
  Observation/new Command/handler replay。P9 sink abort须 rollback并fail closed。
- 核对已有 F23 Wave1/2 候选测试，再对当前 HEAD 运行最小相关单元/adapter/
  pending process 测试、typecheck、Biome/diff。只有在当前 branch 的命令与
  输出都记录后才可将项标为 PASS；不运行 full，除非另获授权。

## Authorization boundary

该 token 若被用户明确接受，仅授权上述 runtime/adapter/consumer tests 和结果
记录；不授权更改 `docs/design/**`、P1/P9 语义、存储 schema/DDL/migration、历史
receipt 改写、online DB 操作、P10 corruption Attention 或跨 schema-version
compatibility。现有 P1/P9 owner contracts 对本范围已明确，**没有发现需要先新增
设计决策才能实施的子项**。如 Phase A 找到当前 P13/internal Handler contracts
之外的语义选择，立即停在该项并提治理，不用该 token扩 scope。
