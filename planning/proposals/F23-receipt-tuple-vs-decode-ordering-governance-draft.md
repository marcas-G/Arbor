# F23 Receipt Tuple Comparison and Decode Ordering — Governance Decision Draft

状态：**DRAFT / 等待人工治理审议**  
关联缺口：**FT-DG-03 / F23 receipt-integrity boundary**  
实施：**未授权**  
建议接受标识：`DECIDE_F23_RECEIPT_TUPLE_DECODE_ORDER`

本文只建议把既有 P1 receipt tuple 顺序落到能够延迟解析原始 result/error JSON 的 Port 表示上。它不重开已接受的 F23 外部 wire-v1、权限、历史非法 ID、AH10 或 F21 语义；本文本身不授权任何实现。

## 决策问题

FT-DG-03 的已接受材料分别规定了 tuple 不匹配返回
`IdempotencyConflict`、exact tuple 的不可解码 receipt fail-closed；但没有逐字裁决
“同一行的 result/error JSON 已损坏，同时候选 tuple 不匹配”这一组合。现有 P1 `01`
在 Gateway 事务内先读取 resolution 并比较 tuple；按这个冻结顺序，该组合必须先得到
tuple mismatch 分支。这里是依据既有 P1 顺序作出的落地结论，不是声称 FT-DG-03
曾逐字写过该组合规则。

现有 P1 `02-port-contracts.md` 的 `CommandStore.findResolution` 返回
`CommandReceipt<unknown, unknown>`，SQLite adapter 在此之前会解析 result/error
JSON。Port 因而不能把 P1 `01` 的 tuple-first 顺序完整表达出来。建议接受选项 A，
并将落地 owner 明确限定为 P1 `01-command-contracts.md` 与
`02-port-contracts.md`：前者固定 mismatch 分支相对于 receipt 内容解释的优先级，
后者提供 tuple 元数据和未解析 JSON 所需的返回形状。

本稿只治理 tuple-first 与 raw JSON 延迟解析。它不声称当前已有 result/error
runtime decoder、合法 JSON 结构/字段校验，或把解析异常转换成 typed
`CommandStore` corruption failure 的能力；exact tuple 命中后的类型解码规则与错误
转换仍须单独治理闭合。FT-DG-03 已接受的 exact-tuple fail-closed 高层要求保持不变，
但不能将其误写为当前实现能力。

## 确定性反例

下列 fixture 行可由当前 `commands` DDL 接受：Committed 行要求
`result_json` 非 NULL，但 DDL 没有 `json_valid` 约束；因此
`result_json = '{'` 满足现有 SQL 检查。该值代表通过 DDL 注入的历史/损坏状态，
**不是正常 Command writer 的产物**；正常 writer 序列化其结果时会生成语法合法 JSON。
fixture 只用于隔离资格测试，不表示数据库中已有该行或现行生产 writer 能写出它。
见 P1 schema `commands` 表及 resolution/nullability CHECK：
`docs/design/implementation/P1/04-sqlite-schema.md` §3.4。

构造一个真实外部流程的隔离 fixture：

1. 插入一条历史 Committed 行：`command_id = cmd_018f2b3c-4d5e-7abc-8def-0123456789ab`，`project_id` 是 fixture 的真实 Project，`schema_version` 使用当前 `SubmitHumanMessage` Handler 的值（源码为 `"1"`），`fingerprint_algorithm_version = 1`，`semantic_request_fingerprint` 是同一 command、project、actor 和另一个合法 payload 的真实 fingerprint，`result_json = '{'`，`terminal_error_json = NULL`。其余非空时间列使用固定合法时间值。
2. 认证的 Principal 与 envelope Actor 完全相同；当前 root Workspace 存在且 Resolver 对该命令授权。
3. 通过外部入口提交同一个有效 CommandId、同一个 Project/Actor、当前 wire-v1 合法 payload，但将 `bodyRef` 从存储 fingerprint 对应 payload 的 `"body-ref-old"` 改为 `"body-ref-current"`。CommandId、ProjectId、MessageId 均使用合法 UUIDv7，且 payload 仍通过当前 codec。
4. fixture 在提交前计算并断言 `fp_old !== fp_current`；因此输入与行的 exact tuple 明确不相等。

