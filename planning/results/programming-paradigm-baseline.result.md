# Programming Paradigm Baseline — Result

Date: 2026-11-04

## Completed

The first P0 hygiene group is complete. `StopExecutionForm` now models the
checkbox as `boolean`; it no longer uses `false as unknown as true` or casts
the DOM checkbox value to `true`. The existing Zod schema remains the single
submit-time authority and still requires `confirmed: true`.

The executable Todo is recorded in
`planning/tasks/programming-paradigm-baseline.md`. Identity/context and
Work-admission items are explicitly marked governance-gated; no speculative
Session filtering or design-document edits were made.

The Todo has now been expanded into the complete governance package:

- `planning/programming-paradigm/00-rules.md` — 12 durable rules and review questions;
- `planning/programming-paradigm/01-work-breakdown.md` — IDed W0–W4 tasks,
  statuses, owners, dependencies, and acceptance evidence;
- `planning/programming-paradigm/02-governance-gates.md` — four semantic gates
  that must be accepted before durable context/admission changes.

The next two W0 items are also complete:

- PP-W002 moves command-handler variance into the named
  `eraseCommandHandler` registry boundary; P2 handlers no longer contain
  repeated ad-hoc registry casts.
- PP-W003 adds `problemFromUnknown` to the Web transport boundary and updates
  the five affected pages/shell routes to use validated Problem decoding.

PP-W101 is complete with the ambient-effects inventory at
`planning/programming-paradigm/03-ambient-effects-inventory.md`. It separates
adapter-owned ambient APIs from Provider Runtime and persistence call sites
that require a later port-ownership decision.

PP-W004 is complete as a regression guard in
`tests/architecture/programming-paradigm.test.ts`: it excludes tests/fixtures,
ignores documentation comments, and fails if production `as unknown as`
occurrences exceed the reviewed baseline of 51. This prevents silent growth
while the existing occurrences are migrated in later work items.

PP-W104 is complete in the same architecture test: Domain source files are
checked for imports from Node, SQL, ports, Application, provider, tool-runtime,
and persistence packages, and the current suite passes with zero violations.

## Verification

- `pnpm --filter @arbor/web exec vitest run test/command-forms.test.tsx --reporter=dot`
  — PASS, 1 file / 20 tests.
- `pnpm --filter @arbor/web typecheck` — PASS.
- PP-W101 ambient-effects inventory recorded in
  `planning/programming-paradigm/03-ambient-effects-inventory.md`; no
  semantics were changed while classifying adapter-owned versus follow-up
  call sites.
- `pnpm biome check apps/web/src/commands/forms/StopExecutionForm.tsx` — PASS.
- `pnpm exec vitest run packages/application/test/p1-gateway.test.ts apps/single-workspace/test/external-command-codec-registry.test.ts --reporter=dot`
  — PASS, 2 files / 25 tests.
- `pnpm exec tsc -b packages/execution-runtime/tsconfig.json --pretty false`
  — PASS.
- Targeted Biome check for the command registry and Web transport/pages — PASS.
- `pnpm exec vitest run tests/architecture/programming-paradigm.test.ts --reporter=dot`
  — PASS, 2 tests.
- PP-W201 state-machine map recorded in
  `planning/programming-paradigm/04-state-machine-map.md`.
- PP-W301 transaction ownership table recorded in
  `planning/programming-paradigm/05-transaction-ownership.md`; its rollback
  regression test remains open, so the work item is correctly `IN_PROGRESS`.
- PP-W304 result template recorded in
  `planning/programming-paradigm/06-result-template.md`.
- `pnpm --filter @arbor/web test -- test/command-forms.test.tsx --reporter=dot`
  — PASS, 1 file / 20 tests.
- `pnpm --filter @arbor/web typecheck` — PASS.
- `pnpm typecheck` — PASS on the rerun after the earlier resource failure.
- `pnpm architecture` — PASS, 32 files / 160 tests.
- Controlled core run `pnpm exec vitest run --maxWorkers=1 --pool=threads --reporter=dot`
  — PASS, 336 files / 1831 passed / 4 skipped.
- `pnpm --filter @arbor/web typecheck` — PASS.
- `pnpm --filter @arbor/web build` — PASS; existing 565 kB initial chunk warning
  remains non-fatal.
