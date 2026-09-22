# P9 — 06 Acceptance Stories

**Authority:** `02`–`05`; S4 全文（恢复前先确认现实状态/局部恢复/不盲目 replay）; P1 `06` 矩阵验收风格.
**Status:** DRAFT (first draft for contract review).

全部注入为真实进程/事务/fiber 级（GQ5）；deterministic；同一 durable DB。

- **Story A — 恢复可见性门**（B-1 前后对比）：unsettled NonIdempotent invocation + stopped execution → 修复前快照（记录会错误 settle 的形态）；修复后注入同场景 → escalate/OutcomeUnknown（永不 Interrupted）+ durable Attention 事实（journal 断言）+ 呈现零承诺。
- **Story B — 脏重启九步一次**（D 系列，双 fixture）：
  - B-清洗：stop 已请求且**全部 invocation 已 settle**（无未决副作用）→ T1 → settle `Interrupted(StopRequested)`（I-2 清洁路径）+ completion-fact fixture → 对应 Completed；lease 失效、runnable 重建、timers 重燃、重复 T1 幂等。
  - B-未决：active execution + unsettled ReadOnly+Reconcilable+NonIdempotent invocations + pending wake + open verification + expired lease → T1 → 按四档各自处置（ReadOnly/Idempotent 安全收尾、Reconcilable reconcile、NonIdempotent → escalate/OutcomeUnknown **永不 Interrupted**——I-1 after-fix）+ escalation 落 durable Attention 事实。
- **Story C — 复活与过期**（R/L 系列；tool 四档细则见 `02` §5 "T-Tier"）：stale worker 五写面全 FencingRejected；过期后 settle 拒；renewal（TTL/3 续租）边界——续租成功提交通过、过期后拒；pre-dispatch T4 只查 fence 谓词（断言不产生九步副作用）。
- **Story D — provider disconnect**（PD 系列）：连接前 inject → ProviderUnavailable 重试界；stream 中断 inject → StreamInterrupted 重试；crash 遗留 unsettled ProviderTurn → recovery 同 Turn 新 Attempt（turnNo/Manifest 不变断言）；界尽 → 既有 Turn 失败语义。
- **Story E — tool 四档**（T 系列）：dangling 检测（intent 无 settlement）；ReadOnly 重试；Idempotent same-identity；Reconcilable reconcile→settle；NonIdempotent → OutcomeUnknown 永不自动 replay（No.35）。
- **Story F — consumer/重建**（CC/RB 系列）：mid-batch crash 重放幂等；offset 回退由确定性 id 兜底；毒丸两路死信；rebuildProjection floor 拒绝/reset/重放幂等（GQ2 P9 面）；P10 边界负断言（业务投影 rebuild 不在 P9 断言集）。
- **Story G — P7/P8 工作流中断**（WF 系列）：coordinator 消费中断重放收敛；verifier spawn 窗口（P8 已闭合——注入验证不回归）；consumer A/B 中断重放；全部走确定性 id 幂等。
- **机械断言清单**：矩阵 `02` 每行至少一个机械化用例；guarantee 类别逐行标注（crash-injected vs durability-asserted）；durability-asserted 项以 reopen + integrity_check + user_version + 计数对账为 evidence（`02` §12）；P5/P6/P7/P8 回归护栏全绿；pre-dispatch T4 不跑九步（副作用计数=0）。