已接受合同要求此请求走 `IdempotencyConflict`，不返回任何旧结果，且不更改历史行。当前源码的确定执行顺序却是：

```text
外部 Composition Resolver 通过
→ CommandGateway.execute 进入事务
→ store.findResolution(commandId)
→ SQLite toReceipt(row) 对 result_json 调用 JSON.parse
→ 只有 toReceipt 返回后，Gateway 才比较 fingerprint/schema/algorithm
```

源码证据：

- `packages/application/src/gateway.ts` 第 107–129 行：先调用 `findResolution`，随后才比较 tuple 并生成 `IdempotencyConflict`。
- `adapters/persistence-sqlite/src/command-store.ts` 第 31–47 行：`toReceipt` 在 `result_json` 上直接 `JSON.parse`。
- `adapters/persistence-sqlite/src/command-store.ts` 第 75–88 行：`findResolution` 读取 row 后立即调用 `toReceipt`，并在 `Option.some` 返回前完成解析。
- `docs/design/implementation/P1/02-port-contracts.md` 第 107–115 行：冻结接口返回 `Option<CommandReceipt<unknown, unknown>>`，没有未解析 receipt 行的返回形态。
- `docs/design/03-detailed-implementation-design.md` §4.1B 第 2310–2323 行：Gateway 事务内先读 receipt；任一 tuple mismatch 返回 `IdempotencyConflict`；该事务是唯一线性化点。
- `docs/design/implementation/P1/04-sqlite-schema.md` 第 255–262 行：tuple mismatch 冲突规则与 exact tuple 解码失败规则分列。
- `apps/single-workspace/src/transport/composition.ts` 第 276–284 行：只有 Gateway 的 typed failure 才会映射为外部 Problem。

因此，`JSON.parse('{')` 在当前比较分支之前抛出；Gateway 不会达到按 P1 顺序应当先执行的 tuple mismatch 分支。本证据没有运行 fixture，也不声称当前外部请求最终得到何种 HTTP 状态或 Problem；当前代码没有在本稿中被证明具有 result/error runtime decoder、结构校验或 typed corruption 转换。反例指出 Port/解析顺序不可表达 tuple-first，不替代运行时 RED 证据。

## 已接受边界

以下合同继续有效，不属于本稿待选语义：

- 外部请求先认证、严格 wire-v1 decode、绑定 Actor/Principal、运行 Resolver；Resolver 通过后才进入 Gateway。shell 不读取 receipt。
- Gateway `BEGIN IMMEDIATE` 仍是 receipt 读取及线性化点；没有 Gateway 外 receipt pre-read。
- Exact tuple 可以 replay；tuple mismatch 返回 `IdempotencyConflict`，不披露先前 result/error，且旧行不被覆盖。
- FT-DG-03 已接受 exact tuple 下 result/error 不可解码时 fail closed、不披露内容且不修复/改写 receipt 的高层要求；本稿不定义或声称已有 exact-tuple runtime decoder、合法 JSON 结构校验或 typed corruption 转换。
- 旧非法 CommandId/payload ID 仍在 Resolver/Gateway 前被 codec 拒绝，并保持非重放；这与本稿的“有效候选 ID 命中一条损坏但 tuple 不同的历史行”是两种路径。
- 不新增 SQL 列、migration、原始请求 body、历史比较器或 receipt 修复。AH10、F21/FT-DG-01 保持隔离。

依据为已接受的 `planning/results/FT-DG-03-governance-acceptance-and-landing.md`（决策 token `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`，accepted SHA-256 `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`）、DID v1.34 §4.1B 与 P1 `01`/`03`/`04`。

## 建议治理决定：选项 A

按当前冻结的 P1 `01` tuple 比较顺序，建议接受 A：让已有 Store Port 暂存
result/error 原始 JSON 到 tuple 比较之后，而不是把坏 JSON 的解析结果提前为 tuple
mismatch 请求选出另一个响应。此稿只要求以下 P1 owner 范围：

- **P1 `01-command-contracts.md`：**明确同一 CommandId 行先比较已存 tuple；不匹配即
  `IdempotencyConflict`，不得因尚未解释的 result/error 内容而改变该分支或披露旧内容。
