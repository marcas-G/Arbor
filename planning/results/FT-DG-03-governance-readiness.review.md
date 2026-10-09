# FT-DG-03 治理决策稿审阅

> **2026-10-09 superseding review:** the original 2026-10-04 conclusion below
> reviewed an earlier draft and is retained as history. This section reviews
> the fixed landing package at the SHA recorded below; it supersedes the earlier
> readiness judgment. It does not accept the proposal or authorize code.

日期：2026-10-04

对象：`planning/proposals/external-command-runtime-codec-decision-draft.md`

当前 SHA-256：
`6A258323A7AC980D24FA182ED8ADC5B09D9ED5612E2D2D3CBD591E58CAEDCD70`

结论：**可提交人工治理决策；未接受、未授权服务端实施。**

## 反证与原因

- F23 公开进程的 `SubmitHumanMessage` 非 UUIDv7 `MessageId` 得到 Committed。
- F23 公开进程的 `AcceptWorkOutcome` 用错误前缀 `acp_`、但正确 UUIDv7 的
  AcceptanceId，也得到 Committed。
- HTTP shell 只把 JSON 强转为 `ExternalCommandEnvelope`；TypeScript 品牌类型
  无法校验运行时输入。个别 Handler 的非空字符串检查不是封闭命令 schema。
- Web `AcceptWorkOutcomeForm` 的同类前缀错误已通过现有 `acc_` 合同修复并测试，
  但 HTTP/WS/CLI 直连仍可提交非法值，因此 Web 修复不构成系统关闭。

## 合同闭合检查

决策稿区分 wire/schema 错误与业务语义拒绝，规定 codec 所有权、认证与收据重放
的顺序、版本化指纹、历史只读比较、Model control 独立解码，以及
System/ExecutionOrigin 的同构校验。与 F21 的 CreateProject v1/v2 收据路径
必须共用一处 Application/Composition 实现，避免两套身份规则。

人工接受后先逐项落地所属 `docs/design/**`，再按 F23 红灯实施。至少应证明：
非法输入无 Receipt/Event/状态变更；合法 ID 正常工作；same-id 收据重放不变；
旧收据不被当前 codec 擅自改写。F23 通过后才移入默认功能门禁。

本审阅不是人工接受。

## 2026-10-09 固定 Landing Package 复核

对象：`planning/proposals/external-command-runtime-codec-decision-draft.md`

Proposal SHA-256：`74EF96724BB31FDA76368C947E8DC429B09125B5D1BD0922A9B39FC7A33AF61E`

结论：**可交人工对固定整体包作接受/拒绝；仍未接受、未授权实现。** 旧版的
“治理决定已闭合”不再足以描述当前稿件：此稿把此前识别的七个阻断逐项写成合同，
并将合同无法推出的地方显式保留为接受时待决语义。

| 阻断 | 本稿固定合同 | 状态 |
|---|---|---|
| wire schemaVersion 与 Handler/`commands.schema_version` 混淆 | 不新增 caller wire 版本字段；固定外部 v1；分清 codec v1、Handler receipt schema、fingerprint algorithm version | 已有唯一推荐；接受前不可实施 |
| 认证、receipt 兼容读、codec、Resolver、Gateway 内复查的顺序/线性化缺失 | 规定 auth → 只读 receipt-first → codec → fingerprint → Resolver → Gateway `BEGIN IMMEDIATE` 内复查；旧来源不可证明时 fail closed；receipt 不可覆盖 | 已有合同；并发 RED/GREEN 仍属实施资格 |
| 旧版本/指纹矩阵与无 raw payload 历史 receipt | 将 algorithm 1/SHA-256 + stored Handler schemaVersion 作为已知比较；P0 FNV 只在部署库存证后支持；未知来源不猜测；不新增 raw body | 有推荐处置；实际 inventory 尚未执行 |
| `InvalidCommandPayload` DTO 与零持久化 | 定义稳定 `Problem` 字段/错误类别、安全字段路径规则；不进入 Resolver/Gateway/Receipt/Event；HTTP 400 标为提议 | 合同已有；精确 status 与 Attention 投递方式待人工接受 |
| 注册命令/internal codec 覆盖表 | 列出当前 composed handlers、外部起源政策和 System/ExecutionOrigin 内部验证；注册表必须与 descriptors 一一对应 | 本地源码基线已盘点；landing review/实现须重新机械核对可选注册 |
| 历史非法 canonical ID | 既有值不可改写；只读 opaque preservation；消费者不能安全解码时 typed Attention；历史 receipt 仅精确指纹可重放 | 建议明确；projection/Attention 语义须人工接受 |
| 与未接受 FT-DG-01 CreateProject 耦合 | 只验证现有 CreateProject payload；明确 F21/FT-DG-01 独立，不声称资源边界问题关闭 | 已切断依赖；实现 review 要验证未扩权 |

