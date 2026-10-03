# MAC-P1 — Single-Workspace Golden Path

## Authority and status

- Proposed authority: `planning/proposals/minimal-architecture-convergence-decision-draft.md`
- Evidence baseline: `planning/results/system-architecture-occam-audit.result.md`
- Current frozen design remains authoritative until manual acceptance.

```text
Planning:        FROZEN / COMPLETE
Design:          ACCEPTED / LANDED
Implementation:  COMPLETE / FORMALLY CLOSED
Entry gate:      SATISFIED — accepted token + design landing
```

This phase plan is frozen under the accepted MAC proposal. A later governance
change invalidates affected task contracts; implementation must not silently
adapt them.

Final evidence: `planning/results/MAC-P1.result.md`.

## Goal

Prove one complete, minimal, real-provider path inside the Root Workspace:

```text
Human goal
→ Root conversation creates exact Work
→ Scheduler admits WorkEpisode
→ Main Agent uses LocalPlan and executable actions
→ CompletionClaim
→ independent Verification
→ root Acceptance
→ Work Completed
→ user sees the accepted result
```

The phase is complete only when the path survives process restart and deterministic replay at every
asynchronous boundary. A registered command, database table or isolated unit test is not completion.

## Product behavior

### Ordinary conversation

```text
“你好” → normal text response; no Work, approval, Execution or Queue item
```

### Bounded goal

```text
“研究一个量化策略，不要真实下单”
→ assign_work(current)
→ exact approval preview contains goal, constraints and verification mission
→ approval creates one Open Work
→ “不要真实下单” remains an exact Work constraint
```

The user is never asked to choose Workspace/Work/Execution terminology.

### Completion

- Producer claim never means completed;
- Verification PASS enables root Acceptance but does not silently accept unless explicit Project
  policy authorizes it;
- FAIL returns criterion-level evidence to the same Work and keeps it Open;
- UNKNOWN produces a typed, actionable evidence/availability state and never becomes PASS;
- Acceptance commits before CompleteWork consumer closure; both are replay-safe.

## Scope

### Included

- accepted MAC vocabulary landing required by this phase;
- RootConversation `assign_work(current)` and exact CAPA interruption/resume;
- one model-facing ActionCall protocol with existing route-specific handlers;
- Work-scoped LocalPlan semantics and context projection;
- executable tool use inside exact WorkEpisode;
- typed tool/control result reinjection;
- CompletionClaim → Verification → Acceptance → CompleteWork;
- PASS / FAIL / UNKNOWN behavior;
- minimum WorkspaceKnowledgeView derived from accepted facts;
- typed consumer/recovery errors on the golden path;
- restart/replay/fault injection and real-provider qualification;
- projection/Web states needed to operate and understand this path.

### Excluded

- child Workspace creation or goal placement among children;
- Parent Agent acceptance of child results;
- Dependency/Deliverable/Message workflow;
- subagent/spawn_agent;
- physical merge of historical approval tables unless required to eliminate a correctness defect;
- full legacy-data deletion;
- new Provider family or frontend redesign unrelated to the golden path.

## Design boundaries

### LocalPlan

```text
owner          = Workspace cognition for exact Work revision
authority      = none
lifetime       = Work-local, may survive multiple Executions
mutation       = update_plan by the current Work Agent
scheduler use  = forbidden
completion use = forbidden
```

`WorkPlan` may retain its physical table during migration, but new design/API vocabulary uses
`LocalPlan`. No Domain transition may depend on PlanItem status.

### WorkspaceKnowledgeView

Phase 1 implements only a deterministic, trust-preserving view:

```text
Responsibility/Boundary facts
accepted root Work outcome summaries
current Decisions
versioned Artifact refs
unresolved accepted risks/questions
provenance/trust metadata
```

No free-form model-authored durable memory write is introduced. Session history is not wholesale
promoted into Knowledge.

### Root Acceptance

Root Work has no Parent Workspace. Acceptance source must be:

```text
AuthenticatedHuman
or
explicit versioned Project policy with exact authority fact
```

The phase must not invent a synthetic Parent Agent for root.

## Dependency graph

```text
MAC1-001 Contract landing
   ├─ MAC1-002 LocalPlan boundary
   ├─ MAC1-003 Root assign_work
   └─ MAC1-004 Unified ActionCall facade

MAC1-003 + MAC1-004
   └─ MAC1-005 Work execution and typed action results

MAC1-005
   └─ MAC1-006 Verification/Acceptance closure

MAC1-002 + MAC1-006
   └─ MAC1-007 WorkspaceKnowledgeView

MAC1-001..007
   └─ MAC1-008 Recovery, live qualification and phase closure
```

## Task contracts

