# AH7 审批已消费后的同调用重入补测

日期：2026-10-07

状态：**定向单测 PASS；AH7 仍为 PARTIAL。**

`packages/tool-runtime/test/p4-ah7-approval-consumption-reentry.test.ts`
构造同一 ToolInvocation 的已记录 intent、已消费 approval，以及执行器尚未进入时
SandboxOpen 中断。重入后断言：intent 与 approval 各写一次，执行器与 settlement
各执行一次，成功观察结果保持一致。主 Agent 复跑定向 Vitest：1/1 PASS。
同批完整 `pnpm check` PASS（架构 155、核心 1687 + 3 skipped、Web 216）。

这是使用可控 Port 的前效应中断测试，**不是**真实进程 kill/restart，也没有证明
approval 消费与 P4 settlement 的原子性。AH7-DG-01 非 Success Observation、
AH7-DG-02 主动外部现实 reconciliation、真实 SQLite 并发与其他多动作交错
仍需独立证据；不得由本测试关闭 AH7。
