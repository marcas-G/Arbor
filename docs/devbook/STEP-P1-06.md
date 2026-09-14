# STEP P1-06 — Compaction

**Gate/决策**：P1_06_09_GATES §P1-06A（D-036）：**机械确定性压缩**——同输入必同输出，
丢失即从 transcript 重放重建（compaction 是派生缓存，P1 不用 LLM 摘要）。
阈值 80 / 保留尾 20 / 摘要拼接上限 4000 字符。

**实现地图**：
- `agent-runtime/compaction.ts`：compactMessages 纯函数（null = 未达阈值；
  否则丢弃前缀 → 一条 compacted-context 消息 + 尾部逐字保留）
- `application/agent-runner.ts`：resume 时应用——压缩则写
  `agent-state/<agent>/compaction/summary-<seq>.json`（schemaVersion/覆盖区间/droppedCount/
  summaryText/createdAt）+ transcript `compaction_reference` 事件
- `domain/transcript-events.ts`：CompactionReference payload

**不变式**：确定性（相等输入 → 相等 plan——重建性测试锁定）；transcript 永不因
compaction 丢失内容；压缩只发生在 resume 时点（运行中不压缩）。

**验收**：阈值边界（=100 不压 / >80 压）、尾部逐字、确定性、4000 截断。