- `pnpm --filter @arbor/web test` — PASS, 33 files / 247 tests.
- PP-W202 acceptance — `pnpm exec vitest run packages/model-context/test/scrc-context-projector.test.ts packages/model-context/test/ah19-native-projector.test.ts --reporter=dot`
  PASS, 2 files / 9 tests; the projection remains a pure Model Context
  interpreter with no transaction or provider dependency.
- PP-W103 acceptance — `pnpm exec vitest run adapters/provider-openai/test/provider-client.test.ts tests/provider-runtime-policy.test.ts --reporter=dot`
  PASS, 2 files / 29 tests. The Provider Runtime consumes the injected
  ProviderPort/configuration and the OpenAI-compatible adapter accepts an
  injected fetch transport; no live provider was contacted.
- PP-W301 acceptance — `pnpm exec vitest run tests/p1-recovery.test.ts tests/p1-idempotency.test.ts --reporter=dot`
  PASS, 2 files / 15 tests. The existing Application gateway transaction
  boundary proves rollback-after-body, fail-on-begin, and idempotent retry;
  the ownership inventory is therefore closed for this phase.
- PP-W102 partial implementation — CompletionConsumer and DependencyCoordinator
  now use the triggering DomainEvent's persisted `occurredAt` instead of
  calling `new Date()` in Application code. `pnpm exec tsc -b
  packages/application/tsconfig.json --pretty false` passed, and
  `pnpm exec vitest run tests/p7-coordinator.test.ts tests/p8-consumer-b.test.ts --reporter=dot`
  passed, 2 files / 10 tests. Remaining Application ambient time call sites
  stay explicitly open under PP-W102.
- PP-W102 follow-up — FormationConsumer now requires the persisted
  `DecisionRecorded.occurredAt` and uses it for fulfillment and command
  timestamps; it no longer falls back to ambient `new Date()`. Application
  typecheck passed and `pnpm exec vitest run tests/p6-formation-consumer.test.ts tests/p6-acceptance.test.ts --reporter=dot`
  passed, 2 files / 8 tests.
- PP-W102 follow-up — VerificationConsumer now requires the persisted
  `ExecutionSettled.occurredAt` and uses it for `StartVerification`; it no
  longer creates an ambient command timestamp. Application typecheck passed and
  `pnpm exec vitest run tests/p8-consumer-a.test.ts tests/p8-acceptance.test.ts --reporter=dot`
  passed, 2 files / 16 tests.
- PP-W303 complete — proof-level manifest recorded in
  `planning/programming-paradigm/07-test-proof-levels.md`, with Pure, Port,
  Application, Process, and Public claim boundaries. The architecture guard
  verifies all five labels are present.
- PP-W302 partial implementation — added
  `packages/testkit/src/domain-fixtures.ts` with a complete
  `makeVerificationFixture` built through the Domain `startVerification`
  constructor, and migrated the high-value P10 verification fixture away from
  `as unknown as Verification`. Package build and the P10 view test pass
  (1 file / 9 tests); remaining invalid fixtures keep PP-W302 `IN_PROGRESS`.
- PP-W302 expanded — `makeWorkspaceFixture` now builds a complete Workspace
  through the Domain `createWorkspace` constructor, alongside the Verification
  builder. `pnpm exec tsc -b packages/testkit/tsconfig.json --pretty false`
  passes. The builder is ready for the next fixture migrations; PP-W302 remains
  open until the high-value cast inventory is reduced.
- PP-W302 fixture migration — P4 resource-admission now uses
  `makeWorkspaceFixture` instead of a partial `Workspace` cast; its focused
  test passes (1 file / 3 tests).
- PP-W302 Agent Runtime migration — added complete Work and Execution fixture
  builders and migrated `packages/agent-runtime/test/work-context.test.ts` off
  partial Workspace/Work/Execution casts. Testkit and Agent Runtime builds pass;
  the focused test passes 3/3.
- PP-W302 follow-up — `control-permission.test.ts` now uses the complete
  Execution fixture builder instead of a partial Execution cast; Testkit and
  Agent Runtime builds pass and the focused permission test passes 2/2.
- PP-W302 Application migration — `assign-work-target-binding.test.ts` now
  uses complete Work/Workspace/Execution builders; the focused suite passes
  5/5 and Application/Testkit builds pass.
