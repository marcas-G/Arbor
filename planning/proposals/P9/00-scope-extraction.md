# P9 — Design Closure: Scope Extraction & Classification (PROPOSAL, not frozen)

> 依据治理指令：本轮仅做范围提取、三分类与治理问题清单；**不起草 P9 契约**。

**Authority:** DID v1.11 §11 P9（九类注入面枚举）, v1.9 G5（三方分工：P2 机制 / P5 代表性证明 / P9 系统性硬化）, v1.7 G1/G3/G5, v1.11 G2/G5; SD v1.3 §6.5/§7.3/§10 全章/§13.9/§14 No.15/16/34/35/36/37/39/46/47/48/53/54/60; S4 全文, S3 步骤 10; P1 `06`（C1-C11 矩阵格式先例）, P2 `03`/`06`（恢复骨架）, P3 `06`, P4 `01`/`02`/`06`, P5 `04`/`05`, P8 `00`/`02`/`03`; `planning/results/P8.result.md`（crash windows closed 记录）。
**Status:** SCOPE EXTRACTION — awaiting governance decisions GQ1–GQ5 before contract drafting.

## 1. P9 定位重申（非新子系统）

```text
P9 = systematic fault injection & hardening over EXISTING semantics
     （P2 拥有恢复机制；P5 已拥有代表性 restart 证明；P1 已拥有命令事务 C1-C11 矩阵）
```

九类注入面（DID §11 原文枚举）逐条对位到既有冻结语义与实现基线：

| 注入面 | 冻结语义来源 | 实现基线（HEAD 0632da1） |
|---|---|---|
| worker crash | P2 `03`/`06`（lease 惰性失效、settle 规则） | FenceStopCheck 已实现；系统性复活注入未做 |
| daemon crash | C1 确定性（§12.2）、recovery 九步（P2 `06`） | runRecovery 已实现但**无生产驱动**（测试直调） |
| provider disconnect | §6A.8 六分类 + P3 `06` failure model | **无 timeout 分类、unsettled turns 无 reconcile**（见 GQ5） |
| tool outcome unknown | P4 `06`（intent-before-effect、四档 semantics）、SD §6.5 | 真 ReconciliationSourceLive 已实现但**组合根接 stub**（见 B-1 前置修复） |
| lease expiration | P2 `03`（CAS generation 单调、惰性失效） | 已实现；**无 renewal 循环**（30s TTL 硬编码） |
| old worker resurrection | §6.3 fencing 全写面 + §6A.5 | 已实现单测级；注入矩阵未系统化 |
| dispatch failure | P2 `02`（durable wake intent、never settles） | WorkerDispatch 为 no-op stub、无 durable 记录 |
| consumer crash | P1 `05`（offset+dead-letter 同事务） | 基建完整但 P7/P8 consumers **未接 offset**（事件数组直调） |
| projection rebuild | P1 `05` §6（floor/reset/replay） | generic rebuild 已实现；业务投影 rebuild 归属见 GQ2 |

## 2. Classification

### A. Upstream design defects / ambiguities（需治理裁决）

| # | 事项 | 证据 | 建议处置 |
|---|---|---|---|
| UD-1 | **X1–X11 不可追溯**：repo 内仅存 "closed" 状态行（v1.4 起即无正文），A1–A11 声称已吸收但无映射；P9 引用注入面时对不上号 | DID:4333, 4630 vs A 段声明 | **GQ1** |
| UD-2 | **projection rebuild 的 P9/P10 归属张力**：§11 P9 注入清单含 "projection rebuild"，P2 `06` 将 rebuild 列 P10 out-of-scope，P1 `06` 写 "(P9/P10)" | DID:3789 vs P2/06:141 | **GQ2** |
| UD-3 | **recovery pass 触发时机未冻结**：九步顺序冻结，但何时运行（daemon 启动/周期/事件触发）在 DID/SD/P2 契约均无表述 | P2/06:29-41 无触发节 | **GQ3** |
| UD-4 | **"provider disconnect" 无对应失败分类 + unsettled provider turns 无恢复契约**：§6A.8 六分类无 disconnect；ProviderTurn intent-settlement 悬挂的恢复处理 P3 `06` 明示不做 | DID:3779 vs §6A.8、P3/06:86 | **GQ4** |
| UD-5 | **durability 注入深度**：C10/C11（断电/WAL checkpoint）不可进程内复现——延续 P1 "durability-asserted, not crash-injected" 纪律，还是引入 fault-injecting SQLite adapter | P1/06:35-39 | **GQ5** |

### B. P9 phase-scoped hardening contracts（硬化契约权限内，无需上游变更）

