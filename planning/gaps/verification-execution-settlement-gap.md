# VD-RUNTIME-GAP-01 — Verifier 成功交付后的 Execution Settlement 缺口

**Status:** CLOSED — design accepted by `ACCEPT_VERIFIER_EXECUTION_SETTLEMENT`; implemented and live-qualified by `3f57c9e`

**Date:** 2026-10-02

## 现象

真实 verifier 已经成功提交：

```text
arbor_record_verification_evidence × 3
arbor_conclude_verification(Pass) × 1
Verification.state = Concluded
Verification.summaryRef != null
```

但 `ConcludeVerification` 控制动作当前返回普通 Observation。Agent Loop 因而
继续下一轮，直到有界 `MAX_TURNS` 用尽，最后把 Execution 记录为：

```text
Failed(ExecutionFailure("max turns reached"))
```

这与已经成功落地的 Verification 事实不矛盾，但会制造误导性的运行时状态。

## 失败证据

```text
Verification: ver_29e6dff1-a698-77bb-80a0-8bfb6ebe6ef6
Verdict: Pass
summaryRef: c326c5648f5fa5460bb7033b86155d414e5c8194577e47d7b23875ce1b15d979
Verifier Execution: exe_b77f20f8-e76a-7211-878f-babbc93efe7c
Control actions: evidence/evidence/evidence/conclude = Applied
Execution settlement: Failed(max turns reached)
```

## 根因

`CompletedResult` 只有：

```text
Yielded | CompletionClaimed | CoordinationCompleted | QueryCompleted
```

没有能如实表达“ExecutionBound verifier 已经完成 canonical conclusion”的
变体。把它伪装成 `QueryCompleted` 或 `CoordinationCompleted` 会污染领域语义，
因此实现没有采用这种补丁。

## 需要人工治理裁决

推荐新增专用完成结果：

```ts
{ readonly _tag: "VerificationConcluded";
  readonly verificationId: VerificationId;
  readonly verdict: VerificationVerdict }
```

控制动作在 `ConcludeVerification` 命令成功提交且 wake 已交付后，返回
`Settle(Completed(VerificationConcluded))`。裁决还应明确该结果是否适用于
所有 verifier Execution，及其与 orphan 检测的关系。

在裁决前，禁止复用其他 CompletedResult 标签来掩盖缺口。

## Closure evidence

```text
Verification: ver_a5e19904-f0a2-782c-8af3-93aa39273d5d
Verifier Execution: exe_d446c231-aaa5-7af2-8735-9c4c6134acc2
Verification: Concluded(Pass)
Execution: Completed(VerificationConcluded { verificationId, verdict: Pass })
Required evidence: 3/3 exact-source records
Consumer dead letters: 0
```

No `QueryCompleted` / `CoordinationCompleted` reuse was introduced.
