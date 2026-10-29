# AH7 同一 ToolInvocationId 并发重入补测

日期：2026-10-07

状态：**定向单测 PASS；AH7 仍为 PARTIAL。**

`packages/tool-runtime/test/p4-ah7-concurrent-invocation.test.ts` 用屏障使两次
调用都先读到无 intent，再竞争同一 invocation key。模拟持久层唯一约束后，
最终只有一条 intent、一条 settlement 和一次 NonIdempotent executor effect；
竞争者在 IntentJournal 阶段失败关闭。与审批前效应重入补测合跑 2/2 PASS。
同批完整 `pnpm check` PASS（架构 155、核心 1687 + 3 skipped、Web 216）。

本用例使用 Port fake，**不是** SQLite 并发或真实进程崩溃资格。它不证明
已发生外部 effect 后的恢复，不解决 AH7-DG-01/02，也不关闭 AH7。