1. **B-1 恢复可见性前置修复**（最高优先）：组合根 ReconciliationSourceStub → 真实现接线（否则有未决副作用的 stopped Execution 被错误 settle 为 Interrupted——违反不变量 54）；escalation 从内存数组 → durable Attention 事实。
2. **B-2 completion-fact settle case 实现**：P2 `06` §4 已冻结（持久化 completion/claim 事实 → 对应 Completed settlement），代码缺失。
3. **B-3 注入矩阵契约**（P1 `06` 格式先例）：每注入面 × 注入点 × 期望断言 × 通过标准——worker crash（dispatch 前/lease 获得前/drive 中/settle 前）、resurrection（stale generation 写全写面五类）、lease expiry（惰性失效/renewal 边界）、tool 四档 semantics 各自的 dangling/reconcile/OutcomeUnknown 断言、consumer crash mid-batch/毒丸死信、daemon crash 脏重启（带未决状态 dispose/reconstruct）、P7/P8 工作流中断点重放矩阵（coordinator/verifier spawn/consumer A/B 各中断点）。
4. **B-4 lease renewal 循环**（P2 契约已有 acquire/renewal/release CAS 冻结，代码缺 renewal 驱动）+ TTL 值声明为 empirical。
5. **B-5 consumer offset 接线**：P7/P8 consumers 接 P1 offset/dead-letter 基建（保持确定性 id 幂等双保险）。
6. **B-6 dispatch 故障语义系统化**：dispatch failure never settles（既有）+ lost-dispatch 兜底 = 下一轮 reevaluation（reevaluate 循环既有）——注入断言最小可观测面。
7. **B-7 provider 故障注入**（按 GQ4 裁决形态）：disconnect 场景组合注入 + retry 界断言 + unsettled turn 恢复路径。
8. **B-8 持久化边界**：COMMIT 失败的 ROLLBACK 兜底检查（transaction.ts:49 现无显式回滚）、嵌套拒绝、busy 重试界——C10/C11 纪律延续（按 GQ5）。
9. **B-9 timer 重燃驱动**：durable TimeReached 的 dueTimers 恢复扫描接线（port 已冻结零生产调用）。
10. **B-10 消歧注记**：Phase P9 ≠ DID §8.4 Program "P9 Verification Program"（后者已随 P8 交付）——契约与任务命名统一用 "Phase P9 / recovery hardening"。

### C. Implementation / empirical choices（任务级）

注入基建形态（faultingTransaction 扩展 modes vs 新 fault-harness）；进程级 crash 模拟手段（layer dispose vs fiber interrupt vs 子进程 kill）；lease TTL / 重试次数 / 批大小；测试套件组织（单 p9-hardening 套件 vs 按注入面分套件）；RuntimeSafetyGate 持久化与否（进程内存语义是否升级——默认维持 P2 冻结的进程内语义，仅注记）。

## 3. True governance questions（仅此 5 项需人工裁决）

- **GQ1（UD-1）X 系列**：声明 "X1–X11 已被正文取代、P9 不引用"（零变更，推荐——A1–A11 吸收声明 + C 系列/不变量已覆盖注入断言面）；或补正文；或 P9 忽略并仅引用 C/不变量。
- **GQ2（UD-2）projection rebuild**：冻结二分——**P9 验证恢复性**（generic rebuild 语义注入：offset 丢失/reset/floor 拒绝/重放幂等），**P10 实现 at-scale 业务投影 rebuild**（推荐，与 P2 契约相容）；或 P9 全做；或整体让 P10。
- **GQ3（UD-3）recovery pass 时机**：(a) daemon 启动时一次 + 每 dispatch 轮前检查（混合，推荐——覆盖脏重启与运行中失效）；(b) 仅启动时；(c) 周期性。影响恢复时延语义与注入断言形态。
- **GQ4（UD-4）provider disconnect**：(a) **零 DID 变更映射声明**：disconnect ≜ StreamInterrupted ∨ ProviderUnavailable 的注入场景组合（推荐）；unsettled provider turns 的恢复处理（settle Unknown/重试界/升级）作为 **P9 新冻结面**（P3 明示不做的部分由 P9 硬化契约承接——需认可此归属转移）；(b) 扩 §6A.8 加 Disconnect 分类（DID 变更）。
- **GQ5（UD-5）注入深度**：(a) 延续 P1 纪律——envelope 内故障可注入（进程/事务/fiber 级），断电/WAL 级 **durability-asserted, not crash-injected** 如实记录（推荐，工具成本可控）；(b) 引入 fault-injecting SQLite adapter（伪造 COMMIT 失败/页损坏——更强但新基建+新风险面）。

## 4. Status

```text
SCOPE EXTRACTION COMPLETE. No P9 contracts drafted, no planning, no implementation.
Next (after GQ1–GQ5 decisions): P9 phase contracts → four-way review →
Blocking=0 → planning → implementation authorization.
```
