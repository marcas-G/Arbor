# P6 — 04 Human Steer

**Authority:** SD v1.3 §7.3（governance primitives + quiescence）, §8.1; S2 全部（尤 §3–§7）; DID v1.9 §4.2, §12.10 表（SteerWork→WorkSteered）, §2.3（WorkRevision）, §3.4（quiescence）, §8.13; P2 `01` §6（StopExecution）.
**Status:** FROZEN (manual governance adoption).

## 1. Steer 语义总览（S2 直译）

```text
普通纠错（Normal Steer）   →  不抢占；进入 Inbox；下次执行自然吸收
Critical Steer            →  立即 quiescence（SD §7.3 强中断路径）
立即停止（Stop）           →  StopExecution（P2 拥有，P6 只是调用方）
```

S2 §6：用户的纠错不是默认硬抢占；只有明确的立即停止或高风险 Critical Steer 才进入强中断路径。
S2 §5/§7：Agent 在已有工作脉络上吸收纠错，不从头开始；纠错后恢复自治。

## 2. `SteerWork` command handler（P6 实现）

DID §12.10 表行：`RefineWork / semantic SteerWork → WorkRefined / WorkSteered`，precondition = authority + revision，效果 = `Open, revision++`（P6 实现 SteerWork 侧；RefineWork 属 producer 自 refine，同一 revision 通道，由同一 handler 家族承载）。

### Payload

```ts
{
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly steer: {
    readonly severity: "Normal" | "Critical";
    readonly guidance: ContentRef;              // 纠错内容，bounded view 进 Context
    readonly scope?: "Direction" | "Constraint"; // 信息性
  };
  readonly expectedWorkRevision: WorkRevision;   // optimistic precondition
  readonly provenance: Provenance;               // HumanInput 来源标记
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| work not found / 不属于 workspace | `CommandRejection.WorkNotFound`（**P6 冻结新增枚举**，P1 未定义） |
| work lifecycle != Open | `DomainError.TerminalLifecycleMutation` |
| authority 无 steer 权（R1–R3 结构判定 + Human） | `DomainError.AuthorityDenied` |
| `work.revision != expectedWorkRevision` | `DomainError.RevisionConflict` |
| producer 不能弱化受保护的 upstream 需求（DID §12.10 表注） | `DomainError.AuthorityDenied` |

### Events

```text
WorkSteered { workId, fromRevision, toRevision, severity }
```

- semantic steer 递增 `WorkRevision`（DID §2.3）；下游 `Deliverable/Verification/Acceptance` 的 revision 绑定语义由 P7/P8 使用，P6 只保证 revision 单调事实。

## 3. HumanInput 通道

- Human steer 输入是 `AuthenticatedHuman` provenance 的 Message（DID §8.4A），进入目标 Workspace Inbox（02 §4 Admission：验证来源、authority、结构）。
- `Normal` steer：promotion 仅触发 runnable reevaluation；吸收由 Agent consumption 完成（S2 §5"先理解再纠错"由认知侧保证，不由 runtime 强制中断）。
- 局部纠错不需要从 Root 重新描述整个项目（S2 §5）：steer 目标精确到 Workspace/Work，不广播。

## 4. Critical Steer / Stop 的 quiescence 集成

SD §7.3 冻结语义的 P6 接线（机制 P2 拥有，P6 是发起方）：

```text
Critical Steer 提交
  = 同一可靠提交边界内：
    1) SteerWork(severity=Critical)   → WorkSteered（治理事实）
    2) StopExecution(当前 active main) → 禁止新 ProviderTurn / ToolInvocation /
       Execution-originated canonical Command / Specialist spawn
  ↓
in-flight 副作用按 SideEffectSemantics cancel/confirm/reconcile（P4）
无法确认 → Execution 只能 OutcomeUnknown(ReconciliationRequired)（P2）
  ↓
Work 保持 Open；纠错内容已在 Inbox；下次 admission 的 bootstrap Context
按 DID §8.13 Control Reinjection 从 Canonical State 重注入（Steer 属 Constraints/Current Work 面）
```

- `CancelWork` 与 Stop 分离（SD §7.3）：P6 的 steer 永不隐式 Cancel Work。
- Safety Envelope 触发的中断是另一通道（SD §7.7），不与 human steer 混用 Attention 归因。

## 5. S2 行为验收要点（供 06 引用）

```text
- 用户可对树上任意 Workspace 的 Open Work 发 Normal Steer，不产生执行中断
- Normal Steer 后的下一次 Execution Context 含 guidance（bounded）
- Critical Steer：当前 active main 进入 quiescence，WorkSteered + Execution 不再新增动作
- 纠错后恢复自治：无需人工重启 Work；reevaluation 自行再admission
- Sibling/Child 不能 steer（R3 权限拒绝，typed rejection 可测）
```

## 6. Must Not Decide

- No `CancelWork` / `CompleteWork` 语义（前者后续阶段接线，后者 P8）。
- No StopExecution/quiescence 机制本体（P2 拥有；P6 只规定发起时序与同一提交边界要求）。
- No Critical 判定自动化（severity 由 human 显式声明；runtime 不做语义升级/降级）。
- No steer 历史/审计 UI（P10 projection）。
