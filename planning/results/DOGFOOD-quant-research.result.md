# Arbor Dogfooding — 量化研究真实会话

**Date:** 2026-10-01

**Status:** PASS WITH ONE OPEN DESIGN GAP

**Scope:** 本地真实 Provider、Root Human Conversation、Session 连续性、重启恢复；纯研究，不下单、不连接交易账户

## 1. 运行环境

- HTTP：`http://127.0.0.1:8787`
- Project：`量化研究`
- ProjectId：`prj_01a0edd7-b822-7f01-bbf5-5aa68bf5b195`
- Root WorkspaceId：`ws_01a0edd7-b822-7cfc-8f00-04ba5bc1ff20`
- Model binding：`model-deepseek-v4-flash`
- Database migration：v20
- 最终进程：PID 16960

API key、Authorization header 与原始 secret 从未写入本结果文件或测试输出。

## 2. Dogfooding 发现并修复的问题

### F1 — Root Conversation 错误暴露 Work control tools

首条真实消息 `msg_01a0f740-e2b1-74fa-ba90-5a0cacbee07e` 的模型输出包含正常研究文本，但随后调用了 `arbor_claim_completion`。该动作只适用于绑定 Work 的 execution；当前是 Coordination execution，因此 handler 拒绝，Execution 以 `Interrupted(ControlActionHandlerRejected)` 结束，HumanMessage 却按冻结规则成为 `Answered(null)`，UI 没有 Assistant turn。

修复：

- Root Human Conversation 显式使用空 control-tool surface；
- `controlTools: []` 被视为目的解析后的明确空集；
- compiler 不再在明确空集后注入 legacy `arbor_directive`；
- 缺少 ControlToolCatalogPort 的旧调用仍保留兼容 fallback。

### F2 — 终止型 action 没有闭合 ToolCall/ControlResult

同一失败留下 `ToolCall(arbor_claim_completion)`，但 action ledger 仍为 `Pending`，Session 没有匹配的 `ControlResult`。后续模型请求继承了残缺 tool timeline。

修复：

- control/executable handler 拒绝、decode 拒绝、handler 缺失、Runtime Safety Stop 均先写 sourced terminal result；
- action 转为 `TerminalRejected`，step 转为 `SettlementProposed`；
- 正常以 settlement 结束的 control action 也写配对 `ControlResult`；
- `OutcomeUnknown` 保留 `ReconciliationPending`，不伪装成功。

### F3 — Production Execution settlement timestamp 写死为 `"t"`

真实数据库中 `executions.settled_at` 和 `ExecutionSettled.occurredAt` 使用了测试占位符。修复后 `runExecution` 从统一 `Clock` 获取 state 更新时间和 settlement 命令时间。

### F4 — Conversation retry storm（未擅自改语义）

残缺上下文导致 provider 连续产生空输出；每个 execution 经三次 repair 后 Failed，P14 冻结的 `retry-until-response` 规则在约 80 秒内把同一消息推进到 `attempt_no = 42`，没有 backoff、budget 或 circuit breaker。

这是设计缺口，不可用实现私自加 cap。已记录：

```text
C:/Arbor/planning/gaps/DOGFOOD-DG-02-conversation-retry-storm.md
```

失败现场保存在本地 git-ignored 数据库：

```text
C:/Arbor/arbor-slice.dogfood-retry-storm-20261001.db
```

## 3. Provider 与部署验证

- 同一 endpoint/model 的非流式直连：HTTP 200，正文 4 字，reasoning 77 字。
- 同一 endpoint/model 的 SSE 直连：首字节约 392 ms，总耗时约 1.37 s，57 chunks。
- 完整量化研究上下文在 90 秒 idle timeout 下曾发生 `StreamIdleTimeout`；本地 git-ignored 部署配置调整为 180 秒后成功。该值属于 deployment policy，不是代码常量。

## 4. 成功的真实会话

### 历史研究消息恢复

- MessageId：`msg_01a0edd8-897e-7ac0-b4fe-2fd3b332b5fb`
- ExecutionId：`exe_e7244d40-e017-7679-8378-0e37f2f31a34`
- Outcome：`Answered`
- Response：3703 chars
- 同一 Execution 内完成，没有快速 execution churn

### 连续追问

- MessageId：`msg_01a0f759-9f01-7387-a124-9ea4858d9139`
- ExecutionId：`exe_aefffb06-5aef-738a-8a91-a16f80be5aec`
- Settlement：`Completed(QueryCompleted)`
- Attempt：0
- Response：1396 chars
- Provider usage：input 2554 / output 4186 / reasoning 3322 / cache-read 128 tokens
- Manifest：`toolRefs=[]`、`toolRoutes=[]`、tool definition count 0
- Input frontier：sequence 0..2
- Provider input kinds：3 个 Message（上一轮 Human、上一轮 Assistant、本轮 Human）
- Session timeline：UserMessage → AssistantMessage → UserMessage → AssistantMessage

以上证明会话历史不是靠 prompt 文本猜测，而是从 typed Session timeline 投影到下一轮。

## 5. 重启恢复

完成连续追问后，Arbor 先从 PID 21088 重启验证，再在最终代码构建后重启到 PID 16960。重启后：

- `/projects` 返回 3 个 Project，且唯一命中 `量化研究`；
- transcript 返回 4 个 conversation entries；
- 最后两条是同一 MessageId 的 Human/Assistant pair；
- body 长度分别为 132 / 1396；
- 没有重复 Assistant turn，没有消息回退到 Pending。

## 6. 机械验证

```text
pnpm check

lint: PASS (812 files)
typecheck: PASS
architecture: PASS (20 files / 121 tests)
core/backend: PASS (261 files / 1527 passed / 1 skipped)
web typecheck: PASS
web build: PASS (existing >500 kB chunk warning only)
web: PASS (31 files / 211 tests)
git diff --check: PASS
```

## 7. 结论

真实量化研究的普通对话、上下文连续性、Provider 调用、持久化写回和干净重启已经通过。工具时间线的终止闭合也有新增机械测试。当前唯一不能在实现层擅自关闭的问题是 `DOGFOOD-DG-02`：冻结的无限 `retry-until-response` 在确定性失败下会造成调用风暴，需要人工治理决定 bounded retry/backoff/Attention/resume 语义。
