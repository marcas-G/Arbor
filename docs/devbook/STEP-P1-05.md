# STEP P1-05 — 持久 Agent：transcript + pause/resume

**Gate/决策**：P1_05_PERSISTENCE_GATE（D-035）：E1 九种事件 payload Schema ·
E2 agents（UNIQUE project）+ agent_runs 表（0002 迁移）· E3 `agent run` 命令面
（SIGINT 即 pause，再 run 即 resume）· E4 优雅暂停状态机（等工具终态，未 commit 的
模型轮丢弃）· E5 全量重放恢复（semantic resume，非 token 级）。

**实现地图**：
- `domain/transcript-events.ts`：九种 payload + 冻结信封（schemaVersion/eventId/agentId/
  sequence/timestamp/type/payload）
- `infrastructure/transcript-store.ts`：append-only JSONL writer（单调 sequence、resume 续序）
  + reader（未知事件 typed error）
- `agent-runtime/agent-loop.ts` 扩展：RunHooks（durable boundary 落盘点）+ "paused" finish
  + abort 中断（incomplete turn 不 commit）
- `agent-runtime/session-runner.ts`：replayMessages / isResumable / PauseController / SIGINT 安装
- `application/agent-runner.ts`：ensure agent+run 行 → transcript resume → projection →
  带暂停的 run → run 行收尾
- provider 层：AbortSignal 通道（叠 120s timeout，补 B4 遗留）
- CLI：`arbor agent run --project <uuid> [--task <text>] [--home]`

**不变式**（P1_PERSISTENCE 合同）：tool_result 落盘先于下一 model turn；append-only
（run-1 事件在 run-2 后全部仍在）；paused 落 pause_marker 不落 run_finished；
每 project 恰一个持久 agent（UNIQUE）。

**验收**：integration kill→restart 语义（暂停→文件已写→transcript 尾 pause_marker →
第二次 run resumed=true 同 agentId → resume_marker → run_finished → DB 1 agent/2 runs）；
无可恢复且无 task → 明确报错。

**偏差**：resume 的 RESUME_TASK 为固定英文提示语；SIGINT 进程级冒烟留手动（test seam
pauseAfterFirstStep 覆盖同路径）。