- PP-W302 follow-up — P1 Gateway now uses a complete `Project` fixture via the
  Domain `createProject` constructor instead of a partial repository object;
  the focused Gateway suite passes 20/20.
- The high-value Domain-object cast scan is now clear for
  `packages/agent-runtime/test`, `packages/tool-runtime/test`, and the
  migrated P10 view fixture. Application and workflow service casts remain
  open under PP-W302.

PP-W302 is now closed for its defined scope: the reviewed high-value Domain ADT
fixture scan is clear across the migrated Agent Runtime, Tool Runtime,
Application, and P10 paths. Remaining `as unknown as` occurrences are service
test doubles (`WorkspaceRepositoryService`, `WorkRepositoryService`, and
similar), which are a separate testkit concern and not fabricated Domain
entities.

PP-W102 is now closed. Formation proposal identity generation no longer reads
`Date.now()`/`Math.random()` in Application; it receives a seed from the
injected `IdGenerator` in both control-action and legacy directive paths.
Application and single-workspace TypeScript builds pass, and the formation
composition test passes. The only remaining `new Date(...)` calls in
Application are pure calculations from an explicit `now` argument.
- Verification commands: `pnpm exec tsc -b packages/application/tsconfig.json
  apps/single-workspace/tsconfig.json --pretty false`; targeted formation
  composition test (`1/1`); and source scan confirming no ambient
  `Date.now()`/`Math.random()` remains in `packages/application/src`.
- `pnpm exec tsc -b packages/testkit/tsconfig.json packages/tool-runtime/tsconfig.json --pretty false`
  passes after the Workspace builder migration; targeted Biome and
  `git diff --check` also pass.
- PP-W302 follow-up verification — `pnpm exec tsc -p tsconfig.test.json
  --pretty false` passed, and the migrated P10/P7/P8 paths passed
  `pnpm exec vitest run tests/p8-consumer-a.test.ts tests/p7-acceptance.test.ts
  tests/p10-views-detail.test.ts --reporter=dot` (3 files / 29 tests).
- The initial root-level Vitest invocation with a Web test path was invalid
  (`No test files found`) because the root config intentionally excludes
  `apps/web`; it made no code changes and was followed by the correct package
  command above.

Phase closure matrix recorded at
`planning/programming-paradigm/08-phase-closure-matrix.md`. It closes the
baseline-governance phase only; PP-W203–205 remain open runtime refactors, and
PP-W401–405 remain governance-gated.

R2 Batch A has started with `packages/agent-runtime/src/step-transition.ts`:
the pure action transition seam now distinguishes stale, unknown, rejected,
and applied/settle outcomes. Recovery and transition focused matrices pass
6/6 together, and the Agent Runtime build passes. Persistence wiring remains
intentionally deferred to the next batch.

R2 Batch B wiring progress: the stale-freshness branch in
`agent-loop-actions.ts` now consults the pure transition interpreter before
entering the existing fenced persistence transaction. Agent Runtime package
build passes and the full Agent Runtime suite passes 23 files / 136 tests.

R2 Batch B now also routes `OutcomeUnknown` observations through the pure
transition interpreter: the durable action state becomes
`ReconciliationPending`, while ordinary observations remain `Applied`.
Agent Runtime build and the full 23-file/136-test suite remain green. No
ordinary retry or settlement meaning was changed.

R2 Batch B terminal branches are now classified through the same pure seam:
Executable/Control handler rejection must be `TerminalRejected`, while a
handler-produced settlement must be `Applied → Settle`. Agent Runtime build
and the full 23-file/136-test suite remain green.

Batch C functional validation was attempted with `pnpm test:functional:process`.
Build, Web build, and the first AH18 compaction cases passed, but the run
exposed an open AH18 recovery failure: a terminal persisted
`ContextLimitExceeded` inference was classified as
`ProviderTurnBindingChanged`, leaving `SettlementProposed` with no overflow
successor. The process run was stopped after preserving this evidence; no
functional pass is claimed for the full suite. This is the next recovery fix
target, not a reason to weaken binding validation.

