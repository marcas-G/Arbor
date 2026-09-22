# P11 — Design Closure: Scope Extraction & Classification (PROPOSAL, not frozen)

> 依据治理指令：本轮仅做范围提取、三分类与治理问题清单（独立 gap review 后返回 true governance questions）；**不起草 P11 契约、不生成 planning**。

**Authority:** DID v1.13 §11 P11, §1.5 (C8 resolver/CAS 序列), §4.3/§4.4, §5.3, §7.6, §8.16/§8.18/§8.19, §9.5, §12.9 C8, §12.10 (environment 行); v1.7 G2/G3, v1.8 G3/G4/G5; SD v1.3 §4.5, §6.2, §6.5, §7.6, §11 全章, §13.6, §15.3, §14 No.26/43/50/52/56; P1 `02`/`04`/`06`, P2 `00`/`01`/`02`/`04`/`05`, P4 `01`/`02`/`04`/`05`/`08`, P5 `00`/`01`, P6 `00`, P7 `00`, P8 `00`/`01`/`04`, P9 `00`, P10 result; `planning/results/P8.result.md`, `P10.result.md`.
**Status:** SCOPE EXTRACTION (reviewed) — awaiting governance decisions GQ1–GQ5 (rev) before contract drafting.

## 1. Scope (DID §11 P11 五关键词 + 前向引用)

```text
worktree/resource isolation      （P4 minimal sandbox → P11 advanced；GitWorktree 生命周期）
external change detection        （drift：外部修改 → Resource Change 映射）
impact analysis                  （EnvironmentChanged → 受影响 Workspace/Work 判定）
environment snapshots            （snapshot 内容契约 + revision 关系）
version invalidation             （environment 变化后旧 verdict/ownership 的失效规则）
RecordEnvironmentChange / EnvironmentChanged  （P11 拥有命令+事件+wake 生产）
```

明确不在 P11：P2 wake 机器/durable wait（消费方）、P8 verdict 绑定规则（已冻结消费面）、P12 transport/resolver、P4 已冻结 minimal 工具契约文本。

## 2. Classification

### A. Upstream design defects / ambiguities（需治理裁决）

| # | 事项 | 证据 | 处置建议 |
|---|---|---|---|
| UD-1 | **worktree 生命周期零冻结**：无命令/事件/truth table/DDL；`GitWorktree(path)` payload 字段未定义；SD §11.3 仅冻结两模式名（Shared Repository / Isolated Worktree）与"不自动复制"原则；RetireWorkspace 后 worktree 清理无表述 | DID:730/735/754; SD §11.3; P4/08:89 | **GQ1**：裁决 worktree 生命周期形状（建议：命令族 CreateWorktree/RetireWorktree + 事件 + state 表 + RetireWorkspace 交互——P11 契约冻结） |
| UD-2 | **external drift 检测机制零定义**：SD §11.5 只冻结后果链；谁检测（polling/watch/手动上报）、变化→Resource Change 映射粒度、检测器 authority 均空白 | SD §11.5; P4/08:90 | **GQ2**：裁决检测模式（建议：v1 = 手动/显式触发的 snapshot-diff 检测 + RecordEnvironmentChange 提交面；持续 watch 留 P12/部署面） |
| UD-3 | **RecordEnvironmentChange payload/authority 未定义**：§12.10 明示 "payload/signature 仍在 Phase 前冻结"；EnvironmentChanged 事件空壳 | DID:4134/1690 | **GQ3**：裁决 payload（建议：{projectId, fromRevision, toRevision, changeKind, affectedRegions, summaryRef}）+ authority（System 检测器/human 显式） |
| UD-4 | **version invalidation 只有词**：environment 变化后旧 verdict 是否失效（自动降级/stale 标记/强制 re-verify 判定式）无任何规则；P8 只做 Start 时绑定、无消费面 | DID:3881; SD §11.5 | **GQ4**：裁决失效模型（建议：**不自动降级**——invalidation = 派生 stale 标记 + Attention 事实 + human/parent 决定 re-verify（新 Verification identity，沿 P8 重验证语义）；与"PASS 不重新判 FAIL"一致） |
| UD-5 | **environment snapshot 内容契约缺失**：`EnvironmentSnapshotRef?` 与关键词两处即全部；snapshot 指什么/存哪/与 revision（单字符串）关系未定 | DID:1250/3880 | **GQ5**：裁决 snapshot = 内容寻址的 resolved-region 清单+探测指纹（blob 存储沿 P4 artifact 基建；revision 引用 snapshot）？还是 v1 仅 region 清单不做内容指纹 |
| UD-6 | **P4→P11 sandbox 交接无清单**：P11 扩 SandboxPort 还是新 Port；worktree 模式下 rootPath 语义；P4 四条保证（含 close-releases）哪些继承 | P4/04:50/§3 | 降级 B-7（签名不变由 P4 契约推出；仅 rootPath/metadata 语义留契约评审） |
| UD-7 | **revision 代数未裁决**：observedRevision 比较语义（P7 wake-sink 数值比较 vs hash 字符串）；ABA 回退不可见；project-global 锚 vs caller-子集指纹活锁；anchor 前进权（lazy-init 直锚旁路 RecordEnvironmentChange） | scheduler.ts:45; wake-sink.ts:49-59; P1/04:170-176; environment-local:52 | **GQ3'（合并 GQ3+GQ5）** |
| UD-8 | **ownership claim/release 写路径与 RetireWorkspace 无主**：OwnershipWriteService 零实现零调用；P4 validate-only；RetireWorkspace 被 P6 延后且 P7-P10 无人承接——B-3/B-4/B-5 前提失真 | ports/environment.ts:60-78; admission.ts:18; P6/00:62 | **GQ1(b)** |
| UD-9 | **restart recovery 接缝零承接**：worktree 重启后缺失/损坏恢复；sandbox root=mkdtemp 重启即蒸发；启动期 anchor-vs-现实 drift probe | P9/00:44; SD 10.6 步4; sandbox-local:17 | **GQ2 子问** |
| UD-10 | **Context-update 确定性消费面**：ControlBasis.environmentRevision 接线（driver 现硬编码 "env"）+ DecisionStale | DID:3138; SD No.56; freshness.ts:34; driver.ts:133 | **GQ4(b)** |