- **P1 `02-port-contracts.md`：**修订 `CommandStore.findResolution` 的返回合同，使
  Gateway 在同一既有事务中可先取得 resolution/tuple 元数据，并延迟解析
  `result_json` / `terminal_error_json` 原文直到 tuple 已比较。

此 landing 不新增 SQL、migration、兼容比较器、receipt 外预读或 repair。它不设计
exact-tuple 的 result/error runtime decoder，不界定合法 JSON 的字段/结构规则，也不
声称当前存在 typed `CommandStore` corruption → Problem/Attention 转换。上述 exact
tuple 解码机制须由后续治理明确后方能实现和资格化；FT-DG-03 的高层 fail-closed
要求不因本稿而撤销。

若人工治理希望让损坏 result/error 优先于 tuple mismatch，那将改变 P1 `01` 已冻结
的分支优先级，需单独提出并接受覆盖该语义的 owner 修订；它不是本稿针对 Port
表达缺口的等价实现选项。不得把当前 SQLite eager `JSON.parse` 顺序追认为此类已接受
语义。

## 波次隔离

- **Wave2 外部入口：**负责 HTTP/WS/CLI 原始输入的认证、strict codec、Actor/Principal 绑定和 Resolver 可见性。该治理稿不改 transport shell、外部 Composition decoder 或 `InvalidCommandPayload` 映射。反例在这些检查通过后才发生。
- **Wave3 内部输入：**System/ExecutionOrigin/RecoveryController 使用现有 descriptor 进行 typed payload 校验，确保无效内部 payload 不触及 Gateway。该稿不重定内部 command 验证语义；其关注点是有效输入进入 Gateway 后已有 receipt 的比较与解码顺序。
- **Receipt integrity：**跨外部与内部 origin 共用 Gateway/CommandStore 事务边界。本稿只规定 mismatch 时先按 tuple 决定分支并延迟解析原始 JSON；exact-tuple 的合法 JSON 结构、Handler result/error 类型解码和 typed corruption 转换仍待后续治理。它不新增外部信任、授权、历史 ID replay、receipt rewrite 或 recovery exception。
- **历史非法 ID 资格：**旧非法 CommandId/payload 在当前严格 codec 阶段被拒绝，不能用本稿的损坏 JSON fixture 替代；两类资格分别保留独立断言。

## 最小资格矩阵（仅在治理决定及对应实现授权之后）

| Fixture / 候选 | 期望分支 | 必须观察到的非披露与持久化断言 |
|---|---|---|
| DDL 可接受的隔离历史/损坏行，其存储 tuple 与合法当前候选不同，原始 `result_json` 或 `terminal_error_json` 为语法错误 | `IdempotencyConflict` | 不解释/解析旧 JSON；不披露旧内容；不执行 handler；旧 tuple 与 JSON 字节不变；无 Event/attempt/repair |
| 存储 tuple 的 fingerprint、schema 或 algorithm 任一不匹配，JSON 语法合法或非法 | `IdempotencyConflict` | JSON 可解码性不能改变 mismatch 分支；不披露旧内容，旧行不变 |

本稿资格矩阵**不包含 exact-tuple result/error 语法解析、结构/字段验证、当前 Handler 类型解码、typed corruption 转换或其外部 Problem**。这些项目须由后续 owner 治理补齐后独立资格化；不能由本稿或 26-command payload codec / descriptor parity 测试代替。真实外部用例只断言 mismatch 响应及非披露；SQLite 读取只能作为独立只读 postcondition，不作为选择外部响应的判定 oracle。

## 状态

本文是供人工治理审议的草稿，不是设计接受记录，不更新 FT-DG-03 接受 SHA，不授权代码、测试、迁移、数据库 inventory 或历史库访问。若接受 A，须记录接受 token/SHA，并按 P1 `01` 与 `02` 两个 owning contracts 精确落地及复审；此后 exact-tuple result/error 类型解码和 corruption failure conversion 仍是未闭合治理/实现项。Fixture 是通过 DDL 注入的历史/损坏状态，不得描述为正常 writer 产生。未接受前，当前设计与实现边界保持不变。
