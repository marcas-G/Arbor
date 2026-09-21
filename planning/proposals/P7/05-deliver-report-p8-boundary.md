# P7 — 05 Deliver vs Report; P8 Boundary (PROPOSAL)

**Authority:** SD v1.3 §7.2:753, §10:1120-1121, §3.7:322, §3.8; DID v1.9 §11 P7/P8, v1.9 G4; P6 `02` §1（D2 负定义）; S1 步骤 10-11; `planning/results/P6.result.md`。
**Status:** DESIGN CLOSURE DRAFT（GQ2/GQ5 待裁决）。

## 1. 三通道正交（冻结重申）

```text
Report  (P6 Message kind) = 认知性向上暴露；不能满足任何 Dependency（P6 D2）
Deliverable (P7 实体)     = 正式结果，绑定 sourceWorkRevision，immutable
Deliver (SD §7.2 原语)    = Child→Parent 正式交付行为 —— GQ2 裁决落点
```

## 2. GQ2 提案：Deliver = 组合行为原语（方案 b，推荐）

```text
Deliver(child→parent) ≡ ProduceDeliverable(sourceWorkRevision 绑定)
                      + Coordination Consumer 自动满足匹配 Dependency（`02` §2）
                      + parent Workspace Inbox 通知（kind: Deliverable，
                        entryKey=deliverableId —— 沿 P6 Inbox upsert 语义）
```

- 不新增 DID 命令/事件（`DeliverableProduced` 一个事实承担）；S1 步骤 10"交付"的用户可感知行为由组合完整承担。
- 备选方案 a（独立 `Deliver` 命令）：优点是投递意图显式（child 可指明目标 parent 消费语境），代价是 DID 命令集扩容且与自动满足路径重叠（同一 deliverable 两套入口）。推荐 b，除非治理认为"定向投递"需要独立 authority/审计面。

## 3. P8 边界（GQ5 正交性）

```text
P7: structural satisfaction（三条件 matcher；不看质量）
P8: Verification（质量，PASS/FAIL/UNKNOWN）→ Parent Acceptance → CompleteWork
```

- structural match 即 `Satisfied`，即使 Deliverable 未经 Verification——质量门在 P8 的 Verification/Acceptance 链（SD:322；G4 裁决 P5 只 settle Execution 的延续）。
- Consumer 对"结果虽匹配但仍不足以支撑上层 Work"的判断 = 新 Work/Dependency/Steer（认知侧），不改 satisfaction 事实（DID:2868）。
- `Verification.targetDeliverables`（verification.ts:40 已有字段）由 P8 消费；P7 只保证 Deliverable 的 revision 绑定可追溯（No.49）。

## 4. Must Not Decide

- No Verification/Acceptance/CompleteWork（P8）。
- No Report→satisfaction 映射（P6 D2 禁令延续）。
- No Message/Inbox 语义修改（P6）。
- No Deliver 独立命令（除非 GQ2 裁决方案 a）。
