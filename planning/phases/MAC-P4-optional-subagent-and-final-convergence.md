# MAC-P4 — Optional Runtime Subagent and Final Convergence

## Authority and status

- Proposed authority: `planning/proposals/minimal-architecture-convergence-decision-draft.md`
- Depends on: MAC-P1, MAC-P2 and MAC-P3 FORMALLY CLOSED.
- Product release does **not** require this phase unless parallel model execution is an explicit
  release requirement.
- If executed as final MAC closure, it also owns legacy isolation and physical approval-ledger
  convergence after MAC-P1…P3 semantics are stable.

```text
Planning:        FROZEN / COMPLETE
Design:          ACCEPTED / LANDED
Implementation:  COMPLETE / FORMALLY CLOSED (optional capability disabled)
Entry gate:      SATISFIED — MAC-P3 FORMALLY CLOSED + user objective authorized all four phases
Disposition:     STOP CONDITION APPLIED — no proven v1 benefit justifies the collaboration subsystem
Result:          planning/results/MAC-P4.result.md
```

The accepted stop condition was applied during implementation. Arbor v1 does
not advertise or register a subagent action. MAC4-002…007 therefore remain
absent rather than landing a partially safe collaboration subsystem;
MAC4-001/008/009 close legacy isolation, the unified ActionApproval ledger,
disabled-mode equivalence and final qualification. Historical Specialist
fixtures remain replay/audit compatibility only.

## Goal

Add Codex-like temporary parallel Agent execution as an Agent Runtime optimization without creating
a fifth product/domain concept:

```text
WorkEpisode Main Agent
→ spawn_agent(brief)
→ child Execution(s)
→ list/message/wait/interrupt
→ typed AgentResult
→ Main Agent integrates result
```

Correctness must remain identical when subagent capability is disabled.

## Naming and ownership

New product/domain writes contain no `Specialist` entity:

```text
Model tool       spawn_agent
Runtime record   child Execution with explicit Subagent purpose
Addressing       scoped opaque agentRef bound to ExecutionId/revision
Result           AgentResult
```

Historical `SpecialistSpec`, `SpecialistSettled` and `spawn_specialist` are migration/replay aliases
only after convergence. No AgentId is introduced.

Verifier remains a deterministic Verification role, not a user-spawned subagent. A subagent result
is not CompletionClaim, Verification or Acceptance.

## Scope

### Included

- typed SubagentBrief and AgentResult;
- explicit Execution purpose/binding for subagent vs verifier;
- constrained executable-tool inheritance;
- spawn/list/message/wait/interrupt/follow-up runtime actions;
- durable parent Execution mailbox and terminal-parent fallback;
- concurrency/depth/no-progress/resource-conflict safety;
- CAPA/Permission/ResourceBoundary integration;
- terminal successor semantics for follow-up;
- restart/replay/fencing and real-provider parallel scenarios;
- removal of new-write Specialist paths;
- final active-runtime legacy isolation;
- physical exact-intent ActionApproval convergence if separately accepted.

### Excluded

- durable Responsibility or Workspace creation;
- formal Work assignment to subagent;
- independent acceptance/verification of AgentResult;
- automatic branch/worktree creation solely because an agent was spawned;
- unlimited context fork or unfiltered parent transcript;
- sibling free-chat;
- model-defined permissions, concurrency or resource ownership;
- requirement that every task use multiple agents.

## SubagentBrief

```ts
interface SubagentBrief {
  readonly mission: string;
  readonly expectedResult: string;
  readonly constraints: ReadonlyArray<string>;
  readonly contextRefs: ReadonlyArray<ScopedContextRef>;
  readonly requestedToolProfile: "ReadOnly" | "Test" | "EditBounded";
  readonly skillRefs: ReadonlyArray<string>;
}
```

Runtime adds trusted parent facts:

```text
project/workspace/work/revision
parentExecutionId
resource/capability/control-basis snapshots
provenance and delegation depth
```

No raw `fork all history`. ContextProjector resolves only accepted scoped refs plus exact Work and
Workspace control facts.