## Fixed-package consistency checks

- Owning source baselines read: Problem & Goals v1.3, System Design v1.11,
  DID v1.33; P1 `01`/`03`/`04`/`07`; P12 `02`/`10-transport-shells`; Domain ID
  schemas; P13 `02`; composed production registry; FT-DG-03 and F23 evidence.
- AH10 compatibility audit: the accepted landing adds SD §4.11 / DID §6A.16,
  migration 0033, exact Grant/ActionApproval validation and CommandId-bound
  approval consumption, plus P1 `07`'s sole direct-child AssignWork old-
  Committed exception. The F23 package now targets SD v1.12 / DID v1.34 and
  explicitly leaves that exception, recovery proof, durable P9 fact/event,
  projection, and migration 0033 intact. External AssignWork stays denied;
  no external codec can manufacture AH10 trusted evidence. This was a document
  consistency audit only, not implementation or migration evidence.
- Version/owner rebase: current heads are SD v1.11 and DID v1.33. Proposed
  targets are SD v1.12 §8A.1 and DID v1.34 §4.1B (DID §4.1A is already owned
  by GovernanceChangeSet); DID's dependency must advance to SD v1.12. AH10
  revisions are preserved as baselines, not overwritten.
- Corrected landing owner is `docs/design/implementation/P12/10-transport-shells.md`;
  `06-remote-worker.md` covers authenticated remote worker transport and is not
  the HTTP/WS shell owner.
- No `docs/design/**`, source code, tests, migration, stage, commit, or push was
  changed for this proposal revision. No SQL migration/raw request storage is
  recommended because the existing receipt tuple is sufficient for supported
  fingerprint comparison when the retry supplies the candidate envelope.
- `git diff --check` passed for this exact proposal and review document. The
  package has not been manually accepted; the named choices in §9 remain open
  governor decisions, especially old algorithm support, malformed historical
  ID read behavior, Problem status/Attention delivery, and optional registry
  activation.

The package is review-ready as a single decision object, but the inventory and
runtime race evidence are deliberately not claimed: they belong after human
acceptance and separate implementation authorization.

## 2026-10-09 修复后 blocking disposition（supersedes prior package review）

对象：`planning/proposals/external-command-runtime-codec-decision-draft.md`

Proposal SHA-256：`E21769DBD157F7A284F460FF6F661F494C528E09B1FCD645A1F24071E36A6556`

**状态：候选修复已写入，等待独立复核；未接受、未授权实现。** 上一节针对 SHA
`74EF96724BB31FDA76368C947E8DC429B09125B5D1BD0922A9B39FC7A33AF61E` 的结论仅适用
于旧版本，并不能关闭后来发现的两个 Blocking。