### B. P11 phase-scoped closure（契约权限内）

1. **RecordEnvironmentChange 实现**：命令 handler（P1 store.record 的显式调用方——预留缝 P1/02:162）+ 同事务 `EnvironmentChanged` 事件（payload 按 GQ3）+ wake 生产（source phase=P11：扫 WorkWait EnvironmentChanged(environmentRef, observedRevision<toRevision) 释放——P7 wake-sink 同模式）。
2. **真实 ProjectEnvironmentPort**：替换 fake-grade resolver——FileTree→真实目录 stat 探测、GitWorktree→worktree 元数据；返回 regions+observedCounter+currentFingerprint（**counter 单调、指纹内容寻址**——GQ3' 代数；project-global 范围）；counter 仅经 RecordEnvironmentChange 前进（未治理确认的漂移不阻塞 ownership 写）；ResourceResolutionStale 从此真实可触发。
3. **stale-retry 编排（前置 = GQ1(b) 裁决）**：若 ownership 写路径归 P11：接线 OwnershipWriteService 生产调用 + bounded re-resolve；若 DEFER：记录 gap，本项缩为 retry 纯函数准备。
4. **Impact analysis（确定性）**：EnvironmentChanged 事件 → 受影响判定（输入 = boundary.addresses **经 resolver 解析的 region 快照或 claims 的 resolved 快照**——overlap 在 canonical regions 上，非原始地址；round-1 修正）→ ImpactReport 派生视图 + Attention 行；"relevant Workspace update"（SD §11.5 中段）= reevaluate wake + Inbox 通知 + **ControlBasis.environmentRevision 实读接线（GQ4(b)）**（不自动 Steer——治理留人）。
5. **Worktree 生命周期**（按 GQ1 形状）：命令族+state+事件；Isolated Worktree Mode 的 region→root 物化（clone/worktree add/copy 策略 empirical）；RetireWorkspace 交互（清理=治理建议）；**restart recovery（round-1 补）**：启动 probe 检测 worktree 缺失/损坏（GQ2 子问）→ 治理确认的幂等 materialize-again；sandbox root 持久化策略声明（mkdtemp 蒸发语义是否升级——empirical）。
6. **Advanced sandbox adapter**（按 GQ6）：worktree-backed sandbox（writableRegions 真实物化 + 回写策略声明）+ sandbox-local 补齐 P4 契约已要求的 env allow-list（现状只有 cwd——欠账修复）。
7. **drift 检测 v1**（按 GQ2）：snapshot-diff 命令面（输入：上次 snapshot；输出：changedRegions + 建议 RecordEnvironmentChange 提交）——检测器不自动 bump（人工/治理确认后提交）。
8. **P8 消费面核对**：targetEnvironmentRevision 语义不变；EvidenceRecord.observedEnvironmentRevision 不变；invalidation 呈现归 P10 Attention 面（P10 result 已确认 Environment untouched）。