## Tool inheritance

```text
SubagentVisibleActions
  = ParentVisibleActions
    ∩ requestedToolProfile
    ∩ ResourceBoundary
    ∩ Permission/Project/Workspace policy
    ∩ Resource conflict policy
    ∩ Runtime safety envelope
```

- default profile is ReadOnly;
- Test may run bounded non-production commands;
- EditBounded requires exact regions and authorization;
- child cannot gain tools/capabilities unavailable to parent;
- executable visibility and invocation authorization are rechecked independently.

## Runtime actions

```text
spawn_agent(brief)
list_agents()
message_agent(agentRef, body)
followup_agent(agentRef, briefDelta)
interrupt_agent(agentRef, reason)
wait({ AgentChanged exact refs })
```

User-facing/provider names may use `agent`; internal stable IDs remain versioned action identities.

Lifecycle:

- Active/Waiting child may receive message;
- Waiting child may resume on follow-up;
- terminal Execution never reopens;
- follow-up to terminal child creates successor Execution referencing prior AgentResult/context;
- interrupt submits StopExecution and follows quiescence/reconciliation;
- list is a projection and never becomes authority.

## Result delivery

```ts
interface AgentResult {
  readonly status: "Succeeded" | "Failed" | "Interrupted" | "Unknown";
  readonly summary: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly unresolvedQuestions: ReadonlyArray<string>;
  readonly settlementFingerprint: string;
}
```

Delivery path:

```text
child settlement/result
→ durable parent ExecutionMailbox
→ exact wake of active/waiting parent
→ typed next-turn input with provenance
→ parent terminal: fallback to owning Workspace Inbox
```

Direct Parent Session writes remain forbidden. Mailbox consumption and Context inclusion commit with
durable source receipts.

## Concurrency and resource safety

Policy inputs—not universal hardcoded values—define:

- max active subagents per parent/project;
- max delegation depth;
- max total spawned descendants per WorkEpisode;
- no-progress/action repair budget;
- model/token/tool usage safety;
- compatible concurrent read regions;
- disjoint edit regions;
- exclusive shell/environment effects;
- behavior when an external effect is OutcomeUnknown.

When concurrent mutation safety cannot be proven, Runtime denies/serializes or requires exact
approval. Prompt advice is not enforcement.

## Dependency graph

```text
MAC4-001 Remove first-class Specialist vocabulary from new contracts
   ├─ MAC4-002 SubagentBrief/context projection
   ├─ MAC4-003 Explicit child Execution purpose/lifecycle
   └─ MAC4-004 Tool subset + authorization policy

MAC4-002 + MAC4-003 + MAC4-004
   └─ MAC4-005 spawn/list/message/followup/interrupt

MAC4-003 + MAC4-005
   └─ MAC4-006 ExecutionMailbox + AgentResult + exact wait

MAC4-001..006
   └─ MAC4-007 concurrency/resource/fencing/recovery qualification

MAC-P1..P4 semantic closure
   └─ MAC4-008 legacy isolation + ActionApproval physical convergence

MAC4-001..008
   └─ MAC4-009 final real-provider/disabled-capability/phase closure
```

## Task contracts

| ID | Deliverable | Required proof |
|---|---|---|
| MAC4-001 | no new-write Specialist vocabulary | compatibility decoder replay-only; responsibility tree unchanged |
| MAC4-002 | bounded typed handoff | no transcript fork; provenance and context-ref authorization |
| MAC4-003 | explicit subagent Execution purpose | verifier cannot be misclassified; terminal immutability |
| MAC4-004 | least-privilege action subset | child ⊆ parent; boundary/policy/conflict negative tests |
| MAC4-005 | collaboration controls | scoped refs, exact authority, stale/foreign ref rejection |
| MAC4-006 | structured result/mailbox/wait | exact-parent delivery; dedup; terminal-parent fallback; no Session direct write |
| MAC4-007 | budgets/conflict/recovery | concurrency/depth/no-progress/fencing/restart matrix |
| MAC4-008 | active legacy isolation and shared approval ledger | migrated data readable; no new runtime branch; exact single-consumption preserved |
| MAC4-009 | optionality and final closure | feature disabled path identical; real parallel scenario; `pnpm check` |

