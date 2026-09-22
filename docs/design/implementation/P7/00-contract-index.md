# P7 — 00 Contract Index

**Authority:** DID v1.10 §1.8, §4.2, §5.3, §5.4, §7.1, §8.15, §8.16, §8.18, §8.18A, §11 P7, §12.8, §12.10, §12.11; 治理裁决 v1.7 G3 / v1.9 G2 / v1.10 G1–G6; SD v1.3 §3.7/§3.8, §5.2, §7.2/§7.5/§7.6, §14 No.20/42/49/53/55; S1 步骤 10–11, S3 步骤 3/4/12/14; P2 `02`/`05`, P5 `02`/`03`, P6 `00`–`06`; `planning/results/P6.result.md`.
**Status:** FROZEN (first draft for contract review) — governs against DID v1.10 (2026-09-21, GQ1–GQ7 decisions).

## Documents

| Doc | Owns |
|---|---|
| `01-dependency-deliverable-commands.md` | 六命令（Declare/Produce/Satisfy/Withdraw/Mark/Revise）载荷、拒绝表、事件、authority facts（含 exact-bound SatisfyDependencyAuthority，G6） |
| `02-deliver-primitive.md` | Deliver 独立 communication/orchestration primitive（G2）：Message 五 kind、directive、ChildDelivered wake、Deliver≠satisfaction |
| `03-runnability-classification.md` | classify 单权威（G3）：blocking 判定、P5 inherited evolution 对齐、§8.18A 呈现输入等价性 |
| `04-coordinator-satisfaction.md` | event-driven P7 coordinator（G5）：触发集、candidate lookup 契约接口（形态不冻结）、单命令面、失败语义 |
| `05-wait-graph-deadlock.md` | Wait-for graph、确定性 cycle 检测、DeadlockAttentionRequested（G4，零自动 mutation） |
| `06-wake-integration.md` | DependencyChanged/ChildDelivered wake 生产（同一提交边界）、消费管线补齐、P2 职责三分落位 |
| `07-acceptance.md` | 验收故事 A–F 与机械断言清单 |

## Scope (DID v1.10 §11 P7)

```text
DeclareDependency / WithdrawDependency / MarkDependencyUnfulfillable / ReviseDependencyContract
ProduceDeliverable / Deliver (primitive) / SatisfyDependency (single command face)
Wait-for Graph / Deadlock Attention (fact event, no auto mutation)
automatic runnable reevaluation (classification is the single authority)
event-driven P7 coordinator (AnyProducer auto-satisfaction)
supersedes the P5 provisional RunnableWorkSource (port unchanged)
```

- 采纳后 P5 `03` §2 表中最后一个 `DirectiveUnsupported`（`DeclareDependency`）消失；P7 起 `04` 也承接 `ProduceDeliverable`/`Deliver`/`SatisfyDependency` directives（v1.10 G2/G6）。

## DID v1.10 governance inputs mapping

| Input | 落点 |
|---|---|
| G1（三命令正式化 + DependencyContractRevised） | `01` §5 |
| G2（Deliver primitive / 五 kind / ChildDelivered / 正交性） | `02` 全文、`06` §2 |
| G3（classification 单权威 / blocking 定义 / inherited evolution） | `03` 全文 |
| G4（DeadlockAttentionRequested / 零自动 mutation） | `05` §2 |
| G5（event-driven coordinator / lookup 不冻结） | `04` 全文 |
| G6（exact-bound SatisfyDependencyAuthority / 单命令面） | `01` §4、`04` §5 |
| §1.8 matcher/状态机（P0 冻结实现） | `01` 引用不重定义 |

## Implementation baseline（P6 result 移交 + 提案盘点）

可复用：domain dependency.ts 全集、WakeCondition.DependencyChanged / WakeReason（含 ChildDelivered）、RunnableWorkSource port + SQLite、P5 provisional 实现（inherited evolution 对象）、§8.18A 决策表。

空壳待实现（P7 任务）：5+2 事件载荷（含空壳锁死测试更新）、DependencyRepository/DeliverableRepository + DDL（migration id 6）、四 directive handlers、classify 扩查询（work_waits × dependencies）、coordinator 消费管线、wake 消费侧路由、composition 升级 P7_MIGRATIONS（顺带修 P6 遗留 P4_MIGRATIONS 缺陷）。

## Boundaries (explicitly out of P7)

- Verification / Acceptance / `CompleteWork`（P8；satisfaction 与质量正交——v1.10 G2）。
- WorkWait/timer 机器与 lost-wake-up 防护（P2）。
- Message/Inbox 语义修改（P6；Deliver 是 v1.10 授权的 kind 扩张，InboxEntry 枚举不扩）。
- Attention 呈现/UI（P10）。
- Environment/git（P11）；生产 surface（P12）。

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | task → DID v1.10 / SD / P2/P5/P6 traceability | PASS after fixes: R1 `06` GQ-residue removed (ChildDelivered wired per v1.10 G2); R2 `05`/`06` header numbering + cross-refs corrected; R3 wake payload lives in the signal delivery record, not the P2-frozen WakeReason union; R4 `01` §2 enum provenance corrected (P6 `04` §2) |
| Dependency / coverage | 六命令 + primitive + classify + coordinator + deadlock + wake 全覆盖 | PASS: every DID §11 P7 v1.10 keyword has a unique owning doc; `01` §4 / `04` §5 single-command-face statements consistent |
| Executability | Stories A–F 机械可查 | PASS after fixes: R5 `01` §9 ProduceDeliverableSpec gains deterministic `sourceWorkId`; R6 `05` WorkspaceBound fan-out (no synthetic sink node), Project-scoped "no runnable" (No.42), liveness re-check set includes DependencyDeclared + WorkWait upsert (declare-then-yield cycles are caught at the second upsert) |
| Risk / gaps | 新增冻结面与 v1.10 裁决一致性 | PASS: all new frozen surfaces trace to v1.10 G1–G6 or §5.3; Message-kind expansion is v1.10-authorized, P6 InboxEntry enumeration unchanged; no contract-invented semantics |

Review round 1 (independent): 5 Blocking (2 HIGH / 3 MEDIUM) + 2 LOW — all fixed above.
Review round 2 (targeted, after governance B-2/B-4 amendments): 4 Blocking —
R7 valid-edge/cycle-membership now cite the `03` §3 formula (Unsatisfied conjunct;
ghost-edge window closed); R8 no-runnable gate is the Project-quantified Idle
condition (No.20 form); R9 producer-set changes cover growth (WorkAssigned) and
retirement rationale corrected to defensive backstop; R10 zero-candidate branch
states the honest sub-cases and files the vacant-workspace attention hole as
`planning/gaps/P7-GAP-01.md`; Story E extended with B-2/B-4 regressions.
**Blocking = 0.**

## Status

```text
FROZEN — P7 phase-scoped contracts; review Blocking = 0 (P7 FORMALLY CLOSED).
confirmation, this directory freezes and planning/phases/P7.md may be authored.
```
