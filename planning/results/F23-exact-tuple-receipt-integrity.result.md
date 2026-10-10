# F23 Exact-Tuple Receipt Integrity — Governance Candidate and RED Evidence

状态：**候选/隔离 RED；未实现、未接受、F23 未闭合**
基线：`ed1c9dba3f158269df9274f21e8685ebbdd4bf52`（开始时 tracked/untracked clean）
范围：仅新增治理草案、pending RED 和本结果；不改 `docs/design/**` 或生产代码。

## 候选

新增草案：`planning/proposals/F23-exact-tuple-receipt-integrity-decision-draft.md`。
草案将已落地 tuple-first 固定为不变前提；exact tuple 后要求按
`(commandType, Handler.schemaVersion)` 对 Committed result 与完整 CommandRejection
union 做严格 runtime decode。非法 JSON、错误 shape、未知版本或缺 decoder fail closed，复用
非重试 `PersistenceCorruption<"CommandStore">` / 安全 Problem 路径；Agent Runtime 走
operational failure，不变旧行、不调用 handler、不写 receipt、canonical state、Event、
attempt 或 Observation。没有将腐败包装为 retryable rejection / AuthorityDenied。

草案盘点了当前 26 个 registered command 的静态结果 DTO/interface 与源码 owner；runtime
result decoder 均缺失。可复用 Domain ID/value schemas 作为子 schema，不以 Domain Event
schema冒充 receipt result schema。`ConcludeVerificationResult.conclusionReason` 是必需的
`T | undefined` TS 属性而 JSON 会省略它，草案将此作为 v1 持久形状必须显式裁决的细节，未
擅定修复语义。历史 schema/algorithm mismatch 仍先走 tuple mismatch；旧版无 decoder 时
不猜测、不 fallback、不修复。P10 持久 Attention 保持独立 OPEN：未新增 Attention source，
未将已有安全 Problem/operational failure 夸大成 durable Attention。

## RED 测试

新增隔离文件：`tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`，
由既有 pending 配置运行，不进入 `pnpm test:functional` 的默认 `process/**/*.functional.test.ts`
白名单或 root Vitest 的 `tests/functional/**` 绿门。

最终定向命令：

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts
```

结果：**3 tests / 3 expected RED**，总耗时 23.65s。

1. Exact-tuple `SubmitHumanMessage` Committed 行存放语法合法的错误形状 `{"unexpected":...}`：当前 public `/commands` 返回 **HTTP 200**，测试期望安全非重试 `persistence/corruption` Problem（503），失败点 `:190`。测试同时核对无 sentinel 泄露及 receipt、attempt、event 快照不变。
2. Exact-tuple `TerminalRejected` 行存放语法合法但缺 `AuthorityDenied.reason` 的 union 错误：当前 public `/commands` 返回 **HTTP 200**，测试期望同类 non-retryable corruption Problem，失败点 `:253`；同时核对无数据泄露/无持久变化。
3. AH10 generation takeover prior AssignWork Committed result 只含匹配的 `workId/workspaceId`，缺少 schema-v1 `lifecycle/revision`：当前 `assignWorkHandler` 返回成功 Observation；测试期望 operational failure 且不产生 Observation，失败点 `:396`。fixture 通过该公开 runtime handler 路径读取 prior receipt，不绕过 Gateway 触发新的命令，也未放宽 AH10 binding/authority 证明。

测试污染行通过隔离 fixture 的 SQL DDL/raw insert 创建，是**历史/损坏状态**，不是正常 writer 输出。当前 tuple-ordering mismatch case 保留在既有 `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts`；本波没有重跑该测试。

第一次定向尝试因 clean worktree 未构建 `apps/web/dist`，两个 HTTP cases 各超时 45s 于 fixture readiness；AH10 单案当时因测试错误检查了外层 Effect Exit 而产生无效 RED。已安全终止该次专测进程，只在此树运行 `pnpm --filter @arbor/web build`，并修正 AH10 Exit 层级断言。随后只完整重跑上述单文件一次，获得本节 3 个有效 RED。未延长超时，未触碰其他进程。

## 验证

- `pnpm build`：PASS（为隔离树 workspace package 入口生成 ignored `dist`）。
- `pnpm --filter @arbor/web build`：PASS（仅用于 public fixture readiness；有既有 chunk size warning）。
- 定向 pending RED：按上文 3/3 RED；这是预期缺口证据，不是产品验证通过。
- `pnpm exec biome check tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`：PASS。
- `pnpm typecheck`：PASS。
- 未运行 `pnpm check`、完整 functional、默认测试门禁或实现后 GREEN。

## 未闭合 / 停工边界

- 26 个 current result runtime schemas 与完整 CommandRejection runtime validator 未实现；需逐 DTO 正向/负向资格。结果 schema 不可由输入 codec 或 Event schema替代。
- `ConcludeVerificationResult.conclusionReason` 的 JSON omission 与 schema-v1持久 shape 尚需治理固定。任何无法由 accepted handler contract / 历史 writer evidence 判定的字段规则均须单独提 Design Gap，不猜测闭合。
- P10 是否要求 CommandStore corruption 持久 Attention 仍 OPEN；本候选未新增 source。若治理要求持久 Attention，需要 P10 owner 另行裁决 source、target、identity、durability 和 no-repair。
- 本文仍是 DRAFT，FT-DG-03 accepted SHA 未变；即使这些 pending RED 后续进入 GREEN，也不能单独宣称 receipt integrity 或 F23 全面闭合。

## 提交范围

提交范围仅含此草案、本 pending RED 文件及本结果文档。不 push、不 merge；提交本身不构成合同接受、实现完成或 F23 闭合证据。
