# Phase 4 — 通信与边界强制（D-043）

**Gate**：`P4_GATE.md`（问题式存档：每条先写面对的问题再写方案——用户流程反馈后固定此格式）。
I1 邮箱通信 · I2 向下可见性 · I3 bwrap 沙箱+宿主 web_fetch · I4 验证者 agent（同内核换身份）。

**实现地图**：
- `application/communication.ts`：sendInformation（LCA 路由 → 目标 inbox 落盘 +
  store commit 即通信正史）/ listInbox / answerInformation（更新记录 + commit）
- `agent-runtime/tools/workspace-requests.ts`：inspect 增 children 只读投影（来自
  store history，天然只读）；新增 request_information / list_inbox / answer_information
  三工具（execute 委托 Runtime 闭包——agent 永不直触 store）
- `agent-runtime/tools/run-command.ts`：SandboxConfig——bwrap 包装（系统 ro、
  worktree rw、默认 --unshare-net、allowNetwork 显式放开）；bwrap 缺失=typed
  拒绝绝不静默降级；`agent-runner` 从 workspace.yaml 读 sandbox 配置
- `agent-runtime/tools/web-fetch.ts`：宿主侧 GET→text（https only、30s 超时、
  20k 截断、可选域名白名单）——联网能力独立于沙箱策略（Codex 模型）
- `agent-runtime/verifier.ts`：runVerifierAgent——**同一 agent 内核**（runAgent）
  + 固定审核员 prompt + 只读工具（read/git_status/web_fetch）+ 一次性实例；
  结论=末轮 JSON {verdict, reason} 解析，解析失败=inconclusive（绝不静默 pass）
- `application/child-creation.ts`：governance.llm 可选门接 verifier agent

**不变式**：通信只动 inbox 文件与 store 历史，任何 effective ref 不动（验收断言）；
投递只由 Runtime 执行（agent 无 store 工具）；沙箱拒绝路径 typed；verifier
inconclusive 阻塞。

**验收（178 tests 全绿）**：兄弟通信全流程（A 问→路由记录→B 的 agent 在自己 run 里
list_inbox+answer→正史 comm: 提交→root ref 不动）；inspect children 投影；
verifier 三态（pass/fail 解析 + 垃圾输出=inconclusive）；sandbox（有 bwrap 则
沙箱内跑通、无则 typed 拒绝）；web_fetch 边界（https only/404/截断）。

**偏差**：通信记录 answer 是原地更新+git 历史留痕（非 append-only 事件流——
P1 transcript 语义不适用于通信，git 提交链即审计）；LLM verifier 未做反注入
加固（记 open，P5）。