| Blocking | 本版推荐语义 | 当前状态 |
|---|---|---|
| 外部 receipt 在 Resolver 前返回，可能泄露另一 principal 的结果/冲突信息 | 不做 Gateway 外 receipt 预读；严格 codec 后精确绑定外部 Actor == authenticated Principal，再由现有 P12 Resolver 以当前 principal、External origin、project、target、active Grants/policy 授权；只有 Resolver 成功后才进入 Gateway | 已写候选合同，等独立复核确认；并发实证仍属实现资格 |
| 非法历史 CommandId 可否 replay 的规则矛盾 | 唯一选择 preserve-only/non-replayable：任何非法 CommandId 在 receipt lookup 前被拒；已有非法 ID receipt 留存不读取、不返回、不改写 | 已写候选规则与新旧行分开的测试矩阵，等独立复核确认 |

有旧 receipt 且当前 payload codec 失败时，同样返回 `InvalidCommandPayload` 且不查询/披露 receipt；存储行留存。当前 codec 成功、但旧 Handler schema/fingerprint algorithm 与当前 tuple 不同的请求，在 Resolver 成功后只得到 P1 `IdempotencyConflict`，不会调用新兼容算法或暴露旧结果。Gateway 现有 `BEGIN IMMEDIATE` exact tuple receipt 检查是唯一线性化点。AH10 直接子 Work 的旧 Committed receipt Recovery 仍走 DID §6A.16 / P1 `07` / P9 `07` 的证明与 Attention 规则，不经外部 codec；本稿没有扩展该例外。

Final source audit confirms current heads SD v1.11 / DID v1.33. Landing targets remain SD v1.12 §8A.1 and DID v1.34 §4.1B (with DID dependency advanced to SD v1.12). The review has not checked implementation or run tests, and this revision changed only the two planning documents. `git diff --check` passes for both files. SHA below matches the proposal.

## 二轮 DTO / P1 范围修订（supersedes prior candidate review）

Proposal SHA-256：`7EB08365B65042FD45F237699A9CD68A23901830A748D5EE8C582FF84C04FBC2`

状态：**候选修订已写入，等待独立复核；未接受、未授权实现。**

- DTO reflection blocker：`safeDetails.commandType` 现在仅允许 server-owned
  `RegisteredCommandType`；未知值省略。`unknown-field` 的 path 仅用已知父路径
  加固定 `"<unknown-field>"`，不包含不受信任键名；unsupported command 用固定
  `commandType` 路径和通用消息。资格矩阵增加未知 commandType 与顶层/嵌套恶意
  属性键的 canary 反射负例，覆盖响应与 surfaced diagnostics。
- P1 owner范围：landing table 精确列出 `P1/01 §3` 与 `P1/03 §3.1`。外层
  External Composition 必须在进入 Gateway 前完成 codec、Actor/Principal 绑定与
  P12 Resolver；Gateway 的单事务内部仍保持 P1 原合同：receipt lookup/replay 在
  最终 authority exact validation 之前。新合同不声称把 Resolver 搬入 Gateway，
  也不改变 `BEGIN IMMEDIATE` tuple compare。
- 以上仍是拟治理语义，需独立 reviewer 验证 DTO 字段/路径不会回显输入，以及
  Composition gate 与 Gateway 内部 receipt 顺序无文字冲突。没有改 P1 文档或代码。
- `git diff --check` 对两份 planning 文件通过；未运行测试。仍未人工接受/授权。

## 三轮独立复核结论

复核对象 SHA-256：`7EB08365B65042FD45F237699A9CD68A23901830A748D5EE8C582FF84C04FBC2`

**结果：Proposal-ready；Blocking = 0。尚未人工接受，未授权实现。** 第三轮独立
复核针对上述完整固定包确认 Blocking = 0，涵盖：外部 Resolver-before-Gateway
receipt 可见性与 Gateway 事务内 receipt-first 顺序；非法新/历史 CommandId 的
唯一 preserve-only/non-replayable 规则；有限 RegisteredCommandType 与安全字段路径
避免输入反射；P1 `01 §3` / `03 §3.1` 的精确落地范围；AH10 receipt recovery 例外
保持不变。

