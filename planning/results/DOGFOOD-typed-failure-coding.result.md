# Arbor Dogfooding — 类型化失败驱动的真实编码任务

**Date:** 2026-10-03

**Status:** PASS

**Provider:** official DeepSeek / `deepseek-flash`

## 任务

Arbor 在临时隔离 Git 工作树中获得一个真实失败的最大回撤实现：

```js
peak = Math.min(peak, value);
```

Agent 必须先运行失败测试、读取测试与实现、只修改实现文件、重新运行测试、检查
Git 范围和 diff，然后调用 `claim_completion`。测试与主仓库均不允许修改。

## 真实执行结果

```text
Provider turns:       9
Tool invocations:    12
Success:              9
ExpectedFailure:      3
Initial node --test: exit 1
Final node --test:   exit 0
git diff --check:    exit 0
Git status:          M src/drawdown.mjs
Execution:           Completed(CompletionClaimed)
Work lifecycle:      Open
```

三条 ExpectedFailure 均成为后续决策信息：

1. `node --test 2>&1 | tail -40`：PowerShell 环境没有该 Unix pipeline 行为；
2. `node --test 2>&1`：成功取得真实测试失败；
3. 第一份 unified diff 无法应用：Agent 随后读取精确源码并生成可应用 patch。

Agent 没有因以上任何失败终止 Execution，也没有要求人工接管。

## 最终修改

```diff
-    peak = Math.min(peak, value);
+    peak = Math.max(peak, value);
```

外部 oracle 在 Agent 结束后独立确认：

- 三条 Node 测试全部通过；
- 测试文件没有修改；
- 只有 `src/drawdown.mjs` 与 baseline 不同；
- diff 无 whitespace error；
- Provider trace 包含 `claim_completion`；
- CompletionClaim 没有直接完成 Work，Verification / Parent Acceptance 边界保持。

## 机械证据

真实 Provider 测试：

```text
C:/Arbor/tests/capability/real-provider/dogfood-coding-task.test.ts
```

完整脱敏证据：

```text
C:/Arbor/planning/testing/core-capability/evidence/real-provider/
DOGFOOD-CODING-REAL-2026-10-02T19-47-24.503Z-b5391647-5566-4f78-945c-874d7afbbfce.json
```

测试结果：

```text
1 file / 1 test PASS
real task duration: 24.5 s
```

API key、Authorization header 与原始 secret 未写入结果或 evidence。隔离工作树在
证据提取后删除，主仓库没有被 Dogfood Agent 修改。

## 结论

本次运行证明 Waves 1–5 的核心目标在真实模型上成立：工具失败是 Agent 的可用
信息；Agent 可以连续吸收 shell/test/patch failure，修正行为并完成实际编码任务，
而 Runtime 仍保持资源隔离、调用配对、完成声明与 Work 生命周期边界。
