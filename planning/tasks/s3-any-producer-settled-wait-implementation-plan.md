# S3 AnyProducer Settled-Wait Implementation Plan

**Status: PLAN ONLY — design package is not accepted and implementation is not
authorized.** This file schedules no source changes until both governance gates
below are satisfied.

**Planning base:** `366b83045aa59338c8c416179c55de66334b9b9e`
**Planning branch/worktree:** `codex/s3-any-producer-impl-plan` at
`C:\Users\ThinkPad\.codex\worktrees\s3-impl-plan\Arbor`
**Fixed package:** `planning/manifests/s3-any-producer-settled-wait-governance-package.manifest.json`
**Package SHA-256:** `5b558d26b4140631f5c7a14bb743b1e42a9d8992d50feee1a3d2c3c98353b7c8`
**Suggested decision token:** `ACCEPT_S3_ANY_PRODUCER_WAIT_ELIGIBILITY_V1`
**Review:** p41 record commit `96ba2801dfa7e411d667f83d446b33e4c6b7aaba`,
Blocking = 0. Review is not acceptance or implementation authorization.

## Authorization gates

1. The manual governor must accept the exact manifest/package identity. Per the
   package, this authorizes **design landing only** in the owning P7/P10 docs.
2. Source work below starts only after a separate explicit implementation
   authorization. Neither gate is satisfied by this planning task, the RED, or
   the S3 real-provider failure evidence.
3. `docs/design/**` remains frozen until the accepted design landing package is
   applied under the governor's authority. This implementation plan must not
   edit it.

The failed real S3 evidence is in
`planning/results/real-public-s3-collaboration-rerun-20261024.result.md`; the
current missing-Attention RED and proposal status are in
`planning/results/s3-any-producer-settled-wait-gap-20261024.result.md`. S3 is
unqualified. No real Provider rerun is part of planning or implementation
verification until the final qualification gate below.

## Frozen implementation boundaries

- Apply APW-1 only to the **new model-authored** `DeclareDependency(AnyProducer)`
  AgentAction. Keep P7 `DeclareDependency` command semantics for authorized
  external/human paths unchanged.
- Replay exact prior Action/Command outcomes before APW-1 evidence evaluation.
  Do not create a new receipt namespace or change command IDs/fingerprints.
- Use the fixed three producer-evidence categories from the accepted package:
  another same-Project Open Work (not the consumer Work), an exact approved
  FormationProposal with in-flight initial Work fulfillment, or a persisted
  same-Project Deliverable that passes the frozen P7 matcher. Do not inspect
  Work objective, Prompt, Provider response, Message, or Inbox text as
  capability evidence.
- When the evidence set is empty, return the existing
  `AgentActionRejected` code `action/precondition` with a bounded safe message
  and `ChooseAlternative`. The Agent Loop already records this as
  `ModelUsable`; do not add a new error union member or canonical Command.
- APW-3 is a read-only projection over the exact fresh `DependencyChanged`
  WorkWait, unsatisfied AnyProducer Dependency, still-Open consumer Work, no
  active WorkEpisode/project Execution, no current Pending formation decision,
  no Approved-but-unapplied producer fulfillment, and no APW-3 producer
  evidence. Revision-mismatched waits are suppressed. A brief current-revision
  Attention before the existing wake consumer clears the Wait is permitted;
  the row is not authority, a wake, or an admission gate.
- Reuse `WaitingOnVacantProducer`, target the consumer Workspace, preserve
  `vacant-producer:<dependencyId>` dedup, and use a fixed non-content-bearing
  summary that does not invent a producer Workspace.
- **No schema or API migration:** no DDL, table/index, migration version,
  command/event, HTTP view ID, public Attention source label, WakeReason,
  persistent Attention marker, receipt namespace, or replay cursor change.
  `AnyProducer`, the P7 matcher, coordinator satisfaction and P7 wake behavior
  are unchanged. Keep `packages/application/src/commands/declare-dependency.ts`,
  `packages/application/src/commands/satisfy-dependency.ts`, and
  `packages/application/src/dependency-coordinator.ts` unchanged unless an
  authorized design amendment explicitly reopens them.

## Work sequence and exact ownership