版本基线：当前 System Design v1.11 / DID v1.33；proposal landing 目标为 System
Design v1.12 §8A.1、DID v1.34 §4.1B，且 DID `Depends on` 更新为 SD v1.12。AH10
已接受的 v1.11/v1.33 内容保持为基线，不被覆盖。三轮 review 的 Blocking=0 仅表示
固定 landing package 可提交人工治理决策，不构成接受记录、设计落地或实现授权。

Proposal SHA-256 复算仍为 `7EB08365B65042FD45F237699A9CD68A23901830A748D5EE8C582FF84C04FBC2`；
本次仅更新本 readiness review，没有改 proposal、`docs/design/**`、代码或测试。

## 人工接受后：production registry 范围修订要求

人工 governor 随后明确接受了 proposal SHA-256
`7EB08365B65042FD45F237699A9CD68A23901830A748D5EE8C582FF84C04FBC2`。但是设计
landing 与独立 registry 审计确认：`ReviseDependencyContract`、`WithdrawDependency`、
`MarkDependencyUnfulfillable` 只有 handler factory，未包含在当前 production
composition。旧 proposal 将三者列入当前注册命令/codec 覆盖范围，因此不能按该
已接受版本落地。此次是已接受包的范围与事实不一致；未修改 registry，不以扩大生产
注册表来迁就文稿，也不部分落地旧 SHA。

修订候选 SHA-256：`DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

仅 planning 层的修订方向：三者从当前 26 个 `RegisteredCommandType`、codec descriptor
和当期 qualification 中移除，另列为 factory-only/future registration；将来加入
production composition 时另行更新治理/codec 范围。Proposal 经修订后的 SHA 与旧接受
SHA 不同，必须重新提交人工接受；本修订 SHA 也未通过独立复核。当前状态为 **旧 SHA
已接受但停止落地、修订 SHA 未复核且未接受、实现未授权**。当前下一项工作只修改本
proposal 与 readiness review。

## 修订包独立复核结论

复核对象 SHA-256：`DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

**结果：Proposal-ready；Blocking = 0，可重新提交人工接受。新包仍未接受，未授权
实现。** 独立复核确认当前 production composition 的 26-command 清单准确；
`ReviseDependencyContract`、`WithdrawDependency`、`MarkDependencyUnfulfillable` 被
明确列为 factory-only/future registration，不属于当前 `RegisteredCommandType`、
codec descriptor 或 qualification。旧修订内容均保留，包括外部身份/Resolver 可见性、
历史非法 CommandId 不可重放、DTO 不反射输入、P1 §3 / §3.1 receipt 次序和 AH10
边界。

原人工接受 SHA-256 `7EB08365B65042FD45F237699A9CD68A23901830A748D5EE8C582FF84C04FBC2`
因注册命令清单错误已停止落地；本结论只适用于新的固定 SHA，不会沿用旧接受记录。
当前版本基线仍为 SD v1.11 / DID v1.33，候选目标为 SD v1.12 §8A.1 / DID v1.34
§4.1B。需对新 SHA 重新取得人工接受，再进行任何设计落地或另行实施授权。

## 2026-10-09 人工接受与独立落地审查（supersedes current status above）

人工治理者已接受固定 proposal SHA-256
`DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`，决定 token
为 `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`。接受记录见
`planning/results/FT-DG-03-governance-acceptance-and-landing.md`。

设计落地后，两份独立一致性审查均报告 **Blocking = 0**：
`planning/results/FT-DG-03-design-landing-semantic.review.md` 与
`planning/results/FT-DG-03-design-landing-boundary.review.md`。当前 owner 文档摘要与
接受记录逐项匹配，设计差异仅含接受包列出的 21 个 owner 文件。人工接受和设计审查
通过不构成 Runtime 实现授权：**实现未授权**，仍须单独取得授权。
