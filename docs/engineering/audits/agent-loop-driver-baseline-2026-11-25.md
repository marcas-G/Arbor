# Agent Loop Driver — refactor baseline audit (object 1)

Date: 2026-11-25 · Scope: read-only baseline for the first
architecture-evolution seam. All claims carry file:line evidence.

## Family scope

The driver's transitive direct-call closure is 29 files / ~13,741 lines
(driver core, action phase, decision phase, journals, pure helpers).

## Service acquisition inventory

Only 2 of 29 files acquire services from Effect Context directly; the
other 27 receive references through the giant Dependencies objects.

- Required (`yield* Service`): 11 — ModelContext, ProviderRuntime,
  ModelCapabilityPort, SessionRepository, HumanMessageStore,
  TransactionPort, EnvironmentRevisionStore, ProjectRepository,
  WorkspaceRepository, WorkRepository, Clock
  (agent-loop-driver.ts:140-188).
- Optional (`Effect.serviceOption`): 18 — with three distinct missing
  behaviors: fail-closed (ConversationCheckpoint/ResponseJob/Attempt/
  ExecutionRepository on conversation paths; BlobStore with attachments;
  RecoveryAttentionFactStore for legacy results); silent-disable
  (Inbox + InputPromotion drain skipped at agent-loop-driver.ts:459-463;
  WorkspaceKnowledge/WorkspacePlacement/LocalPlan/DecisionRequest context
  features silently absent — decision/context/workspace.ts:49,70,103,
  decision/preparation/instructions.ts:136-137; ToolInvocation+P39 exact
  recovery skipped — agent-loop-driver/recovery.ts:77-80); runtime
  re-check (AgentLoopStepStore isAvailable() per drive,
  agent-loop-driver.ts:227-233).
- Composition provides every optional service in production
  (composition.ts:893-975, 1241-1248, 1285-1292): the optionality exists
  only as a test backdoor.

## Classification

- Orchestration-legitimate: 4 (ModelContext, ProviderRuntime,
  ModelCapabilityPort, Clock).
- Business-knowledge leakage: 21 persistence stores/ports the family
  queries and writes directly. Representative evidence: control-basis
  assembly from 4 repos + 2 ports (agent-loop-driver.ts:274-290);
  hand-rolled three-way recovery join inside the family
  (agent-loop-driver/recovery.ts:81-159); inbox draining and
  InputPromotionService orchestration (agent-loop-driver.ts:464-500);
  column-level knowledge in decision/context/workspace.ts and
  decision/preparation/instructions.ts.

## State ownership

Zero module-level mutable state. Lifecycle tiers: per-daemon (27 service
references captured in the Layer closure, agent-loop-driver.ts:139-200);
per-drive (progressedSinceBoundary, turn/repairAttempt, availability
re-checks); per-decision-loop; per-action-phase. Cross-boundary note:
the action ledger receives setter access to the caller's
currentLoopStep/loopAction (agent-loop-actions.ts:220-240).
Inconsistency: AgentLoopStep/ProviderTurn availability is memoized at
daemon start while ToolInvocation/P39 is re-checked every drive.

## Giant Dependencies objects

| Interface | Fields | Single-consumer fields (should sink into their consumer) |
|---|---|---|
| ModelDecisionDependencies (decision/contract.ts:61-110) | 30 | 13 |
| AgentLoopActionDependencies (agent-loop-actions/types.ts:33-83) | 21 | 8 |
| AgentLoopStepCompletionDependencies | 13 | single consumer |
| ModelOutputJournalDependencies | 12 | single consumer |

Dead field: `sessions` destructured but unused (agent-loop-actions.ts:65).

## E01–E12 baseline

Violated: E02 (action/decision phases are free-function families, one
Service total — ExecutionDriverPort), E03 (composition injects raw
callbacks and the driver self-assembles control-basis with default
registries), E05 (76 fields across 4 interfaces; 40+ line conditional
assembly at call sites), E06 (16+2 production-required services hidden
in serviceOption — the type system is blind to them), E09 (146
`mapError(failure)` catch-all sites collapsing typed errors into 3
generic variants; 2 `Effect<void, unknown>` signatures), E11 (tests
hand-write fake repositories and dependencies, no Layer-level
substitution).
Conforms: E01, E04 (two noted exceptions), E10, E12. N/A: E07, E08.

## Quantified baseline (for before/after comparison)

- Direct Context service acquisitions: 29 (11 required / 18 optional)
- Production-required services hidden in serviceOption: 16 + 2
- Giant-Deps fields total: 76; sinkable single-consumer fields: 21
- Durable store dependencies held by the family: 21
- catch-all `mapError(failure)` sites: 146; `Effect<void, unknown>`: 2
- Family size: 29 files / 13,741 lines; module-level mutable state: 0
- E-rule violations: 6 of 12 (E02/E03/E05/E06/E09/E11)

Refactor order confirmation: E06 and E05 are the direct quantified
targets of objects 1 and 2 — the 16+2 hidden-required services move
into the Layer R channel first, then the 21 sinkable fields follow the
capability Services.
