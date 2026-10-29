# SDO-DG-01 — Specialist Delegation Orchestration 不完整

## 状态

**CLOSED — Specialist superseded; MAC-P4 applied the accepted optional-capability stop condition**

> 本文件保留触发证据。下方早期“完善 Specialist”方向已被 MAC-DG-01 的
> “移除一级 Specialist、后置可选 runtime subagent”方向取代，不构成实施授权。
> MAC-P4 最终没有暴露一个不完整的 subagent 子系统：active handler 已移除，
> 旧 Specialist 仅保留 replay/audit compatibility。重新启用必须经过新的治理阶段并
> 一次性满足 bounded handoff、权限继承、资源冲突、mailbox 与 recovery 合同。

## 问题

Arbor 已冻结 `Workspace = long-lived responsibility`、
`Specialist = ExecutionBound temporary role`，方向正确；但当前设计与实现尚未给
Specialist 一套可以完成实际工作的运行期协作闭环。

## 触发证据

1. `packages/model-context/src/turn-profile.ts` 只为 WorkspaceWork、WorkspaceInput、
   Verifier 装载 executable tools；ExecutionBoundSpecialist 没有 executable tools；
2. 同文件的 specialist controls 只有 send-message/propose-workspace/spawn-specialist，
   不含 list/message/followup/wait-exact/interrupt；
3. 冻结 P6 `SpecialistSpec.skillIds` 未进入当前 model-facing
   `AgentAction.SpawnSpecialist`、codec 或 schema；
4. `SpecialistSettled` 只有 summary，并且只进入 Parent Workspace Inbox；没有 exact
   parent Execution mailbox 或 structured artifact/evidence result；
5. `WaitSpec` 只有 generic InboxAdvanced，没有绑定 specialistExecutionId 的等待条件；
6. P2 不设 specialist 并发上限，当前没有 parent/project/depth/resource-conflict 的完整
   Runtime policy。

详细对照：
`planning/codex-subagent-arbor-delegation-analysis.md`。

## 为什么是 Design Gap

冻结文档声明 `ExecutionBoundSpecialist` 获得“parent-distributed subset”，但没有冻结：

- subset 的来源、默认 profile、权限和 resource ceiling；
- typed context handoff；
- live collaboration primitives；
- exact parent result delivery；
- follow-up/terminal successor 语义；
- structured result 与 Work/Verification 的边界；
- 并发、深度和 mutable resource conflict policy。

这些内容跨越 System Design、DID、P2、P3、P6、P12、P17。实现不能通过临时增加工具
或恢复 Session 直写来猜测语义。

## 已确认的非目标

- 不把 Specialist 升格为 Workspace；
- 不新增长期 AgentId；
- 不把 SpecialistResult 当作 Work Completed；
- 不让 RootConversation 直接 spawn Specialist 代替正式 Work；
- 不无条件复制 parent 的全部 Context 或工具；
- 不用 prompt 文本代替权限、资源、并发或 fencing 强制。

## 历史推荐方向（已被 MAC-DG-01 supersede）

1. 冻结 `SpecialistBrief`：mission、expectedResult、constraints、contextRefs、toolProfile、
   skillIds；Runtime 绑定 parent Work/Workspace/revision/provenance；
2. 冻结 tool subset 公式：parent visible ∩ requested profile ∩ resource/permission/policy ∩
   safety；
3. 增加 scoped collaboration controls：list、message、followup、interrupt，以及 exact
   SpecialistChanged wait condition；
4. 增加 durable parent ExecutionMailbox；active/waiting parent 精确接收，parent terminal
   时 fallback Workspace Inbox；继续禁止直接写 Parent Session；
5. 冻结 `SpecialistResult`：typed status、summary、artifact/evidence refs、unresolved
   questions、settlement fingerprint；
6. terminal specialist 不复活；follow-up 创建显式 successor ExecutionBound；
7. 冻结 parent/project concurrency、delegation depth、mutable resource conflict 和
   quiescence policy；
8. real-provider 场景必须证明 Specialist 能使用受限 executable tools 完成真实子任务，
   parent 能精确等待、接收、追问、中断并整合结果。

## 对其他工作的影响

- `RGI-DG-01` 的 Workspace placement 语义仍成立；
- 当前不宣称 subagent/multi-agent 性能收益；
- RootConversation 与 WorkEpisode 都不获得 `spawn_specialist`；单 Agent 正确性不依赖
  临时并行能力。

## Owning contracts

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P2/**
docs/design/implementation/P3/**
docs/design/implementation/P6/01-formation-semantics.md
docs/design/implementation/P6/03-authority-delegation.md
docs/design/implementation/P6/06-acceptance.md
docs/design/implementation/P12/**
docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md
docs/design/implementation/P17-conversation-delivery-runtime/07-acceptance.md
```