| ID | Deliverable | Required proof |
|---|---|---|
| MAC1-001 | Accepted vocabulary/contracts; completion claims corrected | frozen-doc consistency review; architecture tests use executable assertions |
| MAC1-002 | LocalPlan removed from core authority semantics and compiled only for exact Work | no Plan-driven scheduling/action/completion; revision/restart tests |
| MAC1-003 | Root conversation text-or-assign behavior with exact current target | hello/no-op; goal/approval; constraint preservation; duplicate-turn replay |
| MAC1-004 | One model ActionCall facade over current executable/control routes | identical registration/visibility/authorization order; stale identity fail-closed |
| MAC1-005 | WorkEpisode performs real read/write/test tools and consumes typed failures | failed tool is useful model input; no `unknown` error at owning boundary |
| MAC1-006 | Claim → verifier → PASS/FAIL/UNKNOWN → root Acceptance/CompleteWork | exact revision/evidence; false PASS negative cases; restart at each consumer boundary |
| MAC1-007 | Minimum WorkspaceKnowledgeView | accepted-only inclusion; rejected/unverified/session text excluded; deterministic rebuild |
| MAC1-008 | Full black-box and real-provider closure | scenario matrix, migration/restart/fault proof, `pnpm check` |

## TDD matrix

| ID | Scenario | Expected outcome |
|---|---|---|
| G1 | greeting | one assistant response; zero Work/approval |
| G2 | clear bounded goal | one pending exact approval; no Work before approval |
| G3 | approval replay | exactly one Work and one WorkAssigned event |
| G4 | explicit prohibition | constraint stored and visible in every Work turn |
| G5 | tool typed failure | next model turn receives bounded useful information; Execution remains valid |
| G6 | provider interruption before effect | classified bounded recovery, no duplicate action |
| G7 | provider interruption after durable action | resume from AgentLoopStep; no action replay |
| G8 | completion claim | Work stays Open; one Verification starts |
| G9 | verification FAIL | Work Open, exact evidence returned, producer can repair |
| G10 | verification UNKNOWN | no PASS/acceptance; typed missing-evidence state |
| G11 | verification PASS | acceptance becomes actionable; Work not yet Completed |
| G12 | exact root acceptance | one WorkOutcomeAccepted then one CompleteWork |
| G13 | restart between acceptance and completion | deterministic consumer completes once |
| G14 | knowledge rebuild | accepted result included; unaccepted claim and raw transcript excluded |
| G15 | simple task without update_plan | task remains fully valid; Plan is optional |

## Migration and compatibility

- forward-only migration only after accepted physical contract;
- retain historical `work_plans` rows; no semantic inference from item text;
- new writes use accepted LocalPlan contract even if the physical table name remains temporarily;
- legacy RootConversation/ControlResult rows remain read-only evidence;
- migration re-entry and backup/restore must be tested on an equivalent fixture before the dogfood DB;
- no old migration file is modified.

## Error and Effect requirements

- every golden-path Effect exposes a narrow error union;
- repository unavailable, revision conflict, stale ControlBasis, denied approval, Provider transient,
  Provider terminal and Tool OutcomeUnknown remain distinguishable;
- consumer loops record durable retry/attention state instead of `console.error` and continue;
- `orDie` is allowed only for an invariant already mechanically proven impossible at that exact
  boundary, with a test showing the proof.

## Real-provider qualification

At minimum, repeat the following three times with the configured compatible provider:

1. greeting remains text-only;
2. bounded research goal creates one approval/Work and preserves a prohibition;
3. Work uses an executable tool, updates or omits LocalPlan legitimately, claims completion, and
   reaches PASS or an honest FAIL/UNKNOWN;
4. one injected restart resumes without duplicate Work, ToolInvocation, Verification or response.

Provider wording may vary; canonical effects and forbidden effects must be stable.

## Exit criteria

1. A user can complete the entire single-Workspace path without internal IDs or developer commands.
2. Every asynchronous transition has durable pending/applied/terminal truth.
3. LocalPlan remains optional cognition and has no authority edge.
4. Root Work completes only after exact Verification and Acceptance.
5. WorkspaceKnowledgeView contains accepted facts only and rebuilds deterministically.
6. No Specialist/subagent, Dependency or Formation capability is required by the path.
7. Golden-path production Effects have typed error channels.
8. Restart/replay matrix G1–G15 passes.
9. Real-provider qualification and `pnpm check` pass.
10. Result document maps every criterion to evidence and reports Blocking = 0.

## Stop conditions

- Root goal semantics require new Product/Domain concepts beyond accepted MAC vocabulary;
- a user prohibition cannot be preserved without prompt trust;
- any completed external effect must be replayed to repair context;
- Verification or Acceptance identity cannot bind exact Work revision;
- KnowledgeView requires promoting unverified model text as truth;
- same blocking condition repeats across three goal turns without a governed resolution.

Any such condition raises a Design Gap; it is not patched inside implementation.
