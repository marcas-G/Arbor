# P13 — 02 Command → UI Exposure Policy Matrix

**Owns:** wire 级 commandType 的 UI 暴露分类与约束
**Does not own:** 命令的 authority / handler 语义（domain/application/P2–P12）

## 1. Policy（frozen）

每个 wire 级 commandType 归入四类之一，**分类只约束 UI 主动暴露，不改变
服务器对任意 envelope 的接收与裁决**（Authority Resolver 仍是唯一
enforcement；`02` 分类不是权限系统）：

| 类别 | 定义 | UI 政策 |
|---|---|---|
| **Human-actionable** | 冻结语义中属于 human/external governance surface 的操作 | P13 v1 唯一可主动暴露（表单/按钮 + envelope 构造） |
| **System-internal** | Application consumer / runtime / scheduler 拥有的决策与执行 | 不暴露；UI 只呈现其结果（view 数据） |
| **Agent-originated** | agent / parent-agent 在执行与协调中发起的操作 | 不暴露；UI 只呈现其结果 |
| **Recovery-only** | recovery / ops 通道专用 | 不暴露；CLI/ops 面拥有 |

## 2. Matrix（wire 级 commandType 全集）

来源：`packages/application/src/commands/**` 注册表 + P2 runtime 路径。

### Human-actionable（v1 暴露，7）

| commandType | 冻结依据 | UI 形态 |
|---|---|---|
| `CreateProject` | P1 bootstrap（DID §4.1 CreateProject single-transaction） | 引导表单（项目名/根责任定义） |
| `RecordDecision` | P6 D1 第一层 formation human gate：`RequestGovernance(FormationApproval)` + `RecordDecision` 绑定 exact proposal revision | 决策表单：对 pending FormationProposal / governance proposal 记录 Approve/Reject/Adjust，必须绑定 proposal revision |
| `SteerWork` | P6 `04` human steer（普通/Critical；quiescence 集成） | 纠偏表单（work 目标 + steer 文本；Critical 需显式确认） |
| `AcceptWorkOutcome` | S1 Parent 接收；human-as-root-parent 路径 | 验收表单：对 root 直接子 workspace 的 delivered outcome 记录接受/拒绝 |
| `StopExecution`（external Human/Parent Stop 路径） | P12 `02` §4 External Human/Parent Stop（resolver 产出 `submissionOrigin:"External"` 的 VerifiedRuntimeCommandAuthority）；DID v1.13 G4/G7（human-originated canonical command 路径，发射 HumanInterventionApplied）；S2 §6 用户明确要求立即停止 | 紧急停止控件：workspace-detail 的 activeExecution 卡上"停止该执行"，需显式确认（§6 U-3） |
| `GrantPermission` | P12 `02` §5 PermissionGrant governance（唯一 durable writer） | admin 表单（principal、commandType scope、边界） |
| `RevokePermission` | 同上 | admin 表单（选择现存 grant） |

### System-internal（不暴露，10）

| commandType | 拥有者 | 说明 |
|---|---|---|
| `SelectCurrentWork` | scheduler evaluator（P5 `01` §3.1） | **§4 特殊约束**；UI 只呈现 current/runnable/selection 状态 |
| `CreateChildWorkspace` | Application consumer（P6 D1：RecordDecision 只产 governance fact，consumer 幂等执行） | formation 结果的确定性执行 |
| `CompleteWork` | P8 completion consumer loop | Work 终态转换 |
| `ConcludeVerification` | P8 verification consumer loop | Verification 终结 |
| `RegisterProjectTool` | P12 `01` project-tool 注册（content/version-bound trust） | config/ops 面 |
| `CreateWorktree` / `RetireWorktree` | P11 worktree lifecycle | sandbox 运行时 |
| `AdmitExecution`（runtime-origin 路径） | P2 runtime authority（VerifiedRuntimeCommandAuthority） | scheduler/runtime 通道；external 路径见 §6 U-3 |
| `StopExecution`（runtime-origin 路径） | P2 runtime authority | 同上；external Human/Parent 路径见 §2 Human-actionable 与 §6 U-3 |
| `SettleExecution` | P2 settlement / recovery | 运行时通道 |

### Agent-originated（不暴露，11）

