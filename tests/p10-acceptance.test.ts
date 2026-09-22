import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P8_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runConsumerBatch,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../apps/single-workspace/src/runnable-source-p7.js";
import type {
  AttentionRes,
  CurrentWorkRes,
  DependencyRes,
  InboxViewRes,
  TranscriptRes,
  TreeViewRes,
  UsageRes,
  WorkspaceDetailRes,
} from "../packages/api-contracts/src/index.js";
import {
  type AcceptWorkOutcomePayload,
  makeAcceptWorkOutcomeHandler,
} from "../packages/application/src/commands/accept-complete.js";
import {
  type MarkDependencyUnfulfillablePayload,
  makeMarkDependencyUnfulfillableHandler,
  makeWithdrawDependencyHandler,
  type WithdrawDependencyPayload,
} from "../packages/application/src/commands/dependency-transitions.js";
import {
  makeRecordDecisionHandler,
  type RecordDecisionPayload,
} from "../packages/application/src/commands/record-decision.js";
import {
  HUMAN_STOP_EMISSION_PRECONDITION,
  humanStopInterventionEvent,
} from "../packages/application/src/human-intervention.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import type { VerificationMission } from "../packages/domain/dist/index.js";
import {
  Actor,
  admitFormationProposal,
  CommandId,
  MessageId,
  Principal,
  parse,
  startVerification,
  VerificationId,
  VIEW_IDS,
  type ViewId,
  WORKSPACE_STATUS_LABELS,
  WorkId,
  WorkRevision,
  WorkspaceId,
  type WorkspaceStatusLabel,
} from "../packages/domain/dist/index.js";
import type { ProjectionStale } from "../packages/ports/src/errors.js";
import {
  AcceptanceRepository,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DependencyRepository,
  DomainEventJournal,
  FormationProposalStore,
  InboxProjectionStore,
  ProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
} from "../packages/ports/src/index.js";
import {
  type ActionGateway,
  type ActionReceipt,
  governanceEntryRequest,
  steerRequest,
  stopRequest,
  submitQueryRequest,
} from "../packages/projection-runtime/src/actions.js";
import type {
  AttentionRow,
  EffectiveFactsSnapshot,
  ProjectionQueryRuntimeDeps,
  TreeViewNode,
  UsageRowView,
} from "../packages/projection-runtime/src/index.js";
import {
  buildTreeView,
  compareProjectionState,
  deriveCurrentWork,
  deriveDependencyRows,
  deriveEffectiveFacts,
  deriveInboxView,
  deriveProjectAttention,
  deriveTranscriptPage,
  deriveUsageRows,
  deriveVerificationView,
  deriveWorkspaceDetail,
  makeEffectiveFactsQueryFace,
  makeProjectionQueryService,
  orchestrateRebuild,
  projectionReadError,
  REBUILD_STAGE_ORDER,
  type RebuildOrchestrationDeps,
  rebuildOnDetectedDrift,
  reconcileInbox,
} from "../packages/projection-runtime/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";
import {
  insertAcceptanceRow,
  insertDependencyRow,
  insertEventRow,
  insertEvidenceRow,
  insertExecutionRow,
  insertInboxRow,
  insertMessageRow,
  insertProjectRootRow,
  insertProposalRow,
  insertProviderTurnRow,
  insertSessionEntryRow,
  insertVerificationRow,
  insertWaitRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  type P10FixtureDeps,
  p10Child,
  p10Flagged,
  p10Leaf,
  p10Project,
  p10Retired,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const makeQueryService = (deps: P10FixtureDeps) =>
  makeProjectionQueryService({
    journalLastSequence: deps.journalLastSequence,
    projectIdOfWorkspace: deps.projectIdOfWorkspace,
    tree: deps.tree,
    attention: deps.attention,
    workspaceDetail: deps.workspaceDetail,
    currentWork: deps.currentWork,
    verification: deps.verificationView,
    dependency: deps.dependencyView,
    transcript: deps.transcript,
    usage: deps.usage,
    inboxView: deps.inboxView,
    effectiveFacts: deps.effectiveFacts,
    inboxReconcile: deps.inboxReconcile,
  });

const runtimeDepsOf = (
  deps: P10FixtureDeps,
  snapshotWatermark: NonNullable<
    ProjectionQueryRuntimeDeps["snapshotWatermark"]
  >,
  catchUp: NonNullable<ProjectionQueryRuntimeDeps["catchUp"]>,
): ProjectionQueryRuntimeDeps => ({
  journalLastSequence: deps.journalLastSequence,
  projectIdOfWorkspace: deps.projectIdOfWorkspace,
  snapshotWatermark,
  catchUp,
  tree: deps.tree,
  attention: deps.attention,
  workspaceDetail: deps.workspaceDetail,
  currentWork: deps.currentWork,
  verification: deps.verificationView,
  dependency: deps.dependencyView,
  transcript: deps.transcript,
  usage: deps.usage,
  inboxView: deps.inboxView,
  effectiveFacts: deps.effectiveFacts,
  inboxReconcile: deps.inboxReconcile,
});

describe("p10-acceptance (P10 07 Stories A–G)", () => {
  it("Story A — Tree & Status: one barrier-gated tree query renders the responsibility chain, frozen per-node labels and subtree attention summaries; zero view writes", async () => {
    const rootWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a1");
    const childWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a2");
    const flagWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a5");
    const otherWs = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-000000000a91",
    );
    const childDep = "dep_00000000-0000-7000-8000-0000000000a1";

    const seed = seedCanonical(
      Effect.gen(function* () {
        yield* insertProjectRootRow(p10Root, p10Project);
        yield* insertWorkspaceRow(
          { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          {
            workspaceId: p10Retired,
            parentWorkspaceId: p10Root,
            name: "gone",
            lifecycle: "Retired",
          },
          p10Project,
        );
        yield* insertWorkspaceRow(
          {
            workspaceId: p10Flagged,
            parentWorkspaceId: p10Root,
            name: "flagged",
          },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: rootWork,
            workspaceId: p10Root,
            objective: "root objective",
          },
          p10Project,
        );
        yield* setCurrentWork(p10Root, rootWork);
        yield* insertExecutionRow(
          {
            executionId: "exe_00000000-0000-7000-8000-0000000000a1",
            workspaceId: p10Root,
            focusWorkId: rootWork,
          },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: childWork,
            workspaceId: p10Child,
            objective: "child objective",
          },
          p10Project,
        );
        yield* insertDependencyRow({
          dependencyId: childDep,
          consumerWorkId: childWork,
          producerWorkspaceId: otherWs,
        });
        yield* insertWaitRow(childWork, [
          {
            _tag: "DependencyChanged",
            dependencyId: childDep,
            observedRevision: 0,
          },
        ]);
        yield* insertWorkRow(
          {
            workId: flagWork,
            workspaceId: p10Flagged,
            objective: "flag objective",
          },
          p10Project,
        );
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000a1",
          projectId: p10Project,
          eventType: "DeadlockAttentionRequested",
          payload: {
            cycleWorkIds: [flagWork],
            dependencyIds: [],
            detectedAt: "t9",
          },
          occurredAt: "t9",
        });
      }),
    );

    interface WireNode {
      readonly workspaceId: WorkspaceId;
      readonly status: string;
      readonly subtreeAttention: { attention: number; actionRequired: number };
      readonly currentWork?: { workId: WorkId; objective: string } | null;
    }

    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seed;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();
        const service = makeQueryService(deps);

        const result = yield* service.query<never, TreeViewRes>(
          "responsibility-tree",
          { projectId: p10Project } as never,
          { maxLag: 0 },
        );
        expect(result.lag).toBe(0);

        const nodes = result.value.nodes as readonly WireNode[];
        expect(nodes).toHaveLength(5);
        const byId = new Map(nodes.map((node) => [node.workspaceId, node]));
        expect(byId.get(p10Root)?.status).toBe("executing");
        expect(byId.get(p10Child)?.status).toBe("waiting-blocked");
        expect(byId.get(p10Leaf)?.status).toBe("idle");
        expect(byId.get(p10Retired)?.status).toBe("retired");
        expect(byId.get(p10Flagged)?.status).toBe("attention-flagged");
        expect(byId.get(p10Root)?.currentWork).toEqual({
          workId: rootWork,
          objective: "root objective",
        });
        expect(byId.get(p10Flagged)?.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 1,
        });
        expect(byId.get(p10Root)?.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 1,
        });
        expect(byId.get(p10Child)?.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 0,
        });
        expect(
          Object.keys(byId.get(p10Root)?.subtreeAttention ?? {}).sort(),
        ).toEqual(["actionRequired", "attention"]);
        expect(new Set(nodes.map((node) => node.status))).toEqual(
          new Set([
            "executing",
            "waiting-blocked",
            "idle",
            "retired",
            "attention-flagged",
          ]),
        );

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("Story B — Attention read-model: all six fact sources exact on the wire (GAP-01 positive + retired negative); canonical snapshot untouched", async () => {
    const consumerWs = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-0000000000b1",
    );
    const vacantWs = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-0000000000b2",
    );
    const retiredProducerWs = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-0000000000b3",
    );
    const consWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");
    const leafWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b2");
    const flagWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b3");

    const seed = seedCanonical(
      Effect.gen(function* () {
        yield* insertProjectRootRow(p10Root, p10Project);
        yield* insertWorkspaceRow(
          { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          {
            workspaceId: p10Flagged,
            parentWorkspaceId: p10Root,
            name: "flagged",
          },
          p10Project,
        );
        yield* insertWorkspaceRow(
          {
            workspaceId: consumerWs,
            parentWorkspaceId: p10Root,
            name: "consumer",
          },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: vacantWs, parentWorkspaceId: p10Root, name: "vacant" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          {
            workspaceId: retiredProducerWs,
            parentWorkspaceId: p10Root,
            name: "retired-producer",
            lifecycle: "Retired",
          },
          p10Project,
        );
        yield* insertWorkRow(
          { workId: consWork, workspaceId: consumerWs, objective: "consume" },
          p10Project,
        );
        yield* insertWorkRow(
          { workId: leafWork, workspaceId: p10Leaf, objective: "verify-me" },
          p10Project,
        );
        yield* insertWorkRow(
          { workId: flagWork, workspaceId: p10Flagged, objective: "cycle" },
          p10Project,
        );

        yield* insertDependencyRow({
          dependencyId: "dep_b1",
          consumerWorkId: consWork,
          producerWorkspaceId: vacantWs,
          state: "Unfulfillable",
          revision: 2,
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000b1",
          projectId: p10Project,
          eventType: "DependencyMarkedUnfulfillable",
          payload: {
            dependencyId: "dep_b1",
            dependencyRevision: 2,
            justification: "producer gone",
          },
          occurredAt: "t1",
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000b2",
          projectId: p10Project,
          eventType: "DeadlockAttentionRequested",
          payload: {
            cycleWorkIds: [flagWork],
            dependencyIds: ["dep_bd1"],
            detectedAt: "t2",
          },
          occurredAt: "t2",
        });
        yield* insertExecutionRow(
          {
            executionId: "exe_b1",
            workspaceId: p10Child,
            focusWorkId: leafWork,
            settlement: {
              _tag: "Interrupted",
              result: {
                _tag: "ControlledInterruption",
                reason: "RuntimeSafetyStop",
              },
            },
            settledAt: "t3",
          },
          p10Project,
        );
        yield* insertExecutionRow(
          {
            executionId: "exe_b2",
            workspaceId: p10Child,
            focusWorkId: leafWork,
            settlement: {
              _tag: "OutcomeUnknown",
              reconciliation: {
                _tag: "ReconciliationRequired",
                invocationRefs: ["ref-1"],
              },
            },
            settledAt: "t4",
          },
          p10Project,
        );
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000b3",
          projectId: p10Project,
          eventType: "ReconciliationEscalated",
          payload: {
            executionId: "exe_b2",
            invocationRefsFingerprint: "fp1",
            refs: ["ref-1"],
          },
          occurredAt: "t4",
        });
        yield* insertExecutionRow(
          {
            executionId: "exe_b3",
            workspaceId: p10Leaf,
            focusWorkId: leafWork,
            settlement: {
              _tag: "Completed",
              result: { _tag: "CoordinationCompleted" },
            },
            settledAt: "t5",
          },
          p10Project,
        );
        yield* insertVerificationRow({
          verificationId: "ver_b1",
          workId: leafWork,
          targetWorkRevision: 0,
          ownerWorkspaceId: p10Leaf,
          executionIds: ["exe_b3"],
        });
        yield* insertExecutionRow(
          {
            executionId: "exe_b4",
            workspaceId: p10Leaf,
            focusWorkId: leafWork,
          },
          p10Project,
        );
        yield* insertVerificationRow({
          verificationId: "ver_b2",
          workId: leafWork,
          targetWorkRevision: 1,
          ownerWorkspaceId: p10Leaf,
          executionIds: ["exe_b4"],
        });
        yield* insertDependencyRow({
          dependencyId: "dep_bg1",
          consumerWorkId: consWork,
          producerWorkspaceId: vacantWs,
        });
        yield* insertDependencyRow({
          dependencyId: "dep_bg2",
          consumerWorkId: consWork,
          producerWorkspaceId: retiredProducerWs,
        });
      }),
    );

    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seed;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();
        const service = makeQueryService(deps);

        const result = yield* service.query<never, AttentionRes>("attention", {
          projectId: p10Project,
        } as never);
        expect(result.lag).toBe(0);
        const rows = result.value.rows;
        const bySource = new Map(rows.map((row) => [row.source, row]));

        expect(bySource.get("DependencyUnfulfillable")).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: consumerWs,
          dedupKey: "unfulfillable:dep_b1:2",
          occurredAt: "t1",
        });
        expect(bySource.get("Deadlock")).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Flagged,
        });
        expect(bySource.get("RuntimeSafetyEnvelope")).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: p10Child,
          dedupKey: "safety-stop:exe_b1",
        });
        expect(bySource.get("RecoveryEscalation")).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Child,
          dedupKey: "reconciliation-escalated:exe_b2:fp1",
        });
        expect(bySource.get("VerifierOrphan")).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: p10Leaf,
          dedupKey: "verifier-orphan:ver_b1",
        });
        expect(bySource.get("VacantProducer")).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: consumerWs,
          dedupKey: "vacant-producer:dep_bg1",
        });
        expect(bySource.get("VacantProducer")?.summaryRef).toContain(
          "vacant producer",
        );
        expect(
          rows.some((row) => row.dedupKey === "vacant-producer:dep_bg2"),
        ).toBe(false);
        expect(rows).toHaveLength(6);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("Story C — EffectiveFacts & freshness: watermark/lag exposed; barrier blocks-then-serves or refuses typed; no implicit RYW (write-then-read lags until the barrier forces convergence)", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000c1");

    const seed = seedCanonical(
      Effect.gen(function* () {
        yield* insertProjectRootRow(p10Root, p10Project);
        yield* insertWorkspaceRow(
          { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
          p10Project,
        );
        yield* insertWorkRow(
          { workId: work, workspaceId: p10Root, objective: "freshness" },
          p10Project,
        );
        yield* setCurrentWork(p10Root, work);
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000c1",
          projectId: p10Project,
          eventType: "WorkspaceCreated",
          payload: {},
          occurredAt: "t0",
        });
      }),
    );

    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seed;
        const deps = yield* makeP10Deps();
        const service = makeQueryService(deps);

        const current = yield* service.query<never, CurrentWorkRes>(
          "current-work",
          { workspaceId: p10Root } as never,
        );
        expect(current.watermark).toBe(1);
        expect(current.lag).toBe(0);

        yield* seedCanonical(
          Effect.gen(function* () {
            yield* insertEventRow({
              eventId: "evt_00000000-0000-7000-8000-0000000000c2",
              projectId: p10Project,
              eventType: "WorkspaceCreated",
              payload: {},
              occurredAt: "t1",
            });
            yield* insertEventRow({
              eventId: "evt_00000000-0000-7000-8000-0000000000c3",
              projectId: p10Project,
              eventType: "WorkspaceCreated",
              payload: {},
              occurredAt: "t2",
            });
          }),
        );
        const frontier = yield* deps.journalLastSequence(p10Project);
        expect(frontier).toBe(3);

        const holder = { watermark: 1 };
        const catchUpCalls: Array<readonly [number, number]> = [];
        const advancingFace = makeEffectiveFactsQueryFace(
          runtimeDepsOf(
            deps,
            () => Effect.succeed(holder.watermark),
            (_projectId, fromSequence, toSequence) =>
              Effect.sync(() => {
                catchUpCalls.push([fromSequence, toSequence] as const);
                holder.watermark = toSequence;
                return toSequence;
              }),
          ),
        );
        const inertFace = makeEffectiveFactsQueryFace(
          runtimeDepsOf(
            deps,
            () => Effect.succeed(holder.watermark),
            () => Effect.succeed(holder.watermark),
          ),
        );

        const plain = yield* advancingFace.query(p10Root);
        expect(plain.watermark).toBe(1);
        expect(plain.lag).toBe(2);
        expect(plain.value.workspaceId).toBe(p10Root);
        expect(plain.value.facts.currentWork?.objective).toBe("freshness");

        const refused = yield* Effect.flip(
          inertFace.query(p10Root, { minWatermark: 3 }),
        );
        expect(refused._tag).toBe("ProjectionStale");
        if (refused._tag === "ProjectionStale") {
          const stale = refused as ProjectionStale;
          expect(stale.code).toBe("projection/stale");
          expect(stale.safeDetails.watermark).toBe(1);
        }

        const forced = yield* advancingFace.query(p10Root, {
          minWatermark: 3,
        });
        expect(catchUpCalls).toEqual([[2, 3]]);
        expect(forced.watermark).toBe(3);
        expect(forced.lag).toBe(0);
      }),
      makeP10App(),
    );
  });

  it("Story D — six views: Detail ①–⑥ (audit timeline), Verification, Dependency, CurrentWork, Transcript paging, Usage aggregates (observe-only), Inbox unconsumed", async () => {
    const rootWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d1");
    const pendWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d2");
    const childWork = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d4");
    const exeRoot = "exe_00000000-0000-7000-8000-0000000000d1";
    const exeChild = "exe_00000000-0000-7000-8000-0000000000d2";

    const seed = seedCanonical(
      Effect.gen(function* () {
        yield* insertProjectRootRow(p10Root, p10Project);
        yield* insertWorkspaceRow(
          { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: rootWork,
            workspaceId: p10Root,
            objective: "current objective",
          },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: pendWork,
            workspaceId: p10Root,
            objective: "pending objective",
          },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d3"),
            workspaceId: p10Root,
            objective: "done",
            lifecycle: "Completed",
          },
          p10Project,
        );
        yield* insertWorkRow(
          {
            workId: childWork,
            workspaceId: p10Child,
            objective: "child objective",
          },
          p10Project,
        );
        yield* setCurrentWork(p10Root, rootWork);
        yield* insertExecutionRow(
          { executionId: exeRoot, workspaceId: p10Root, focusWorkId: rootWork },
          p10Project,
        );
        yield* insertExecutionRow(
          {
            executionId: exeChild,
            workspaceId: p10Child,
            focusWorkId: childWork,
          },
          p10Project,
        );

        yield* insertDependencyRow({
          dependencyId: "dep_dd1",
          consumerWorkId: rootWork,
          producerWorkspaceId: p10Child,
          state: "Unsatisfied",
        });
        yield* insertDependencyRow({
          dependencyId: "dep_dd2",
          consumerWorkId: childWork,
          producerWorkspaceId: p10Leaf,
          state: "Unsatisfied",
        });
        yield* insertDependencyRow({
          dependencyId: "dep_dd3",
          consumerWorkId: rootWork,
          producerWorkspaceId: p10Child,
          state: "Satisfied",
        });
        yield* insertDependencyRow({
          dependencyId: "dep_dd4",
          consumerWorkId: rootWork,
          producerWorkspaceId: p10Leaf,
          state: "Withdrawn",
        });

        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: "msg:msg_d1",
          kind: "Message",
          summary: "a report",
          admittedAt: "t1",
        });
        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: "msg:msg_d0",
          kind: "Message",
          summary: "old",
          admittedAt: "t0",
          consumedAt: "t1",
        });

        yield* insertVerificationRow({
          verificationId: "ver_d1",
          workId: rootWork,
          targetWorkRevision: 0,
          ownerWorkspaceId: p10Root,
          executionIds: [],
          state: "Open",
          criteria: [
            { criterionId: "c1", requirement: "tests pass", required: true },
            { criterionId: "c2", requirement: "lint clean", required: false },
          ],
        });
        yield* insertEvidenceRow({
          evidenceId: "evd_00000000-0000-7000-8000-0000000000d1",
          verificationId: "ver_d1",
          criterionId: "c1",
          kind: "Observation",
          recordedByExecutionId: exeRoot,
          recordedAt: "t3",
        });
        yield* insertAcceptanceRow({
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000d1",
          workId: rootWork,
          targetWorkRevision: 0,
          verificationId: "ver_d1",
          actor: "user:gov",
          acceptedAt: "t4",
        });

        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e1",
          projectId: p10Project,
          eventType: "WorkAssigned",
          payload: { workId: rootWork },
          occurredAt: "t1",
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e2",
          projectId: p10Project,
          eventType: "HumanInterventionApplied",
          payload: {
            actor: "user:gov",
            targetWorkspaceId: p10Root,
            summaryRef: "blob:s1",
            occurredAt: "t2",
            kind: "Steer",
          },
          occurredAt: "t2",
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e3",
          projectId: p10Project,
          eventType: "WorkSteered",
          payload: {
            workId: childWork,
            fromRevision: 0,
            toRevision: 1,
            severity: "Normal",
          },
          occurredAt: "t3",
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e4",
          projectId: p10Project,
          eventType: "WorkSteered",
          payload: {
            workId: rootWork,
            fromRevision: 0,
            toRevision: 1,
            severity: "Critical",
          },
          occurredAt: "t4",
        });
        yield* insertProposalRow({
          proposalId: "prp_00000000-0000-7000-8000-0000000000d1",
          parentWorkspaceId: p10Root,
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e5",
          projectId: p10Project,
          eventType: "DecisionRecorded",
          payload: {
            proposalId: "prp_00000000-0000-7000-8000-0000000000d1",
            proposalRevision: 1,
            decision: "Approve",
            decidedBy: "user:gov",
          },
          occurredAt: "t5",
        });
        yield* insertProposalRow({
          proposalId: "prp_00000000-0000-7000-8000-0000000000d2",
          parentWorkspaceId: p10Child,
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e6",
          projectId: p10Project,
          eventType: "DecisionRecorded",
          payload: {
            proposalId: "prp_00000000-0000-7000-8000-0000000000d2",
            proposalRevision: 1,
            decision: "Reject",
            decidedBy: "user:gov",
          },
          occurredAt: "t6",
        });
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-0000000000e7",
          projectId: p10Project,
          eventType: "HumanInterventionApplied",
          payload: {
            actor: "user:gov",
            targetWorkspaceId: p10Child,
            summaryRef: "blob:s2",
            occurredAt: "t7",
            kind: "Stop",
          },
          occurredAt: "t7",
        });

        const rootPrimary = `ses:${p10Root}`;
        const rootExec = `ses:exec:${exeRoot}`;
        const childPrimary = `ses:${p10Child}`;
        const entries: Array<[string, string, string]> = [
          [rootPrimary, "Input", "t1"],
          [rootPrimary, "ModelOutput", "t2"],
          [rootExec, "Input", "t3"],
          [rootExec, "Observation", "t4"],
          [rootExec, "CheckpointReference", "t5"],
        ];
        for (const [sessionId, entryKind, at] of entries) {
          yield* insertSessionEntryRow({
            sessionId,
            entryKind: entryKind as "Input",
            payload:
              entryKind === "CheckpointReference" ? { ref: "ckpt:1" } : {},
            createdAt: at,
          });
        }
        yield* insertProviderTurnRow({
          providerTurnId: "ptn_00000000-0000-7000-8000-0000000000d1",
          executionId: exeRoot,
          sessionId: rootExec,
          usage: { _tag: "UsageReported", inputTokens: 100, outputTokens: 50 },
          settledAt: "t2",
        });
        yield* insertProviderTurnRow({
          providerTurnId: "ptn_00000000-0000-7000-8000-0000000000d2",
          executionId: exeRoot,
          sessionId: rootExec,
          usage: {
            _tag: "UsageReported",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
          },
          settledAt: "t3",
        });
        yield* insertProviderTurnRow({
          providerTurnId: "ptn_00000000-0000-7000-8000-0000000000d3",
          executionId: exeRoot,
          sessionId: rootExec,
          usage: { _tag: "UsageReported", inputTokens: 999, outputTokens: 1 },
          settledAt: null,
        });
        yield* insertProviderTurnRow({
          providerTurnId: "ptn_00000000-0000-7000-8000-0000000000d4",
          executionId: exeChild,
          sessionId: childPrimary,
          usage: { _tag: "UsageReported", inputTokens: 7, outputTokens: 3 },
          settledAt: "t6",
        });
      }),
    );

    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seed;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const detail: WorkspaceDetailRes = yield* deriveWorkspaceDetail(
          p10Root,
          deps.workspaceDetail,
        );
        expect(detail.responsibility.purpose).toBe("p10");
        expect(detail.boundary.basisResponsibilityRevision).toBe(0);
        expect(detail.currentWork).toEqual({
          workId: rootWork,
          objective: "current objective",
          status: "Open",
          activeExecution: { executionId: exeRoot, admittedAt: "t0" },
        });
        expect(detail.pendingWorks).toEqual([
          { workId: pendWork, objective: "pending objective" },
        ]);
        expect(detail.dependencies).toEqual([
          {
            dependencyId: "dep_dd1",
            consumerWorkId: rootWork,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
            state: "Unsatisfied",
          },
          {
            dependencyId: "dep_dd3",
            consumerWorkId: rootWork,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
            state: "Satisfied",
          },
          {
            dependencyId: "dep_dd4",
            consumerWorkId: rootWork,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Leaf },
            state: "Withdrawn",
          },
        ]);
        expect(detail.inboxUnconsumed).toEqual([
          {
            entryKey: "msg:msg_d1",
            kind: "Message",
            summary: "a report",
            watermark: 7,
          },
        ]);
        expect(detail.verification?.criteriaResults).toHaveLength(2);
        expect(detail.verification?.evidenceRefs).toEqual([
          "evd_00000000-0000-7000-8000-0000000000d1",
        ]);
        expect(detail.verification?.acceptance?.acceptanceId).toBe(
          "acc_00000000-0000-7000-8000-0000000000d1",
        );
        expect(detail.auditTimeline).toEqual([
          { sequence: 2, eventType: "HumanInterventionApplied", at: "t2" },
          { sequence: 4, eventType: "WorkSteered", at: "t4" },
          { sequence: 5, eventType: "DecisionRecorded", at: "t5" },
        ]);

        const current: CurrentWorkRes = yield* deriveCurrentWork(
          p10Root,
          deps.currentWork,
        );
        expect(current).toEqual({
          workId: rootWork,
          objective: "current objective",
          status: "Open",
          activeExecution: { executionId: exeRoot, admittedAt: "t0" },
        });
        expect(yield* deriveCurrentWork(p10Child, deps.currentWork)).toBeNull();

        const verificationRes = yield* deriveVerificationView(
          rootWork,
          deps.verificationView,
        );
        expect(verificationRes.verificationId).toBe("ver_d1");
        expect(verificationRes.verdict).toBeUndefined();
        expect(
          verificationRes.criteriaResults.every((c) => c.verdict === "Unknown"),
        ).toBe(true);

        const byProject: DependencyRes = {
          rows: yield* deriveDependencyRows(
            { projectId: p10Project },
            deps.dependencyView,
          ),
        };
        expect(byProject.rows.map((row) => row.dependencyId)).toEqual([
          "dep_dd1",
          "dep_dd2",
          "dep_dd3",
          "dep_dd4",
        ]);
        const byWorkspace: DependencyRes = {
          rows: yield* deriveDependencyRows(
            { workspaceId: p10Root },
            deps.dependencyView,
          ),
        };
        expect(byWorkspace.rows.map((row) => row.dependencyId)).toEqual([
          "dep_dd1",
          "dep_dd3",
          "dep_dd4",
        ]);

        const pages: Array<ReadonlyArray<string>> = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page: TranscriptRes = yield* deriveTranscriptPage(
            { workspaceId: p10Root, cursor, limit: 2 },
            deps.transcript,
          );
          pages.push(page.entries.map((entry) => entry.kind));
          const checkpoint = page.entries.find(
            (entry) => entry.kind === "CheckpointReference",
          );
          if (checkpoint) {
            expect(checkpoint).toEqual({
              kind: "CheckpointReference",
              summaryRef: "ckpt:1",
              at: "t5",
            });
          }
          cursor = page.nextCursor;
          guard += 1;
          expect(guard).toBeLessThan(10);
        } while (cursor !== undefined);
        expect(pages).toEqual([
          ["Input", "Observation"],
          ["CheckpointReference", "Input"],
          ["ModelOutput"],
        ]);

        const byWorkspaceUsage: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "workspace" },
            deps.usage,
          ),
        };
        const usageOf = new Map(
          byWorkspaceUsage.rows.map((row) => [row.workspaceId, row]),
        );
        expect(usageOf.get(p10Root)).toEqual({
          workspaceId: p10Root,
          tokens: 168,
          cost: { _tag: "Unknown", reason: "PricingUnavailable" },
          turns: 2,
        });
        expect(usageOf.get(p10Child)).toEqual({
          workspaceId: p10Child,
          tokens: 10,
          cost: { _tag: "Unknown", reason: "PricingUnavailable" },
          turns: 1,
        });
        expect(usageOf.get(p10Leaf)).toEqual({
          workspaceId: p10Leaf,
          tokens: 0,
          cost: { _tag: "Unknown", reason: "UsageUnavailable" },
          turns: 0,
        });
        const bySubtree: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "subtree" },
            deps.usage,
          ),
        };
        expect(
          bySubtree.rows.find((row) => row.workspaceId === p10Root)?.tokens,
        ).toBe(178);
        const byProjectUsage: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "project" },
            deps.usage,
          ),
        };
        expect(byProjectUsage.rows).toEqual([
          {
            workspaceId: p10Root,
            tokens: 178,
            cost: { _tag: "Unknown", reason: "PricingUnavailable" },
            turns: 3,
          },
        ]);

        const inbox: InboxViewRes = yield* deriveInboxView(
          p10Root,
          deps.inboxView,
        );
        expect(inbox.unconsumed).toEqual([
          {
            entryKey: "msg:msg_d1",
            kind: "Message",
            summary: "a report",
            watermark: 7,
          },
        ]);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("Story E — Rebuild at scale: drift → orchestrated rebuild → RB-4 per-view equality; checkpoint resume from the persisted crash point; journal horizon untouched (negative)", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000e1");
    const dep = "dep_00000000-0000-7000-8000-0000000000e1";
    const msg = "msg_00000000-0000-7000-8000-0000000000e1";

    const consumerIdOf = (stage: (typeof REBUILD_STAGE_ORDER)[number]) =>
      `p10-acceptance-rebuild:${stage}`;

    const makeApp = () => {
      const base = layer({ filename: ":memory:" });
      const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
      const stores = Layer.mergeAll(
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(WorkspaceRepositoryLive, infra),
        Layer.provide(WorkRepositoryLive, infra),
        Layer.provide(ExecutionRepositoryLive, infra),
        Layer.provide(WorkWaitStoreLive, infra),
        Layer.provide(DependencyRepositoryLive, infra),
        Layer.provide(VerificationRepositoryLive, infra),
        Layer.provide(EvidenceRepositoryLive, infra),
        Layer.provide(AcceptanceRepositoryLive, infra),
        Layer.provide(DomainEventJournalLive, infra),
        Layer.provide(MessageStoreLive, infra),
        Layer.provide(InboxProjectionStoreLive, infra),
        Layer.provide(ConsumerOffsetStoreLive, infra),
        Layer.provide(ConsumerDeadLetterStoreLive, infra),
        Layer.provide(ProjectionStoreLive, infra),
      );
      return Layer.mergeAll(
        infra,
        stores,
        Layer.provide(DependencyAwareRunnableWorkSourceLive, stores),
      ) as unknown as Layer.Layer<SqlClient>;
    };

    const run = <A, R>(program: Effect.Effect<A, unknown, R>): Promise<A> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            program as Effect.Effect<A, unknown, SqlClient>,
            makeApp(),
          ),
        ),
      );

    const makeHarness = (
      wrapCatchUp?: (
        inner: RebuildOrchestrationDeps["catchUpView"],
      ) => RebuildOrchestrationDeps["catchUpView"],
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const offsets = yield* ConsumerOffsetStore;
        const journal = yield* DomainEventJournal;
        const deadLetters = yield* ConsumerDeadLetterStore;
        const projection = yield* ProjectionStore;
        const fixture = yield* makeP10Deps();

        const prunedFloor = (projectId: typeof p10Project) =>
          Effect.map(
            sql.unsafe<{ floor: number | null }>(
              "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
              [projectId],
            ),
            (rows) => Number(rows[0]?.floor ?? 0),
          ).pipe(Effect.mapError(projectionReadError));

        const baseCatchUp: RebuildOrchestrationDeps["catchUpView"] = (
          stage,
          projectId,
          batchSize,
        ) =>
          Effect.map(
            runConsumerBatch(
              consumerIdOf(stage),
              projectId,
              batchSize ?? 100,
            ).pipe(
              Effect.provideService(TransactionPort, tx),
              Effect.provideService(DomainEventJournal, journal),
              Effect.provideService(ConsumerOffsetStore, offsets),
              Effect.provideService(ConsumerDeadLetterStore, deadLetters),
              Effect.provideService(ProjectionStore, projection),
              Effect.mapError(projectionReadError),
            ),
            (result) => result,
          );

        const deps: RebuildOrchestrationDeps = {
          prunedFloor,
          journalLastSequence: fixture.journalLastSequence,
          readViewCheckpoint: (stage, projectId) =>
            Effect.mapError(
              tx.transact(offsets.read(consumerIdOf(stage), projectId)),
              projectionReadError,
            ),
          catchUpView:
            wrapCatchUp === undefined ? baseCatchUp : wrapCatchUp(baseCatchUp),
          rebuildView: (stage, projectId) =>
            Effect.mapError(
              rebuildProjection(consumerIdOf(stage), projectId).pipe(
                Effect.provideService(TransactionPort, tx),
                Effect.provideService(DomainEventJournal, journal),
                Effect.provideService(ConsumerOffsetStore, offsets),
                Effect.provideService(ConsumerDeadLetterStore, deadLetters),
                Effect.provideService(ProjectionStore, projection),
                Effect.provideService(SqlClient, sql),
              ),
              projectionReadError,
            ),
          forceResetView: (stage, projectId) =>
            Effect.mapError(
              tx.transact(
                Effect.gen(function* () {
                  yield* projection.reset();
                  const floor = yield* prunedFloor(projectId);
                  const rewoundTo = Math.max(floor - 1, 0);
                  yield* offsets.advance(
                    consumerIdOf(stage),
                    projectId,
                    rewoundTo,
                  );
                  return { rewoundTo };
                }),
              ),
              projectionReadError,
            ),
          listWorkspaces: (projectId) =>
            Effect.map(
              fixture.tree.listWorkspacesByProject(projectId),
              (workspaces) =>
                workspaces.map((workspace) => ({
                  workspaceId: workspace.workspaceId,
                })),
            ),
          reconcileInbox: (workspaceId) =>
            reconcileInbox(workspaceId, fixture.inboxReconcile),
        };

        const offsetOf = (
          stage: (typeof REBUILD_STAGE_ORDER)[number],
        ): Effect.Effect<number, unknown, never> =>
          Effect.map(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
              [consumerIdOf(stage), p10Project],
            ),
            (rows) => Number(rows[0]?.last_sequence ?? 0),
          );

        return { deps, fixture, offsetOf };
      });

    const seedBase = seedCanonical(
      Effect.gen(function* () {
        yield* insertProjectRootRow(p10Root, p10Project);
        yield* insertWorkspaceRow(
          { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
          p10Project,
        );
        yield* insertWorkspaceRow(
          { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
          p10Project,
        );
        yield* insertWorkRow(
          { workId: work, workspaceId: p10Root, objective: "rebuild" },
          p10Project,
        );
        yield* setCurrentWork(p10Root, work);
        yield* insertDependencyRow({
          dependencyId: dep,
          consumerWorkId: work,
          producerWorkspaceId: p10Child,
        });
        yield* insertMessageRow({
          messageId: msg,
          senderWorkspaceId: p10Child,
          recipientWorkspaceId: p10Root,
          kind: "Report",
          bodyRef: "blob:r1",
          sentAt: "t2",
        });
      }),
    );

    const neutralEvent = (n: number) =>
      insertEventRow({
        eventId: `evt_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
        projectId: p10Project,
        eventType: "ProjectPolicyChanged",
        payload: { n },
        occurredAt: `t${n}`,
      });

    const unfulfillableEvent = insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-000000000004",
      projectId: p10Project,
      eventType: "DependencyMarkedUnfulfillable",
      payload: { dependencyId: dep, dependencyRevision: 0 },
      occurredAt: "t4",
    });

    const seedJournal = seedCanonical(
      Effect.gen(function* () {
        yield* neutralEvent(1);
        yield* neutralEvent(2);
        yield* neutralEvent(3);
        yield* unfulfillableEvent;
        yield* neutralEvent(5);
        yield* neutralEvent(6);
      }),
    );

    interface ViewStates {
      readonly attention: ReadonlyArray<AttentionRow>;
      readonly effectiveFacts: EffectiveFactsSnapshot;
      readonly tree: TreeViewNode;
      readonly usage: ReadonlyArray<UsageRowView>;
    }

    const captureViews = (
      fixture: P10FixtureDeps,
    ): Effect.Effect<ViewStates, unknown, SqlClient> =>
      Effect.gen(function* () {
        return {
          attention: yield* deriveProjectAttention(
            p10Project,
            fixture.attention,
          ),
          effectiveFacts: yield* deriveEffectiveFacts(
            p10Root,
            fixture.effectiveFacts,
          ),
          tree: yield* buildTreeView({ projectId: p10Project }, fixture.tree),
          usage: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "workspace" },
            fixture.usage,
          ),
        };
      });

    const CANONICAL_TABLES = [
      "domain_events",
      "project_event_sequences",
      "projects",
      "workspaces",
      "works",
      "dependencies",
      "messages",
      "inbox_entries",
      "sessions",
      "executions",
      "verifications",
    ];

    const snapshotTables = (
      tables: ReadonlyArray<string>,
    ): Effect.Effect<Record<string, string>, unknown, SqlClient> =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const out: Record<string, string> = {};
        for (const table of tables) {
          const rows = yield* sql.unsafe<Record<string, unknown>>(
            `SELECT * FROM "${table}" ORDER BY rowid`,
          );
          out[table] = JSON.stringify(rows);
        }
        return out;
      });

    const regressAttentionWatermark = Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE consumer_offsets SET last_sequence = 1 WHERE consumer_id = ?",
        [consumerIdOf("attention")],
      );
    });

    const pruneBelowFloor = (floor: number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "DELETE FROM domain_events WHERE project_id = ? AND sequence < ?",
          [p10Project, floor],
        );
      });

    await run(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        const h = yield* makeHarness();

        for (const n of [1, 2, 3, 4, 5, 6]) {
          yield* seedCanonical(n === 4 ? unfulfillableEvent : neutralEvent(n));
          for (const stage of REBUILD_STAGE_ORDER) {
            for (;;) {
              const result = yield* h.deps.catchUpView(stage, p10Project, 100);
              if (result.applied + result.quarantined === 0) {
                break;
              }
            }
          }
        }
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }
        const incremental = yield* captureViews(h.fixture);

        yield* pruneBelowFloor(3);
        yield* regressAttentionWatermark;
        const beforeRebuild = yield* snapshotTables(CANONICAL_TABLES);

        const { drift, report } = yield* rebuildOnDetectedDrift(
          h.deps,
          p10Project,
        );
        expect(drift).toEqual([
          { stage: "attention", watermark: 1, prunedFloor: 3 },
        ]);
        const attentionStage = report.stages.find(
          (stage) => stage.stage === "attention",
        )!;
        expect(attentionStage.driftReset).toBe(true);
        expect(attentionStage.resetRewoundTo).toBe(2);
        expect(attentionStage.replayed).toBe(4);
        expect(attentionStage.toWatermark).toBe(6);
        for (const stage of report.stages.filter(
          (entry) => entry.stage !== "attention",
        )) {
          expect(stage.driftReset).toBe(false);
          expect(stage.replayed).toBe(0);
        }
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }

        const sql = yield* SqlClient;
        const floorRows = yield* sql.unsafe<{ floor: number | null }>(
          "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
          [p10Project],
        );
        expect(Number(floorRows[0]?.floor ?? 0)).toBe(3);
        expect(yield* snapshotTables(CANONICAL_TABLES)).toEqual(beforeRebuild);

        const rebuilt = yield* captureViews(h.fixture);
        expect(
          compareProjectionState(
            "attention",
            rebuilt.attention,
            incremental.attention,
          ).equal,
        ).toBe(true);
        expect(
          compareProjectionState(
            "effective-facts",
            rebuilt.effectiveFacts,
            incremental.effectiveFacts,
          ).equal,
        ).toBe(true);
        expect(
          compareProjectionState("tree", rebuilt.tree, incremental.tree).equal,
        ).toBe(true);
        expect(
          compareProjectionState("usage", rebuilt.usage, incremental.usage)
            .equal,
        ).toBe(true);
      }),
    );

    await run(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedJournal;
        const sql = yield* SqlClient;

        const primed = yield* makeHarness();
        for (const stage of REBUILD_STAGE_ORDER) {
          const result = yield* primed.deps.catchUpView(stage, p10Project, 2);
          expect(result.applied).toBe(2);
        }

        let crashDischarged = false;
        const h = yield* makeHarness(
          (inner) => (stage, projectId, _batchSize) =>
            inner(stage, projectId, 2).pipe(
              Effect.flatMap((result) => {
                if (
                  !crashDischarged &&
                  result.applied + result.quarantined > 0
                ) {
                  crashDischarged = true;
                  return Effect.fail(
                    projectionReadError("crash injected mid-rebuild"),
                  );
                }
                return Effect.succeed(result);
              }),
            ),
        );
        const failure = yield* Effect.flip(
          orchestrateRebuild(h.deps, {
            projectId: p10Project,
            trigger: "drift-detected",
          }),
        );
        expect(failure._tag).toBe("ProjectionReadFailure");

        const offset = (consumerId: string) =>
          Effect.map(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ?",
              [consumerId],
            ),
            (rows) => Number(rows[0]?.last_sequence ?? 0),
          );
        expect(yield* offset(consumerIdOf("raw-facts"))).toBe(4);
        expect(yield* offset(consumerIdOf("effective-facts"))).toBe(2);

        const resumed = yield* makeHarness();
        const report = yield* orchestrateRebuild(resumed.deps, {
          projectId: p10Project,
          trigger: "drift-detected",
        });
        const rawFactsStage = report.stages.find(
          (stage) => stage.stage === "raw-facts",
        )!;
        expect(rawFactsStage.fromWatermark).toBe(4);
        expect(rawFactsStage.replayed).toBe(2);
        expect(rawFactsStage.toWatermark).toBe(6);
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* offset(consumerIdOf(stage))).toBe(6);
        }

        const views = yield* captureViews(resumed.fixture);
        const unfulfillable = views.attention.filter(
          (row) => row.source === "DependencyUnfulfillable",
        );
        expect(unfulfillable).toHaveLength(1);
        expect(unfulfillable[0]!.dedupKey).toBe(`unfulfillable:${dep}:0`);
      }),
    );
  });

  it("Story F — Human intervention facts: steer both kinds paired same-transaction; four governance human branches emit the fact; agent submissions emit nothing; the Stop branch stays wire-only", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
    const assignCmd = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
    );
    const cmd = (suffix: string) =>
      parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
    const verificationId = parse(VerificationId)(
      "ver_00000000-0000-7000-8000-0000000000f1",
    );
    const mission: VerificationMission = {
      goal: "g",
      criteria: [],
      riskRequirements: [],
    };
    const humanActor = p7TestActor;
    const humanPrincipal = p7TestPrincipal;
    const agentPrincipal = parse(Principal)("agent:bot");
    const agentActor = parse(Actor)("agent:bot");

    const seed = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* p7SeedProject;
      const receipt = yield* p7SeedWork(work, assignCmd);
      expect(receipt.resolution._tag).toBe("Committed");
    });

    const journalEvents = (eventType: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{
          payload_json: string;
          caused_by_command_id: string;
        }>(
          "SELECT payload_json, caused_by_command_id FROM domain_events WHERE event_type = ? ORDER BY sequence",
          [eventType],
        );
        return rows.map((row) => ({
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
          causedByCommandId: row.caused_by_command_id,
        }));
      });

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;

        const steerPayload = (
          severity: "Normal" | "Critical",
          revision: number,
        ) => ({
          workId: work,
          workspaceId: p7RootWorkspace,
          steer: { severity, guidance: `cnt-acc-steer-${severity}` },
          expectedWorkRevision: parse(WorkRevision)(revision),
          provenance: { source: "HumanInput" as const },
        });
        const submitSteer = (
          commandId: CommandId,
          payload: ReturnType<typeof steerPayload>,
          principal: Principal = humanPrincipal,
          actor: Actor = humanActor,
        ) => {
          const authority: VerifiedCommandAuthority = {
            _tag: "SteerWorkAuthority",
            principal,
            commandId,
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "SteerWork",
              projectId: p7Project,
              actor,
              schemaVersion: "1",
              payload,
            }),
            projectId: p7Project,
            targetWorkspaceId: payload.workspaceId,
            workId: payload.workId,
          };
          return gw.execute(
            {
              commandType: "SteerWork",
              commandId,
              projectId: p7Project,
              actor,
              issuedAt: "t",
              payload,
            },
            { _tag: "External", principal },
            authority,
          );
        };

        const normalCmd = cmd("0000000000f1");
        const normal = yield* submitSteer(normalCmd, steerPayload("Normal", 0));
        expect(normal.resolution._tag).toBe("Committed");
        const criticalCmd = cmd("0000000000f2");
        const critical = yield* submitSteer(
          criticalCmd,
          steerPayload("Critical", 1),
        );
        expect(critical.resolution._tag).toBe("Committed");
        const agentSteer = yield* submitSteer(
          cmd("0000000000f3"),
          steerPayload("Normal", 2),
          agentPrincipal,
          agentActor,
        );
        expect(agentSteer.resolution._tag).toBe("TerminalRejected");

        const steered = yield* journalEvents("WorkSteered");
        const interventions = yield* journalEvents("HumanInterventionApplied");
        expect(steered).toHaveLength(2);
        expect(interventions).toHaveLength(2);
        expect(steered[0]!.payload).toEqual({
          workId: work,
          fromRevision: 0,
          toRevision: 1,
          severity: "Normal",
        });
        expect(steered[1]!.payload).toEqual({
          workId: work,
          fromRevision: 1,
          toRevision: 2,
          severity: "Critical",
        });
        expect(interventions[0]!.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "cnt-acc-steer-Normal",
          occurredAt: "t",
          kind: "Steer",
        });
        expect(interventions[1]!.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "cnt-acc-steer-Critical",
          occurredAt: "t",
          kind: "CriticalSteer",
        });
        expect(steered[0]!.causedByCommandId).toBe(normalCmd);
        expect(interventions[0]!.causedByCommandId).toBe(normalCmd);
        expect(steered[1]!.causedByCommandId).toBe(criticalCmd);
        expect(interventions[1]!.causedByCommandId).toBe(criticalCmd);

        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        const proposals = yield* FormationProposalStore;
        const inbox = yield* InboxProjectionStore;
        const works = yield* WorkRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        const dependencies = yield* DependencyRepository;

        const proposalOf = (id: string) =>
          admitFormationProposal({
            proposalId: id as never,
            parentWorkspaceId: p7RootWorkspace,
            proposal: {
              name: "child",
              responsibilityDraft: {
                purpose: "p",
                ownedResponsibilities: [],
                obligations: [],
                includes: [],
                excludes: [],
                interfaces: [],
              },
              resourceBoundaryDraft: {
                basisResponsibilityRevision: 0 as never,
                addresses: [],
              },
              rationale: "p10-acceptance",
            },
          });
        const humanProposal = proposalOf(
          "fpr_00000000-0000-7000-8000-0000000000f1",
        );
        const agentProposal = proposalOf(
          "fpr_00000000-0000-7000-8000-0000000000f2",
        );
        yield* tx.transact(proposals.insert(humanProposal));
        yield* tx.transact(proposals.insert(agentProposal));
        const recordDecision = makeRecordDecisionHandler({
          proposals,
          inbox,
          originatingWorkspaceOf: (record) => record.parentWorkspaceId,
        });
        const decisionPayload = (
          proposalId: string,
          outcome: "Approve" | "Reject",
        ): RecordDecisionPayload => ({
          proposalId: proposalId as never,
          expectedProposalRevision: 1,
          outcome: { _tag: outcome },
        });
        const humanDecision = yield* tx.transact(
          recordDecision.execute(
            {
              commandType: "RecordDecision",
              commandId: cmd("0000000000f4"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: decisionPayload(humanProposal.proposalId, "Approve"),
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanDecision.ok).toBe(true);
        if (humanDecision.ok) {
          expect(humanDecision.value.events).toHaveLength(2);
          const fact = humanDecision.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef:
              "formation proposal fpr_00000000-0000-7000-8000-0000000000f1 approved at revision 1",
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
          expect(fact.causedByCommandId).toBe(cmd("0000000000f4"));
        }
        const agentDecision = yield* tx.transact(
          recordDecision.execute(
            {
              commandType: "RecordDecision",
              commandId: cmd("0000000000f5"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: decisionPayload(agentProposal.proposalId, "Reject"),
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentDecision.ok).toBe(true);
        if (agentDecision.ok) {
          expect(
            agentDecision.value.events.filter(
              (event) => event.eventType === "HumanInterventionApplied",
            ),
          ).toHaveLength(0);
        }

        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId,
              workId: work,
              targetWorkRevision: parse(WorkRevision)(2),
              missionSnapshot: mission,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(verificationId, "Pass", undefined),
        );
        const acceptWork = makeAcceptWorkOutcomeHandler({
          works,
          verifications,
          acceptances,
        });
        const acceptPayload: AcceptWorkOutcomePayload = {
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000f1" as never,
          workId: work,
          targetWorkRevision: parse(WorkRevision)(2),
          verificationId,
        };
        const humanAccept = yield* tx.transact(
          acceptWork.execute(
            {
              commandType: "AcceptWorkOutcome",
              commandId: cmd("0000000000f6"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: acceptPayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanAccept.ok).toBe(true);
        if (humanAccept.ok) {
          const fact = humanAccept.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef: `work outcome accepted: ${work} at revision 2`,
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
        }

        const seedDependency = (dependencyId: string) =>
          sql.unsafe(
            "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
              dependencyId,
              p7Project,
              work,
              JSON.stringify({
                _tag: "WorkspaceBound",
                workspaceId: p7RootWorkspace,
              }),
              JSON.stringify({ kind: "report", requiredArtifactRoles: [] }),
              0,
              "Unsatisfied",
              null,
              null,
              "t0",
              "t0",
            ],
          );
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa1");
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa2");
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa3");
        const withdraw = makeWithdrawDependencyHandler({
          dependencies,
          works,
        });
        const mark = makeMarkDependencyUnfulfillableHandler({
          dependencies,
          works,
        });
        const humanWithdraw = yield* tx.transact(
          withdraw.execute(
            {
              commandType: "WithdrawDependency",
              commandId: cmd("0000000000f7"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa1",
                targetDependencyRevision: 0,
                reason: "no longer needed",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanWithdraw.ok).toBe(true);
        if (humanWithdraw.ok) {
          const fact = humanWithdraw.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
            summaryRef:
              "dependency dep_00000000-0000-7000-8000-000000000fa1 withdrawn: no longer needed",
          });
        }
        const humanMark = yield* tx.transact(
          mark.execute(
            {
              commandType: "MarkDependencyUnfulfillable",
              commandId: cmd("0000000000f8"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa2",
                targetDependencyRevision: 0,
                justification: "confirmed unfulfillable",
              } as MarkDependencyUnfulfillablePayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanMark.ok).toBe(true);
        if (humanMark.ok) {
          const fact = humanMark.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
          });
        }
        const agentWithdraw = yield* tx.transact(
          withdraw.execute(
            {
              commandType: "WithdrawDependency",
              commandId: cmd("0000000000f9"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa3",
                targetDependencyRevision: 0,
                reason: "agent path",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentWithdraw.ok).toBe(true);
        if (agentWithdraw.ok) {
          expect(
            agentWithdraw.value.events.filter(
              (event) => event.eventType === "HumanInterventionApplied",
            ),
          ).toHaveLength(0);
        }

        expect(HUMAN_STOP_EMISSION_PRECONDITION).toBe(
          "resolver-admitted (P12, GQ4)",
        );
        const stopFact = humanStopInterventionEvent({
          projectId: p7Project,
          commandId: cmd("0000000000fa"),
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "stop reason",
          occurredAt: "t",
        });
        expect(stopFact.eventType).toBe("HumanInterventionApplied");
        expect(stopFact.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "stop reason",
          occurredAt: "t",
          kind: "Stop",
        });
        const allInterventions = yield* journalEvents(
          "HumanInterventionApplied",
        );
        expect(
          allInterventions.filter((event) => event.payload.kind === "Stop"),
        ).toHaveLength(0);
      }),
      makeP7App(),
    );
  });

  it("Story G — Action surfaces: message-mediated Query lands the Inbox consumable; Steer/Stop/Governance via the gateway only; frozen Stop typed rejection; P12 negative (no HTTP/WS/CLI)", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");
    const assignCmd = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const childWs = parse(WorkspaceId)(
      "ws_018f2b3c-4d5e-7abc-8def-0123456789b2",
    );
    const queryMsg = parse(MessageId)(
      "msg_018f2b3c-4d5e-7abc-8def-0123456789b3",
    );
    const cmd = (suffix: string) =>
      parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
    const stopExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789b4";

    const seed = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* p7SeedProject;
      const receipt = yield* p7SeedWork(work, assignCmd);
      expect(receipt.resolution._tag).toBe("Committed");
      yield* seedCanonical(
        insertWorkspaceRow(
          {
            workspaceId: childWs,
            parentWorkspaceId: p7RootWorkspace,
            name: "child",
          },
          p7Project,
        ),
      );
    });

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const fingerprintPayload = {
          messageId: queryMsg,
          senderWorkspaceId: childWs,
          message: {
            kind: "Query",
            recipientWorkspaceId: p7RootWorkspace,
            bodyRef: "blob:what-is-your-current-work",
            urgency: "Normal",
            correlationId: "corr-acc-q1",
          },
        };
        const authority = {
          _tag: "SendMessageAuthority",
          principal: p7TestPrincipal,
          commandId: cmd("0000000000b1"),
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "SendMessage",
            projectId: p7Project,
            actor: p7TestActor,
            schemaVersion: "1",
            payload: fingerprintPayload,
          }),
          projectId: p7Project,
          senderWorkspaceId: childWs,
        };
        const receipt = yield* submitQueryRequest(gw as ActionGateway, {
          commandId: cmd("0000000000b1"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          messageId: queryMsg,
          senderWorkspaceId: childWs,
          targetWorkspaceId: p7RootWorkspace,
          bodyRef: "blob:what-is-your-current-work",
          correlationId: "corr-acc-q1",
          authority,
        });
        expect(receipt.resolution._tag).toBe("Committed");

        const tx = yield* TransactionPort;
        const inbox = yield* InboxProjectionStore;
        const unconsumed = yield* tx.transact(
          inbox.listUnconsumed(p7RootWorkspace),
        );
        const entry = unconsumed.find(
          (candidate) => candidate.entryKey === `msg:${queryMsg}`,
        );
        expect(entry).toBeDefined();
        expect(entry!.kind).toBe("Message");
        expect(entry!.summary).toContain("Query");

        const sql = yield* SqlClient;
        const executions = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions",
        );
        expect(Number(executions[0]?.count ?? 0)).toBe(0);

        yield* tx.transact(
          inbox.markConsumed(p7RootWorkspace, `msg:${queryMsg}`),
        );
        const after = yield* tx.transact(inbox.listUnconsumed(p7RootWorkspace));
        expect(
          after.filter((candidate) => candidate.entryKey === `msg:${queryMsg}`),
        ).toHaveLength(0);
      }),
      makeP7App(),
    );

    interface RecordedSubmission {
      readonly commandType: string;
      readonly payload: unknown;
      readonly principal: string;
    }
    const submissions: Array<RecordedSubmission> = [];
    const gateway: ActionGateway = {
      execute: (envelope, context) =>
        Effect.sync(() => {
          submissions.push({
            commandType: envelope.commandType,
            payload: envelope.payload,
            principal: context.principal,
          });
          return { resolution: { _tag: "Committed" } } as ActionReceipt;
        }),
    };

    const steer = await Effect.runPromise(
      steerRequest(gateway, {
        commandId: cmd("0000000000b2"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        workId: work,
        workspaceId: p7RootWorkspace,
        expectedWorkRevision: parse(WorkRevision)(0),
        severity: "Critical",
        guidance: "cnt-acc-governance-steer",
        authority: {
          _tag: "SteerWorkAuthority",
          principal: p7TestPrincipal,
          targetWorkspaceId: p7RootWorkspace,
          workId: work,
        },
      }),
    );
    expect(steer.resolution._tag).toBe("Committed");
    expect(submissions[0]).toEqual({
      commandType: "SteerWork",
      payload: {
        workId: work,
        workspaceId: p7RootWorkspace,
        steer: { severity: "Critical", guidance: "cnt-acc-governance-steer" },
        expectedWorkRevision: parse(WorkRevision)(0),
        provenance: { source: "HumanInput" },
      },
      principal: p7TestPrincipal,
    });

    const stop = await Effect.runPromise(
      stopRequest(gateway, {
        commandId: cmd("0000000000b3"),
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        executionId: stopExecutionId,
        authority: {
          _tag: "StopExecutionAuthority",
          principal: p7TestPrincipal,
          executionId: stopExecutionId,
        },
      }),
    );
    expect(stop.resolution._tag).toBe("Committed");
    expect(submissions[1]).toEqual({
      commandType: "StopExecution",
      payload: { executionId: stopExecutionId },
      principal: p7TestPrincipal,
    });

    const governanceEntries: ReadonlyArray<{
      readonly entry: Parameters<typeof governanceEntryRequest>[1]["entry"];
    }> = [
      {
        entry: {
          kind: "FormationApproval",
          proposalId: "fpr_00000000-0000-7000-8000-0000000000b1" as never,
          expectedProposalRevision: 1,
          outcome: "Approve",
        },
      },
      {
        entry: {
          kind: "AcceptWorkOutcome",
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000b2" as never,
          workId: work,
          targetWorkRevision: parse(WorkRevision)(0),
          verificationId: "ver_00000000-0000-7000-8000-0000000000b2" as never,
        },
      },
      {
        entry: {
          kind: "WithdrawDependency",
          dependencyId: "dep_00000000-0000-7000-8000-0000000000b3" as never,
          targetDependencyRevision: 0,
          reason: "no longer required",
        },
      },
      {
        entry: {
          kind: "MarkDependencyUnfulfillable",
          dependencyId: "dep_00000000-0000-7000-8000-0000000000b4" as never,
          targetDependencyRevision: 0,
          justification: "adjudicated unfulfillable",
        },
      },
    ];
    for (const [index, testCase] of governanceEntries.entries()) {
      const receipt = await Effect.runPromise(
        governanceEntryRequest(gateway, {
          commandId: cmd(`0000000000b${4 + index}`),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          entry: testCase.entry,
          authority: {
            _tag: "GovernanceAuthority",
            principal: p7TestPrincipal,
          },
        }),
      );
      expect(receipt.resolution._tag).toBe("Committed");
    }
    expect(submissions.map((submission) => submission.commandType)).toEqual([
      "SteerWork",
      "StopExecution",
      "RecordDecision",
      "AcceptWorkOutcome",
      "WithdrawDependency",
      "MarkDependencyUnfulfillable",
    ]);
    for (const submission of submissions.slice(2)) {
      expect(submission.principal).toBe(p7TestPrincipal);
    }

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const receipt = yield* stopRequest(gw as ActionGateway, {
          commandId: cmd("0000000000b9"),
          projectId: p7Project,
          actor: p7TestActor,
          issuedAt: "t",
          executionId: stopExecutionId,
          authority: {
            _tag: "StopExecutionAuthority",
            principal: p7TestPrincipal,
            executionId: stopExecutionId,
            submissionOrigin: "System",
          },
        });
        expect(receipt.resolution._tag).toBe("TerminalRejected");
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM executions WHERE stop_requested_at IS NOT NULL",
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      }),
      makeP7App(),
    );

    const repoRoot = join(import.meta.dirname, "..");
    const transportRe =
      /(^node:http$|^node:https$|^node:ws$|^node:readline$|^node:repl$|^ws$|^express$|^fastify$|^socket\.io$|^@fastify\/|^commander$|^yargs$|^clipanion$)/;
    const walk = (
      dir: string,
      sink: Array<string> = [],
    ): ReadonlyArray<string> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "dist" || entry.name === "node_modules") {
          continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, sink);
        } else if (entry.name.endsWith(".ts")) {
          sink.push(path);
        }
      }
      return sink;
    };
    for (const tree of [
      "packages/projection-runtime/src",
      "packages/api-contracts/src",
    ]) {
      for (const file of walk(join(repoRoot, tree))) {
        const source = readFileSync(file, "utf8");
        const importRe = /from\s+"([^"]+)"/g;
        for (const match of source.matchAll(importRe)) {
          const specifier = match[1] ?? "";
          expect(
            transportRe.test(specifier),
            `${file}: forbidden transport import "${specifier}"`,
          ).toBe(false);
        }
      }
    }
    expect(existsSync(join(repoRoot, "apps/web"))).toBe(false);
    const actions = readFileSync(
      join(repoRoot, "packages/projection-runtime/src/actions.ts"),
      "utf8",
    );
    expect(actions.includes('"AdmitExecution"')).toBe(false);
    expect(actions.includes("admitExecution")).toBe(false);
  });
});

describe("p10-acceptance mechanical assertion list (07 Mechanical)", () => {
  it("ViewId set equals the 01 must-set exactly; the dispatch switch is exhaustive", () => {
    expect([...VIEW_IDS]).toEqual([
      "responsibility-tree",
      "attention",
      "workspace-detail",
      "current-work",
      "verification",
      "dependency-view",
      "transcript",
      "usage",
      "inbox-view",
    ]);
    const exhaustive = (view: ViewId): 1 => {
      switch (view) {
        case "responsibility-tree":
        case "attention":
        case "workspace-detail":
        case "current-work":
        case "verification":
        case "dependency-view":
        case "transcript":
        case "usage":
        case "inbox-view":
          return 1;
      }
    };
    for (const view of VIEW_IDS) {
      expect(exhaustive(view)).toBe(1);
    }
  });

  it("WorkspaceStatus label map: six frozen labels; exhaustive switch incl. the retired terminal", () => {
    expect([...WORKSPACE_STATUS_LABELS]).toEqual([
      "executing",
      "waiting-runnable",
      "waiting-blocked",
      "idle",
      "retired",
      "attention-flagged",
    ]);
    const exhaustive = (label: WorkspaceStatusLabel): 1 => {
      switch (label) {
        case "executing":
        case "waiting-runnable":
        case "waiting-blocked":
        case "idle":
        case "retired":
        case "attention-flagged":
          return 1;
      }
    };
    for (const label of WORKSPACE_STATUS_LABELS) {
      expect(exhaustive(label)).toBe(1);
    }
  });

  it("P14 consume-only: no promptPrograms redefinition in the P10 tree; the six P8/P6-frozen families stand untouched", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const walk = (
      dir: string,
      sink: Array<string> = [],
    ): ReadonlyArray<string> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, sink);
        } else if (entry.name.endsWith(".ts")) {
          sink.push(path);
        }
      }
      return sink;
    };
    for (const tree of [
      "packages/projection-runtime/src",
      "packages/api-contracts/src",
    ]) {
      for (const file of walk(join(repoRoot, tree))) {
        expect(
          readFileSync(file, "utf8").includes("promptPrograms"),
          `${file}: P10 must not redefine P8-owned prompt programs`,
        ).toBe(false);
      }
    }
    const families = readdirSync(
      join(repoRoot, "packages/agent-runtime/promptPrograms"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(families).toEqual([
      "bootstrap",
      "communication",
      "formation",
      "human-steer",
      "query-inspection",
      "verification",
    ]);
    for (const family of families) {
      expect(
        existsSync(
          join(
            repoRoot,
            "packages/agent-runtime/promptPrograms",
            family,
            "v1.md",
          ),
        ),
        family,
      ).toBe(true);
    }
    const queryProgram = readFileSync(
      join(
        repoRoot,
        "packages/agent-runtime/promptPrograms/query-inspection/v1.md",
      ),
      "utf8",
    );
    expect(queryProgram.includes("contractRevision: P8-05@1")).toBe(true);
    expect(queryProgram.includes("P14")).toBe(true);
  });

  it("P5–P9 regression guards referenced: the architecture guard suites stand in tests/architecture", () => {
    const repoRoot = join(import.meta.dirname, "..");
    for (const phase of [5, 6, 7, 8, 9]) {
      const guardPath = join(
        repoRoot,
        `tests/architecture/p${phase}-architecture.test.ts`,
      );
      expect(existsSync(guardPath), guardPath).toBe(true);
      expect(readFileSync(guardPath, "utf8").includes("describe(")).toBe(true);
    }
  });
});
