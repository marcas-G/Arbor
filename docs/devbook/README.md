# Arbor Devbook — P1 实现文档

> 设计源文档：`workspace_agent_stage_docs_v0_3/`（stage docs，决策权威）。
> 本目录是**实现侧交付文档**：每个 STEP 的设计映射、实现地图、不变式、验收证据、偏差记录。

## P1 全景

Arbor P1 证明：**一个 Runtime Project + 一个 Root Workspace + 一个持久 Primary Agent**
能在中断/重启下执行真实编码工作，并维持可信的 Working → Effective 边界。

```
用户源仓库 (git)
   │ project init
   ▼
ARBOR_HOME/projects/<id>/
├── runtime.db          ← 运行态索引（可丢，reconcile 重建）
├── workspace-store/    ← 工程真相（git 仓库；refs/arbor/effective/<ws> = 激活点）
├── worktrees/root/     ← Working State（agent 在这里干活）
└── agent-state/<agent>/transcript.jsonl ← agent 执行正史（append-only）

agent loop: projection(正式状态→ContextPackage→system prompt) → model call
  → tools(5 执行工具 + 4 workspace 请求工具) → transcript 落盘 → 循环/guards
report_completion → Runtime-owned finalization:
  prepare(candidate commit) → verify(命令) → activate(记录+store commit+CAS ref)
```

## STEP 索引

| STEP | 文档 | 交付 |
|---|---|---|
| P1-01A | [STEP-P1-01A.md](./STEP-P1-01A.md) | 工具链骨架 |
| P1-01B | [STEP-P1-01B.md](./STEP-P1-01B.md) | Runtime Project bootstrap（init/show） |
| P1-02 | [STEP-P1-02.md](./STEP-P1-02.md) | Domain 类型层（Effect Schema） |
| P1-03 | [STEP-P1-03.md](./STEP-P1-03.md) | Agent Runtime（provider/loop/工具） |
| P1-04 | [STEP-P1-04.md](./STEP-P1-04.md) | Projection Bridge |
| P1-05 | [STEP-P1-05.md](./STEP-P1-05.md) | 持久 session + pause/resume |
| P1-06 | [STEP-P1-06.md](./STEP-P1-06.md) | Compaction |
| P1-07 | [STEP-P1-07.md](./STEP-P1-07.md) | Workspace Request API |
| P1-08 | [STEP-P1-08.md](./STEP-P1-08.md) | Working→Effective 激活循环 |
| P1-09 | [STEP-P1-09.md](./STEP-P1-09.md) | 故障审计与 reconcile |

## 分层与依赖方向（DEPENDENCY_RULES 的实现现状）

```
src/domain/           纯值与不变量（ids、path、Schema 类型、transcript 事件 payload）
src/application/      编排：ports、bootstrap、agent-runner、finalization、reconcile
src/agent-runtime/    agent 内核：ModelPort 契约、loop、工具、system prompt、compaction
src/infrastructure/   适配器：git-cli、sqlite、fs、3 个 provider、transcript-store、projection-reader
src/entrypoints/      组合根：cli、smoke
```

与 opencode 的对照（"copy architecture, not product assumptions"）：

| Arbor | opencode 参照 |
|---|---|
| ModelPort + ModelTurn 归一化 | session/llm + @opencode-ai/llm 事件契约 |
| infrastructure providers（chat/responses/fake） | provider/provider.ts 的 @ai-sdk 工厂注册表 |
| agent-loop + guards | session 引擎循环 |
| tools/（schema 派生 JSON Schema） | tools/registry |
| transcript.jsonl + agent_runs | session 持久化（Arbor 拆为 git/sqlite/jsonl 三态） |
| finalization（CAS ref 激活） | snapshot（Arbor 的正式化强化版） |

## 决策索引

D-029 版本对齐 · D-030 bootstrap 确定性 · D-031(+amend) domain 类型/effect 引入点 ·
D-032 P1-03 runtime gate · D-033 Responses 适配器 · D-034 projection gate ·
D-035 persistence gate · D-036..039 最终四 gate（见 stage docs DECISION_REGISTER）

## 测试与验收状态

- 152 tests / 31 files 全绿（unit 17 + integration 11 + acceptance 3）
- 真模型双验收：P1-03（agent loop）、P1-04（projection 链），DeepSeek v4-flash Responses 面
- P1-05..09 的验收为 Fake provider + 真 git/sqlite/fs 的 integration/acceptance 全链路
