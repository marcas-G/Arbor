# STEP P1-04 — Projection Bridge

**Gate/决策**：P1_04_PROJECTION_GATE（D-034）：C1 结构化 ContextPackage · C2 固定模板渲染进
ModelRequest.system · C3 system prompt 契约（角色+四节 context+工具守则，无未来工具）·
C4 yaml 标准包 + ## 节解析器。

**实现地图**：
- `domain/context-package.ts`：ContextPackage Schema（identity/contract/resources/
  worktreeRoot/effective.storeCommitSha；effective.result 留 P1-08）
- `agent-runtime/system-prompt.ts`：renderSystemPrompt 纯函数
- `infrastructure/workspace-projection-reader.ts`：effective ref → workspace.yaml（yaml 2.9.1）
  + WORKSPACE.md（## 节 split 解析器）→ ContextPackage
- `entrypoints/openai-smoke.ts` 升级：init → projection → 渲染 system → 真模型在持久 worktree 干活

**不变式**：agent 的系统认知全部来自正式状态（store ref 解析），不隐式扫描仓库；
ContextPackage 不进消息流，只进 system 头。

**验收**：模板断言（四节、(none) 约束、无未来工具名）；对真 P1-01B store 的全链读取
（TBD 模板解析、缺目录 typed error）；**真模型**：`projection: worktree ready,
effective=48c55368, finish=stop steps=3, hello.txt correct: true`。

**偏差**：parseWorkspaceMd 首版正则被行尾锚截断，改 split 实现；`yaml` 为新依赖（精确 pin 2.9.1）。
