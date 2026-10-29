# Verification Delivery Convergence — 阶段结果

**Status:** COMPLETE / FORMALLY CLOSED

**Date:** 2026-10-02

## 已落地

- CompletionClaim 事件忠实化、历史 reconciliation、Open Verification 与
  exact-bound verifier spawn。
- Verification `summaryRef` 的领域状态、SQLite migration 22、命令结果与
  `VerificationConcluded` 事件传播；数据库 trigger 拒绝无摘要结论。
- Child `initialWork` 必须携带显式完整 VerificationMission；formation 不再
  生成占位验收条件。
- migration 23 保存 ToolObservation 的
  `(toolInvocationId, observationRef, executionId, callRef)`。
- verifier 专用 TurnProfile：持久化角色识别、可执行工具、只暴露 evidence / conclusion
  控制工具；普通 Work Agent 看不到这两个工具。
- verifier authority ceiling 仅允许 `fs:read` / `shell:exec`，拒绝 `fs:write`。
- ExecutionBound mission 进入 Model Context；生产 daemon 驱动 active
  ExecutionBound 执行，不再只 admission 不运行。
- 结论摘要先写 BlobStore、逐字节回读，再提交 summaryRef。
- 结论成功后精确释放 `VerificationChanged(workId, revision)` 等待。
- exact-bound verifier 在结论命令和 wake 成功后立即
  `Completed(VerificationConcluded)`；该 settlement 不进入 CompletionClaim
  consumer。
- 同一 Work revision 已有 Concluded Verification 时，重复 CompletionClaim
  不再自动创建新 Verification；显式 re-verification 仍走新
  `StartVerification` identity。

## 真实 dogfood 证据

```text
Work: wrk_01a0f834-681f-7b62-9455-aa83bba1e10b @ revision 1
Verification: ver_29e6dff1-a698-77bb-80a0-8bfb6ebe6ef6
state/verdict: Concluded / Pass
summaryRef: c326c5648f5fa5460bb7033b86155d414e5c8194577e47d7b23875ce1b15d979
VerificationConcluded events: 1
WorkWait after wake: absent
```

每个 required criterion 都至少有一条 exact-source evidence：

| criterion | evidence | exact source |
|---|---:|---:|
| `p17-legacy-symbols-absent` | 2 | 2 |
| `focused-test-green` | 2 | 2 |
| `scope-isolated` | 1 | 1 |

重复 evidence 来自前一次达到轮次上限后的安全重试；append-only 记录均有不同
canonical invocation identity，没有覆盖或伪造。

## 验证

最终 `pnpm check`：

```text
lint PASS
typecheck PASS
architecture 121/121 PASS
core 1548 PASS, 1 SKIP
web typecheck/build PASS
web 212/212 PASS
git diff --check PASS
```

## 提交

```text
4c3b8a4 feat(verification): persist delivery contracts
9640c71 feat(verification): expose verifier runtime tools
363bdf6 fix(runtime): drive execution-bound agents
1f12edf feat(authority): narrow verifier tool capabilities
1e2d79c fix(context): project execution-bound missions
d9ed3c1 tune(agent-loop): expand bounded turn budget
44e2b4c fix(verification): resolve evidence selectors
49007db tune(agent-loop): support full verification episodes
e9603d2 fix(verification): release concluded work waits
a872b25 docs(governance): freeze verifier execution settlement
3f57c9e feat(verification): settle concluded verifier executions
83bebfa fix(verification): suppress duplicate claim reverification
9b4d55d fix(completion): register complete work handler
```

## 尚未关闭

无。VD-RUNTIME-GAP-01 已关闭；历史 Failed/Interrupted verifier Execution 按
冻结规则保留，不回写。

## Parent Acceptance / Completion closure

用户明确指令：`接收当前验证结果并完成 Work`。

```text
Acceptance: acc_2a359296-6f90-7182-84bf-f42cc242d3bd
Work: wrk_01a0f834-681f-7b62-9455-aa83bba1e10b @ revision 1
Verification: ver_a5e19904-f0a2-782c-8af3-93aa39273d5d / Pass
Work lifecycle: Completed
Workspace currentWorkId: null
WorkOutcomeAccepted events: 1
WorkCompleted events: 1
active WorkWait: 0
active main Execution after governed Stop cleanup: 0
consumer dead letters: 0
```

Production registry now includes `CompleteWork`; completion remained entirely
on the canonical `WorkOutcomeAccepted → completion consumer → CompleteWork`
path. No direct database lifecycle mutation was used.