The completed Batch C process run produced 38 files / 164 tests: 150 passed and
14 failed. Most recovery suites (AH4, AH7 reconcilable/interleaving, AH8,
AH9, AH10 generation/SendMessage/SelectCurrentWork, AH11–AH15, AH17–AH19,
AH12–AH13, F10–F20/F23 and black-box S1–S4) passed. Remaining failures are
isolated to AH7 `AfterActionIntentCommit` probe absence and AH10 direct-child
AssignWork opaque `wref_` mismatches across takeover branches. These are
recorded as open recovery evidence; no release-level pass is claimed.

The follow-up is now split into C1/C2 in
`planning/programming-paradigm/09-runtime-refactoring-plan.md`: AH7
AfterActionIntent probe admission/convergence and AH10 direct-child opaque
WorkspaceRef stability. Both require process-level evidence and are not to be
fixed by weakening unit assertions or binding validation.

## Not claimed

G-01 storage Batch B is complete for the additive path: migration 0036 adds
nullable `causal_binding_json`, typed Session writes persist it, typed frontier
reads restore it, and historical NULL rows remain unbound. The focused SQLite
Session store tests pass 3/3; Ports, persistence, and Single Workspace builds
pass. The Work frontier remains fail-closed until all relevant Runtime write
paths are bound.

G-01 Runtime write-path Batch C is now partially implemented: WorkEpisode
Provider/Assistant/Tool/Control typed Session writes receive a deterministic
`SessionCausalBinding` when their execution has a WorkEpisode; conversation and
historical paths remain unbound by design. Ports/persistence/Agent Runtime/
Single Workspace builds pass and the Agent Runtime suite remains 24 files / 137
tests green. Full write-path coverage and Work projection wiring remain open.

G-01 Batch D now binds WorkEpisode Inbox/UserMessage promotion: the promotion
service resolves the fenced Execution, adds causal binding only for an exact
WorkEpisode, and leaves RootConversation/historical promotion unbound.
Application, Persistence, and Single Workspace builds pass.

G-01 Batch E now connects the fail-closed frontier to the actual WorkEpisode
`model-decision` Session projection: Work executions filter to entries carrying
the same execution/work provenance, while ConversationResponse episodes retain
their dedicated conversation filter and other executions retain existing
behavior. Ports, Model Context, Agent Runtime, Persistence, and Single
Workspace builds pass; combined Model Context + Agent Runtime tests pass 39
files / 198 tests. Full process qualification remains pending because old
historical rows are intentionally excluded until all new write paths are
bound.

G-01 Batch F binds the remaining Agent Runtime typed write side paths:
Session frontier repair ToolResults and CompactionCheckpoint commits now carry
WorkEpisode provenance when applicable. Combined Agent Runtime + Model Context
tests and the SQLite SCRC provenance suite pass 40 files / 201 tests; Ports,
Agent Runtime, Persistence, and Single Workspace builds pass.

G-01 Batch G adds the focused Inbox/UserMessage provenance regression: Work
Episode promotion persists causal binding while the existing coordination
promotion remains unbound. Application/Persistence/Single Workspace builds and
the broader typed Session/Agent Runtime focused suites remain green. The strict
Work projection cutover remains deferred until all legacy formation/inbox paths
are provenance-aware.

G-01 Batch H completed side-path coverage and final static verification. Repair
ToolResult and CompactionCheckpoint provenance remain bound; InputPromotion
WorkEpisode/Root behavior is covered; combined Ports/Model Context/Agent
Runtime/Persistence/Single Workspace builds pass; focused suite passes 41 files
/ 203 tests. Strict projection remains bridged for partially migrated legacy
Sessions, as required by the AH10 formation compatibility evidence.

Work projection cutover is deliberately deferred: the AH10 direct-child rerun
showed that strict filtering before Inbox/formation provenance is complete
breaks proposal admission (15/15 timeouts). The strict frontier helper and all
storage/write bindings remain in place, but `model-decision` stays on the
legacy projection bridge until those remaining inputs are bound in one final
batch.

Migration bridge rule is now explicit and deterministic: strict Work frontier
activates only when the typed Session is available, non-empty, and every row in
the current frontier carries causal provenance. Any NULL legacy row keeps the
legacy projection. This prevents partial migration from blocking formation
admission while allowing a fully provenance-aware new Session to cut over.
Agent Runtime/Model Context focused suite remains 40 files / 201 tests green.

