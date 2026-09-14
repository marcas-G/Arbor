# STEP P1-03 — Minimal Agent Runtime

**Gate/决策**：P1_03_RUNTIME_GATE（D-032）+ D-033（Responses 适配器）。
A1 Chat Completions 非流式 · A2 OPENAI_MODEL 必填（无硬编码默认）· A3 stream=false ·
A4 ModelTurn 归一化 · B1 五工具 · B2 精确单匹配 edit · B3 argv 命令 ·
B4 30s/120s/25 步/3 连同调 · OPENAI_BASE_URL/OPENAI_API_STYLE 扩展（DeepSeek 网关）。

**实现地图**：
- `agent-runtime/provider.ts`：ModelPort / ModelTurn / ChatMessage / ModelToolSpec
- `agent-runtime/tool.ts`：toolFromSchema（Effect Schema → toJsonSchemaDocument 派生；
  decode 失败 → typed tool error 不 throw）
- `agent-runtime/tools/`：read_file / write_file / edit_file（唯一匹配）/ run_command
  （argv+timeout，30s 默认 120s 帽）/ git_status —— 全部 worktree-rooted + §11 路径校验
- `agent-runtime/agent-loop.ts`：循环 + guards（step-limit / 3 连同调 loop-guard /
  工具错误回填继续）
- `infrastructure/`：fake-provider（剧本）/ openai-chat-provider / openai-responses-provider
  （fetch+env 注入可测；AbortSignal.any(120s)）

**解耦重构**（用户发起，opencode 对照）：provider 适配器从 agent-runtime 移入
infrastructure——业务循环零协议知识，与 opencode 的 provider 工厂层同构。

**不变式**：loop 只认 ModelPort；工具永不 throw（结果联合）；JSON Schema 顶层必为
type:"object"（信封剥除 + 空参数规范化，双回归测试）。

**验收**：Fake 全矩阵（循环三 finish、错误回填、真文件写出）；**真模型**：
DeepSeek v4-flash Responses 面，`finish=stop steps=2, hello.txt correct: true`。
三个 wire 级 bug 由真环境暴露并回归锁定（模型名停用 / schema 文档信封 / 空 schema 形态）。