| Stage | Owner files | Required work and tests | Exit gate |
|---|---|---|---|
| G0 — governance | `planning/proposals/s3-any-producer-settled-wait-governance-draft.md`; manifest and review record | Manual acceptance of the exact manifest/package; then separate implementation authorization. | Stop here while either authorization is absent. |
| L1 — shared producer evidence | New `apps/single-workspace/src/any-producer-evidence.ts`; `apps/single-workspace/src/control-actions.ts`; wiring in `apps/single-workspace/src/composition.ts` only if a required existing store is not already in the control-handler layer. | Build a bounded, same-Project, read-only evidence query over existing Project/Workspace/Work, FormationProposal/Fulfillment, Deliverable and CommandReceipt stores. The query must run inside one `TransactionPort.transact` snapshot and return fixed facts/booleans only. Reuse `matchesExpectedDeliverable` and the existing P7 deterministic satisfaction CommandId. Missing/invalid stores are operational failures, not evidence. Unit tests in new `apps/single-workspace/test/any-producer-evidence.test.ts` cover each positive category, all specified negatives, cross-Project isolation, and no free-text inspection. | Query contract is reviewed before L2/L3 consume it. No database schema change. |
| L2 — APW-1 action gate | `apps/single-workspace/src/control-actions.ts`; new `apps/single-workspace/test/declare-dependency-producer-evidence.test.ts`; related assertions in `apps/single-workspace/test/ah10-generation-command-takeover.test.ts` only if replay coverage is missing. | Preserve the current prior-generation `findPriorCommandReceipt` path. Add exact current-generation receipt-first resolution before the evidence gate (identity, project, fingerprint, schema and typed result validated by existing receipt helpers). A Committed/TerminalRejected exact replay returns its old observation without rechecking current evidence. An absent/retryable new invocation with no evidence fails as `action/precondition/ModelUsable` before `CommandGateway.execute`; with evidence it enters the existing gateway unchanged. Test gateway calls, Command receipt/event/dependency counts, same- and prior-generation replay, and `AgentActionRejected` → ModelUsable projection via the existing AgentLoop harness. | Focused action/receipt tests pass. Direct P7 command remains unchanged; `tests/p7-acceptance.test.ts` AnyProducer command case stays green. |
| L3 — APW-3 projection | `packages/projection-runtime/src/attention.ts`; `packages/projection-runtime/src/attention-loader.ts`; `apps/single-workspace/src/projection-query.ts`; `packages/projection-runtime/test/**` only if a package-local fixture exists; otherwise `tests/p10-attention-readmodel.test.ts`. | Extend internal Attention facts with bounded AnyProducer waiting candidates. Reuse the L1 evidence reader from app query wiring; retain exact WorkWait revision equality; derive a row only when all APW-3 idle and vacancy facts hold. Do not materialize the row or mutate canonical state. Reuse the existing source/dedup/consumer target. | The existing RED at `tests/functional/pending/s3-any-producer-settled-wait-attention.pending.test.ts` turns green; stale-revision, active Execution, Pending/Approved formation, producer evidence, terminal receipt, satisfied Dependency, cleared Wait, and zero-mutation negatives pass. Existing WorkspaceBound and retired-workspace negatives remain unchanged. |
| L4 — focused integration | `tests/p7-coordinator.test.ts`; `tests/p7-acceptance.test.ts`; `tests/p10-attention-readmodel.test.ts`; new `apps/single-workspace/test/declare-dependency-producer-evidence.test.ts`; relevant package/typecheck scopes. | Prove external/human command path remains governed by existing P7 command semantics; `DependencyDeclared` still invokes existing P7 coordinator recheck; true matching Deliverable alone can satisfy; only the existing P7 wake consumer clears/wakes. Test temporary current-revision Attention and its automatic disappearance after Wait clear. | P7/P10 focused suites and full test TypeScript check pass. Biome and `git diff --check` pass. |
| L5 — public process regression | New `tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts`; existing `tests/functional/support/production-fixture.ts` and `tests/functional/support/public-client.ts` reused without broad behavior changes. | Scripted-provider/public-API test only: natural Root goal → model attempts unsupported AnyProducer → public-process observation is ModelUsable and no dependency/Wait is committed → model chooses existing Parent-governed formation/exact WorkspaceBound route or requests clarification → real matching public Deliverable uses existing coordinator/wake. Include legacy AnyProducer Attention and stale/active suppressors through public views. This process test is not real-provider qualification. | Single targeted functional file passes with retry 0; no private-store assertion is used as public-process proof. |
| L6 — product integration and qualification | Existing `tests/capability/real-provider/public-s3-collaboration.test.ts`; current `tests/capability/real-provider/public-real-journey-support.ts`; `planning/results/real-public-s3-collaboration-rerun-20261024.result.md` plus a new result record. | First build production assets and finish all local gates. Then, only with explicit run authorization, run one fresh P39-private S3 real-provider journey: natural goal, formation approvals, child write approval, dependency wait, Child Artifact/Deliverable, deterministic satisfaction/wake, Parent consumption, child/Parent Verification and Acceptance. Preserve DB/workspace/capture on failure; no retry or scripted fallback. | Only a complete PASS with intact public evidence can qualify S3; any model stall/Fail/Unknown stays unqualified and is recorded without claiming completion. |