## Test matrix

1. capability disabled: single-Agent Work behavior and results remain unchanged;
2. read-only subagent reads allowed resource and returns structured result;
3. read-only subagent cannot patch/shell beyond profile;
4. child cannot request a tool unavailable to parent;
5. EditBounded agents with disjoint regions can run concurrently;
6. overlapping write regions are denied/serialized before effect;
7. parent lists only descendants in its scoped execution tree;
8. foreign/stale agentRef fails closed;
9. message wakes exact active/waiting child once;
10. terminal follow-up creates successor, never reopens old Execution;
11. interrupt prevents new actions and reconciles in-flight side effects;
12. child result wakes exact parent and carries artifact/evidence refs;
13. parent terminal fallback creates one Workspace Inbox item;
14. duplicate child settlement/mailbox delivery is a no-op;
15. parent restart and child restart do not duplicate work/effects/results;
16. depth/concurrency/total-descendant limits are mechanically enforced;
17. nested child cannot widen capability/resource/permission;
18. subagent “Succeeded” does not claim/verify/complete parent Work;
19. verifier execution cannot receive subagent collaboration profile;
20. legacy Specialist row replays for audit but cannot create a new Specialist write.

## Approval-ledger convergence

If authorized in the accepted physical design:

- migrate executable/control pending approvals to a single ActionApproval identity space;
- preserve action route, normalized intent, target, ControlBasis, subject, expiry and state;
- revoke/fail closed any row whose binding cannot be proven;
- dual-read is migration-only; new writes switch once after a durable marker;
- no steady-state dual write;
- concurrent approval/consume still permits exactly one consumer;
- Queue/Web projection uses one approval vocabulary.

## Legacy isolation

- active new-turn code imports no legacy directive handler;
- old Session/provider evidence remains readable through archival/migration adapters;
- LegacyAmbiguous executions remain fail-closed and cannot be reconstructed from text;
- compatibility aliases are replay-only, never advertised;
- remove unneeded production Layers and source branches only after equivalent-fixture migration tests;
- preserve a recoverable DB backup before dogfood migration.

## Real-provider qualification

Run paired cases with feature enabled and disabled:

- parallel independent code/research inspection with two children;
- one child fails usefully, the other succeeds; parent integrates honestly;
- parent sends bounded follow-up based on first result;
- overlapping edit attempt is denied before mutation;
- restart during parallel calls resumes without duplicate ToolInvocation/AgentResult;
- parent completion still follows ordinary Claim → Verification → Acceptance;
- compare output quality, wall time and usage; do not claim subagent benefit without evidence.

## Exit criteria

1. Subagent is optional runtime behavior, not Workspace/Work/Plan/Product identity.
2. Disabled mode preserves MAC-P1 correctness exactly.
3. Brief, tools, messages, wait, interrupt and result are exact/ref-scoped and recoverable.
4. child capabilities/resources never exceed parent ceiling.
5. concurrent mutations are mechanically safe or denied.
6. AgentResult cannot complete Work or impersonate Verification.
7. active runtime no longer advertises/writes Specialist legacy vocabulary.
8. if approved, one ActionApproval ledger owns exact-intent lifecycle with migration proof.
9. all twenty tests, fault injection, real-provider paired qualification and `pnpm check` pass.
10. final MAC result distinguishes optional parallelism performance from core correctness.

## Stop conditions

- parallelism requires weakening one-active-main Workspace semantics;
- context handoff requires copying unbounded transcript;
- tool inheritance cannot prove child subset of parent;
- shared mutable resource conflicts cannot be enforced before effect;
- direct Parent Session writes are required for result delivery;
- terminal Execution must be reopened to support follow-up;
- approval migration cannot preserve exact intent and atomic single consumption;
- real-provider qualification shows no useful gain relative to complexity/cost.

If the final condition holds, disable/remove subagent capability; MAC closure does not depend on it.