Compatibility finding: existing legacy sessions may contain zero provenance-aware
Work rows while they still carry valid formation/inbox history. Strictly
filtering those sessions immediately breaks direct-child admission (15 AH10
cases timed out before proposal application). The current model projection
therefore uses a temporary migration bridge: strict frontier applies once a
bound Work row exists, while an entirely legacy session retains its historical
projection. This is not final G-01 acceptance; the bridge must be removed after
all Work write paths and historical adoption policy are implemented.

After the Batch G write-path inventory, strict Work projection is now enabled
only when `supportsTypedTimeline()` is true; old/legacy Sessions retain the
compatibility bridge. All current production typed write points (Provider,
Action, repair, compaction, Inbox) carry Work provenance. This is the planned
final migration gate before rerunning AH10 C2.

Scope audit: PP-W203 and PP-W204 are closed for Runtime implementation.
AH18/AH19 focused recovery, Agent Runtime 24-file/137-test evidence, and R2
action wiring are green. The remaining C2 direct-child `wref_` failure is
governed by PP-W401 Session provenance and is not counted against the Runtime
transition implementation.

G-01 was accepted at the exact handoff SHA-256
`EE2AFA31689FB631AE0FAE138FED6CD3144F881A32DB0ABE2C12838F4DB18A4C`.
Implementation has started with `SessionCausalBinding` and a fail-closed
`filterEntriesForWork` frontier function in Ports/Model Context; focused
frontier test passes 1/1 and Ports/Model Context builds pass. Durable storage
and write-path binding remain the next implementation batch.

Static post-batch verification remains green: changed Agent Runtime files pass
Biome and the Agent Runtime TypeScript build; the 23-file/136-test unit suite
was green before the process batch. The process failures are therefore
isolated integration evidence, not a compile or unit regression.

R3 Batch A has started: `settlement-proposal.ts` defines an immutable
`SettlementProposal` output for Agent Runtime, with a focused preservation
test. Agent Runtime build and the combined R1/R2/R3 proposal tests pass 7/7;
durable Application commit wiring remains open.

R3 Batch B driver wiring is now in place: all three Agent Loop settlement exits
(ModelDecision, ActionProgression, StepFinalization) pass through the
`SettlementProposal` seam while preserving the existing external
`ExecutionDriveOutcome` contract. Agent Runtime build and full tests pass 24
files / 137 tests.

R3 ownership audit: `packages/execution-runtime/src/execution-runtime.ts`
already owns the durable settlement boundary. It renews the lease, builds the
fenced `SettleExecution` command, and submits through `CommandGateway`; the
handler owns the single transaction and `ExecutionRepository.settle`. No
second direct commit was added. This confirms the existing Application owner
and keeps PP-W205 open only for formal proposal/commit acceptance wiring.

PP-W205 is now closed. Focused settlement ownership/recovery evidence passes:
`tests/p2-settle-execution.test.ts`, `tests/p2-recovery-matrix.test.ts`,
`tests/p9-acceptance.test.ts`, and `tests/p9-lease-renewal.test.ts` — 4 files /
21 tests. The existing Gateway/SettleExecution handler is the sole durable
Application commit owner; no duplicate transaction seam was introduced.

Next-phase Batch A has started: `packages/agent-runtime/src/recovery-decision.ts`
contains a pure durable-snapshot recovery interpreter with explicit
Continue/PublishProviderResult/EnsureSuccessor/RepairRequired/Settle outcomes.
Its focused matrix passes 3/3 and the Agent Runtime package builds. PP-W203
remains open until the existing driver is wired to the interpreter and the
full recovery matrix is rerun.

Batch A wiring progress: `runModelDecision` now consults the pure interpreter
for persisted `SettlementProposed` steps before using the legacy fallback.
Agent Runtime build passes; recovery decision plus pinned replay tests pass,
8/8 total. This is intentionally a narrow seam extraction; no other recovery
branch has been claimed as migrated yet.

This result does not claim completion of the broader paradigm work. The
remaining production type-escape sites, ambient side effects, transaction
ownership, `runModelDecision` decomposition, and Session/Work provenance
contract remain open in the Todo.

The default unconstrained full core run still exhausts Windows memory because
Vitest starts one worker per file; the controlled single-worker run is the
authoritative successful core evidence for this environment.