### C. Implementation / empirical choice（任务级）

clone vs worktree-add vs copy 的物化策略；探测粒度（mtime/hash/大小阈值）；watch 库选择（若 P12 需要）；sandbox 进程/内存限制参数；impact report 缓存；drift diff 的路径过滤（.git/node_modules）；回写策略（merge/rebase 归 Parent integration——SD §11.4）。

## 3. True governance questions（round-1 独立审查修订版：5 项）

- **GQ1（UD-1+UD-8）worktree 生命周期 + ownership 写路径归属**：(a) worktree 形状：命令族 CreateWorktree/RetireWorktree + 事件 + worktrees state + GitWorktree payload `{path, repositoryRef?, branch?}` + RetireWorkspace 交互（清理=治理建议，不自动删）；SD 两模式为配置语义。(b) **claim/release 写路径与 RetireWorkspace 的 phase 归属**：OwnershipWriteService 生产接线 + claim/release governance 命令族——P11 承接，还是显式 DEFER（记入 gap 文件，P12/治理再裁）？
- **GQ2（UD-2+UD-9）drift 检测 + restart 接缝**：v1 = 显式触发 snapshot-diff 命令面（治理确认后 RecordEnvironmentChange；持续 watch 留 P12）；**启动恢复追加 drift probe**（沿 P9 startup recovery 钩子：anchor-vs-现实探测→diff 报告→治理确认）——确认？
- **GQ3'（UD-3+UD-5+UD-7 合并）revision 代数 + snapshot + payload**：**单调 change counter（string 编码，per-project）与内容指纹分离**——observedRevision/fromRevision/toRevision 一律为 counter（有序，wake 比较=counter 前进，ABA 由 counter 免疫）；resolver 返回 regions+observedCounter+currentFingerprint；**anchor 前进仅经 RecordEnvironmentChange**（lazy-init 保留为初始锚、不发事件不 wake）；snapshot = 内容寻址 blob（region 清单+指纹），counter 引用 snapshot；payload 含 fromCounter/toCounter/changeKind/affectedRegions/snapshotRef/summaryRef（LazyInit 是否入 changeKind 待裁）；authority = System handler / human 显式——确认此代数？
- **GQ4（UD-4+UD-10）invalidation + Context-update**：(a) 不自动降级/不自动 re-verify：stale 标记派生视图 + Attention 行 + human/parent 决定（与 "PASS 永不重判 FAIL" 一致）。(b) **确定性消费面接线**：ControlBasis.environmentRevision 从 EnvironmentRevisionStore.current 实读（替换 driver 硬编码 "env"）+ DecisionStale 生效——P11 接线还是显式延期？
- **GQ5（新增，wake 作用域）**：EnvironmentChanged wake 为 project-global counter 前进——region 无关变化也推进 observedRevision（假唤醒+区域特定唤醒丢失的张力）：接受 P7 reevaluation 吸收（wait 条件不按 region 过滤，reevaluate 幂等），还是扩展 wake 条件为 region-scoped（改冻结 WakeCondition 形状）？建议前者（无形状变更）。

## Review record (independent gap review, round 1)

4 Blocking (2 High / 2 Medium) + material findings — all fixed above:
R1 revision algebra promoted to merged GQ3' (counter vs fingerprint separated; ABA immunity; anchor-advance right; project-global scope; wake comparison semantics); R2 ownership claim/release write path + RetireWorkspace ownership promoted to GQ1(b) (three phase-scoped premises had silently assumed it); R3 restart-recovery seam added (startup drift probe; worktree damage recovery; sandbox-root ephemerality); R4 deterministic Context-update consumer folded into GQ4(b); R5 GQ6 demoted to phase-scoped (implied by P4 frozen contract; close-releases guarantee added); R6 impact-analysis inputs corrected to resolved-region snapshots; R7 wake-scope question added as GQ5.

## 4. Status

```text
SCOPE EXTRACTION COMPLETE. No P11 contracts, planning, or implementation.
Next (after GQ1–GQ6): contracts → four-way review → Blocking=0 →
planning → implementation authorization.
```