| commandType | 拥有者 | 说明 |
|---|---|---|
| `AssignWork` | parent agent（含 Main） | 第一层划分经 formation gate，不走 UI 直发 |
| `SendMessage` | P6 `02` communication protocol | **§5 特殊约束**；agent↔agent 通道 |
| `ProduceDeliverable` | P7 deliver primitive（producer） | 执行期产出 |
| `DeclareDependency` / `ReviseDependencyContract` / `SatisfyDependency` / `WithdrawDependency` / `MarkDependencyUnfulfillable` | P6/P7 dependency coordination | agent/parent 协调 |
| `StartVerification` / `RecordVerificationEvidence` | P8 verifier（ExecutionBound） | 验证执行 |
| `AcceptWorkOutcome`（agent-parent 路径） | parent agent 对非 root 链子树 | 同一 commandType 双起源；**UI 只允许 human-as-root-parent 路径**（§6 U-1） |

### Recovery-only（0 个新增)

Recovery / ops 通道（如 recovery settlement）不经过外部 command registry；
若未来出现 wire 级 recovery commandType，归此类，P13 不暴露。

## 3. Envelope 构造规则（Human-actionable 表单）

1. `commandType` ∈ §2 Human-actionable 集合（UI 内置 catalog，机械校验）；
2. `commandId`：client 生成，格式 `cmd_<uuid-v7>`（DID Appendix A ID 词表），
   提交前不可变；网络失败重试必须**复用同一 commandId**（服务器幂等）；
3. `projectId` / `actor` / `issuedAt`：按 `01` §4；
4. `payload`：仅由表单字段构造；不嵌入 server 未要求的字段。

## 4. 特殊约束：`SelectCurrentWork`

**不得做成普通人工选择控件。** 冻结语义（P5 `01` §3.1）：selection
decision 属 scheduler evaluator；`SelectCurrentWork` handler 只应用 evaluator
给出的 exact workId。

- UI 允许：呈现 current work、runnable 集合、selection 依据（view 数据）；
- UI 禁止：任何"选这个"按钮 / runnable 列表上的可点击选择语义 /
  以选择为目的构造 `SelectCurrentWork` envelope；
- human force-select 若未来需要：**单独治理语义闭合**（新 GQ），不得滥用
  该内部 command。

## 5. 特殊约束：`SendMessage`

- P13 **不得**把 `SendMessage` 解释成 "human → Main Agent chat" 并实现对话面
  ——该端到端语义未冻结，chat-first 属 P14+；
- P13 v1 的 UI 中 `SendMessage` 不出现在任何 Human-actionable 表单/控件中。

## 6. 双起源命令与升级规则

- **U-1（`AcceptWorkOutcome`）**：commandType 同一、authority 因 principal
  而异。UI 只在"认证主体即目标 workspace 的 root-parent"场景提供表单；
  其余场景（agent-parent）的提交不因 UI 缺席而受影响（服务器行为不变）。
- **U-2（矩阵演进）**：类别变更 = governance 变更（新 GQ / DID 版本），
  P13 实施与后续 phase 不得自行改类、不得为 UI 便利放宽暴露面。
- **U-3（`StopExecution` / `AdmitExecution` external 路径）**：P12 `02` §4
  冻结了 External Human/Parent 起源（resolver 产出
  `submissionOrigin:"External"` 的 VerifiedRuntimeCommandAuthority），二者
  的 external 路径**属于 human/external governance surface**，与
  runtime-origin 路径同 type 不同起源：
  - `StopExecution` external Human/Parent Stop：**v1 暴露**（S2 §6 用户
    紧急停止；UI 形态见 §2 Human-actionable 表）；payload 目标为当前
    呈现的 executionId，不提供跨 workspace 批量停止。
  - `AdmitExecution` external 路径：**v1 不暴露**（显式 governance-scoped
    deferral）：主执行发起与"用户启动/恢复对话工作流"耦合，属 P14 chat
    面语义；单独暴露裸"启动执行"按钮缺乏冻结的端到端语义。
  - 服务器对两条 external 路径的接收与裁决不因 UI 暴露策略而变。

## 7. Must Not Decide

- 不决定 authority 规则 / grant 内容（server 唯一 enforcement）；
- 不决定 `SelectCurrentWork` / `SendMessage` 的语义演进；
- 不决定 System-internal / Agent-originated 命令的任何 UI 直发形态。

## 8. Verification

`06` EC-6（UI command catalog 机械测试：暴露集合 == §2 Human-actionable 七项）、
EC-7（无 SelectCurrentWork 人工选择控件）、EC-8（无 SendMessage chat 控件）。
