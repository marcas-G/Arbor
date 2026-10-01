# SCRC 实现授权

## 状态

**AUTHORIZED — 2026-10-01。**

人工治理通过精确口令
`AUTHORIZE_SESSION_CONTEXT_RUNTIME_IMPLEMENTATION` 授权本文件固定对象对应的
SCRC-001…SCRC-008 完整实现范围。

## 固定授权对象

- System Design v1.4 / DID v1.22；
- design landing `75589c5`；design closure `f5ac7c0`；
- `planning/phases/SCRC.md`；
- `planning/tasks/SCRC-001.md`…`SCRC-008.md`；
- `planning/testing/session-context-runtime-convergence/acceptance-matrix.md`；
- `session-context-runtime-convergence-implementation-plan.review.md`
  （Blocking = 0）。

固定 SHA-256：

| Object | SHA-256 |
|---|---|
| `planning/phases/SCRC.md` | `F4E08C0C39B178E776326DBFDD0956820E9976D26D9C526B3C2EFEDF4CD886D7` |
| sorted `SCRC-001.md`…`SCRC-008.md` bundle | `390A85115B2F49FB5268E8A2D1E337DE144D52635261ABFEEF68FBFF1C23BCA8` |
| acceptance matrix | `890972E97F9A504DD00FAAB4809AA2E1D7BBD1A63F5997F73829456902803A39` |
| plan review | `B07953BDBF13A873AFB8546F206EECD4C413CA12D5CB448458940C979994726A` |

Task bundle hash recipe: sort task files by filename; for each line emit
`<filename> <file-sha256>`; join with LF; hash the UTF-8 bytes with SHA-256.

## 拟授权范围

- SCRC-001…SCRC-008，严格按 DAG；
- forward-only migration `0019_session_context_runtime_convergence`；
- typed Session/Provider items、input promotion、tool timeline、ContextProjector、
  Summary/ProviderNative compaction、budget/overflow、AH15–AH19；
- legacy compatibility and qualification only as frozen in DID v1.22。

## 明确不授权

- 修改 0001–0018 migration；
- 新 Domain lifecycle/settlement/Event；
- 新 package/dependency edge；
- 新 Provider family；
- 从文本恢复 callRef/authority；
- 修复或关闭 G-V2-1…4；
- 修改用户未纳入版本控制的 scratch files；
- 在 SCRC-008 前宣称完成。

## 人工授权口令

```text
AUTHORIZE_SESSION_CONTEXT_RUNTIME_IMPLEMENTATION
```

该精确口令已收到。Coding Agent 必须从 SCRC-001 的 failing tests 开始，严格按
phase DAG 推进；每个 task 的通过不代表整个 SCRC 完成，只有 SCRC-008 可以形成
最终 completion result。