## Test files and unchanged contracts

Implementation tests to add/extend, in dependency order:

1. `packages/domain/test/dependency.test.ts` only if APW-1/APW-3 share a pure
   evidence-reduction predicate there; do not place store queries in Domain.
2. `apps/single-workspace/test/any-producer-evidence.test.ts` for same-snapshot
   producer fact classification.
3. `apps/single-workspace/test/declare-dependency-producer-evidence.test.ts`
   for new-action rejection, no canonical write, every positive case, and
   receipt-first replay.
4. `tests/p7-acceptance.test.ts`/`tests/p7-coordinator.test.ts` to retain the
   unchanged canonical Command, matcher, coordinator and wake contracts.
5. `tests/p10-attention-readmodel.test.ts` for APW-3 positive, stale wait,
   idle/active, evidence, formation, receipt, satisfaction, wait-clear and
   no-mutation cases.
6. `tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts`
   for public process behavior.
7. `tests/capability/real-provider/public-s3-collaboration.test.ts` last, after
   all previous layers and only with explicit real-provider authorization.

The accepted package's pending RED is already in
`tests/functional/pending/s3-any-producer-settled-wait-attention.pending.test.ts`;
promote/replace it with maintained P10 tests only after L3 is implemented. Keep
`tests/capability/real-provider/public-s3-collaboration.test.ts` as a natural
goal oracle; do not mention control-tool names in its user prompt or make the
test force a tool call to obtain PASS.

## Parallel boundaries

- After L1 defines its stable fact shape, L2 (control action/receipt gate) and
  L3 (P10 projection) may proceed in parallel only with separate file owners.
- L1 owns `apps/single-workspace/src/any-producer-evidence.ts` and the evidence
  contract. L2 owns `apps/single-workspace/src/control-actions.ts` and its
  action/receipt tests. L3 owns `packages/projection-runtime/src/attention.ts`,
  `attention-loader.ts`, and `apps/single-workspace/src/projection-query.ts`.
  Do not split ownership of those files concurrently.
- `apps/single-workspace/src/composition.ts` is a single-owner integration file
  if service-layer dependencies need updating. No parallel edit to it.
- `tests/p7-acceptance.test.ts` and `tests/p7-coordinator.test.ts` remain P7
  regression ownership; `tests/p10-attention-readmodel.test.ts` is P10
  regression ownership. The shared L1 helper contract must be stable before
  either suite is edited.
- L4 functional process coverage starts after L2/L3 are green. L5 real-provider
  qualification is strictly serial, last; no concurrent real-provider cases,
  no automatic retries, and no real runs while any action/projection RED
  remains.
- Heavy build/full functional slots belong to the root orchestrator. The plan
  stage performs no build, test, daemon, or Provider run.

## Explicit non-scope

No implementation, design-doc edit, migration, SQL schema change, new public
view/action/event/Attention source, new durable fact/receipt, P7 coordinator or
wake rewrite, Acceptance/Verification change, private provider configuration
inspection, daemon launch, or real-provider attempt is authorized by this
plan.
