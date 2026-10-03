# MAC — Minimal Vocabulary and Workspace Cognition

## 1. Durable product/domain vocabulary

The active product/domain concepts are:

```text
Project       governance container
Workspace     long-lived responsible identity
Work          durable outcome/completion contract
Artifact      versioned reality/result reference
Verification  independent quality judgment
Acceptance    authorized result sufficiency decision
Permission    standing authority boundary
```

Additional durable runtime records may exist only to preserve execution,
recovery, delivery or audit. They are not user organization concepts.

## 2. Agent definition

```text
Workspace = durable responsible identity
Agent     = cognitive execution role enacted by Runtime during an Execution
```

There is no AgentId or permanently live Agent process. Long-term continuity is
the composition of Workspace identity, Responsibility, ResourceBoundary,
WorkspaceKnowledgeView, binding configuration, accepted evidence and Session
history. “Responsibility-bound Agent” is compatibility vocabulary for the
Workspace's configured execution role, not a durable entity beside Workspace.

## 3. LocalPlan

`LocalPlan` is Workspace-local cognition for one exact Work revision:

```ts
interface LocalPlan {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly revision: number;
  readonly items: ReadonlyArray<{
    readonly itemId: string;
    readonly text: string;
    readonly status: "Pending" | "InProgress" | "Completed" | "Blocked";
  }>;
}
```

Hard boundary:

- optional and model-maintained;
- may survive multiple Executions for the same Work revision;
- no scheduling, authority, formation, dependency, action or completion edge;
- no PlanItem-to-ToolInvocation/subagent/domain relationship;
- never proves Work completion or Verification;
- product UI may show it as collapsible progress, never as the canonical
  project task board.

Existing `WorkPlan` storage is migration compatibility. New code depends on a
Workspace cognition/Agent Runtime port, not on a core Domain aggregate.

## 4. WorkspaceKnowledgeView

MAC v1 does not introduce a free-form model-promoted Memory aggregate. The
minimum knowledge surface is a deterministic, provenance-preserving view of:

```text
current Responsibility and ResourceBoundary
accepted Work outcome summaries
current non-superseded Decisions
versioned Artifact references
accepted unresolved risks/questions
trust/provenance metadata
```

Rules:

- accepted/canonical sources are eligible; CompletionClaim, raw assistant text,
  unverified ToolResult and arbitrary Session prose are not truth;
- view rebuild from canonical facts and durable accepted references is
  deterministic;
- Session remains cognitive history/provider continuity, not Knowledge truth;
- `MemoryId` and unprovisioned KnowledgeQueryPort do not count as implemented
  capability;
- later model-assisted knowledge promotion requires a separate accepted
  contract preserving provenance, supersession and revocation.

## 5. Runtime-only vocabulary

Execution/Episode, Session, AgentLoopStep, ProviderTurn/Attempt, ActionCall,
ToolInvocation, ResponseJob/Attempt, Inbox/Wake/ConsumerOffset and Lease/Fence
remain internal runtime/audit concepts. A user may inspect them diagnostically
but is never required to understand them to create or complete ordinary Work.

## 6. Temporary parallel Agent execution

`Specialist` is removed from active product/domain vocabulary. Optional future
parallel cognition is:

```text
spawn_agent(SubagentBrief) → child Execution → AgentResult
```

It creates no Workspace, Work, AgentId, long-term knowledge, Verification or
Acceptance and has no PlanItem binding. Historical `SpecialistSpec`,
`SpecialistSettled` and `spawn_specialist` are replay/migration aliases only
after MAC-P4 migration. Core correctness and MAC-P1…P3 never depend on a
subagent.
