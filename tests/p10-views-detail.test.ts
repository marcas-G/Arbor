import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type {
  CurrentWorkRes,
  DependencyRes,
  VerificationRes,
  WorkspaceDetailRes,
} from "../packages/api-contracts/src/index.js";
import { parse, WorkId, WorkRevision } from "../packages/domain/dist/index.js";
import {
  AUDIT_TIMELINE_EVENT_TYPES,
  deriveAuditTimeline,
  deriveCurrentWork,
  deriveDependencyRows,
  deriveVerificationView,
  deriveWorkspaceDetail,
  makeProjectionQueryService,
} from "../packages/projection-runtime/src/index.js";
import {
  insertAcceptanceRow,
  insertDependencyRow,
  insertEventRow,
  insertEvidenceRow,
  insertExecutionRow,
  insertInboxRow,
  insertProjectRootRow,
  insertProposalRow,
  insertVerificationRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Leaf,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d1");
const W_PEND = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d2");
const W_DONE = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d3");
const W_CHILD = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d4");
const EXE_ROOT = "exe_00000000-0000-7000-8000-0000000000d1";

const seedDetail = seedCanonical(
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

    // root: current work + pending work + completed work + active main
    yield* insertWorkRow(
      {
        workId: W_ROOT,
        workspaceId: p10Root,
        objective: "current objective",
        revision: 7,
      },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_PEND, workspaceId: p10Root, objective: "pending objective" },
      p10Project,
    );
    yield* insertWorkRow(
      {
        workId: W_DONE,
        workspaceId: p10Root,
        objective: "done",
        lifecycle: "Completed",
      },
      p10Project,
    );
    // child workspace's own work (dep_d2 consumer)
    yield* insertWorkRow(
      { workId: W_CHILD, workspaceId: p10Child, objective: "child objective" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    yield* insertExecutionRow(
      { executionId: EXE_ROOT, workspaceId: p10Root, focusWorkId: W_ROOT },
      p10Project,
    );

    // dependencies: open + satisfied (satisfiedBy)
    yield* insertDependencyRow({
      dependencyId: "dep_d1",
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Child,
      state: "Unsatisfied",
    });
    yield* insertDependencyRow({
      dependencyId: "dep_d2",
      consumerWorkId: W_CHILD,
      producerWorkspaceId: p10Leaf,
      state: "Unsatisfied",
    });
    yield* insertDependencyRow({
      dependencyId: "dep_d3",
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Child,
      state: "Satisfied",
    });
    yield* insertDependencyRow({
      dependencyId: "dep_d4",
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Leaf,
      state: "Withdrawn",
    });

    // inbox: one live, one consumed
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

    // verification for the current work: open + evidence + acceptance
    yield* insertVerificationRow({
      verificationId: "ver_d1",
      workId: W_ROOT,
      targetWorkRevision: 7,
      ownerWorkspaceId: p10Root,
      executionIds: [],
      state: "Open",
      criteria: [
        {
          criterionId: "c1",
          requirement: "tests pass",
          required: true,
        },
        {
          criterionId: "c2",
          requirement: "lint clean",
          required: false,
        },
      ],
    });
    yield* insertEvidenceRow({
      evidenceId: "evd_00000000-0000-7000-8000-0000000000d1",
      verificationId: "ver_d1",
      criterionId: "c1",
      kind: "Observation",
      recordedByExecutionId: EXE_ROOT,
      recordedAt: "t3",
    });
    yield* insertAcceptanceRow({
      acceptanceId: "acc_00000000-0000-7000-8000-0000000000d1",
      workId: W_ROOT,
      targetWorkRevision: 7,
      verificationId: "ver_d1",
      actor: "user:gov",
      acceptedAt: "t4",
    });

    // audit timeline facts (journal-sequenced):
    // 1. unrelated event type for the workspace — filtered by type
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-0000000000e1",
      projectId: p10Project,
      eventType: "WorkAssigned",
      payload: { workId: W_ROOT },
      occurredAt: "t1",
    });
    // 2. intervention targeting the workspace
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
    // 3. steer of ANOTHER workspace's work — filtered by scope
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-0000000000e3",
      projectId: p10Project,
      eventType: "WorkSteered",
      payload: {
        workId: W_CHILD,
        fromRevision: 0,
        toRevision: 1,
        severity: "Normal",
      },
      occurredAt: "t3",
    });
    // 4. steer of this workspace's work
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-0000000000e4",
      projectId: p10Project,
      eventType: "WorkSteered",
      payload: {
        workId: W_ROOT,
        fromRevision: 0,
        toRevision: 1,
        severity: "Critical",
      },
      occurredAt: "t4",
    });
    // 5. governance decision on a proposal originating here
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
    // 6. decision on ANOTHER workspace's proposal — filtered by scope
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
    // 7. intervention on a DESCENDANT workspace — not this workspace
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
  }),
);

describe("P10-006 Workspace Detail (01 §1 ①–⑥; SD §12.4)", () => {
  it("derives every frozen core section from canonical tables + journal, zero mutation", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const detail = yield* deriveWorkspaceDetail(
          p10Root,
          deps.workspaceDetail,
        );

        // ① responsibility + ② boundary (from the workspace row)
        expect(detail.responsibility.purpose).toBe("p10");
        expect(detail.boundary.basisResponsibilityRevision).toBe(0);
        // current work + active execution summary
        expect(detail.currentWork).toEqual({
          workId: W_ROOT,
          objective: "current objective",
          status: "Open",
          revision: 7,
          activeExecution: { executionId: EXE_ROOT, admittedAt: "t0" },
        });
        expect(detail.executionSummary).toEqual({
          executionId: EXE_ROOT,
          admittedAt: "t0",
        });
        // pending works: open, not current (completed excluded)
        expect(detail.pendingWorks).toEqual([
          { workId: W_PEND, objective: "pending objective" },
        ]);
        // dependencies of the workspace's works, all states
        expect(detail.dependencies).toEqual([
          {
            dependencyId: "dep_d1",
            consumerWorkId: W_ROOT,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
            state: "Unsatisfied",
          },
          {
            dependencyId: "dep_d3",
            consumerWorkId: W_ROOT,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
            state: "Satisfied",
          },
          {
            dependencyId: "dep_d4",
            consumerWorkId: W_ROOT,
            binding: { _tag: "WorkspaceBound", workspaceId: p10Leaf },
            state: "Withdrawn",
          },
        ]);
        // inbox unconsumed only, watermark = journal lastSequence (7 events)
        expect(detail.inboxUnconsumed).toEqual([
          {
            entryKey: "msg:msg_d1",
            kind: "Message",
            summary: "a report",
            watermark: 7,
          },
        ]);
        // ⑤ verification (open) + evidence + acceptance
        expect(detail.verification).toEqual({
          verificationId: "ver_d1",
          targetWorkRevision: parse(WorkRevision)(7),
          verdict: undefined,
          criteriaResults: [
            {
              criterionId: "c1",
              requirement: "tests pass",
              required: true,
              verdict: "Unknown",
            },
            {
              criterionId: "c2",
              requirement: "lint clean",
              required: false,
              verdict: "Unknown",
            },
          ],
          evidenceRefs: ["evd_00000000-0000-7000-8000-0000000000d1"],
          acceptance: {
            acceptanceId: "acc_00000000-0000-7000-8000-0000000000d1",
            actor: "user:gov",
            acceptedAt: "t4",
          },
        });
        // ⑥ audit timeline: journal-sequenced, scoped, type-filtered
        expect(detail.auditTimeline).toEqual([
          {
            sequence: 2,
            eventType: "HumanInterventionApplied",
            at: "t2",
          },
          { sequence: 4, eventType: "WorkSteered", at: "t4" },
          { sequence: 5, eventType: "DecisionRecorded", at: "t5" },
        ]);

        // the derive output structurally satisfies the frozen Res core
        const asContract: WorkspaceDetailRes = detail;
        expect(Object.keys(asContract).sort()).toEqual([
          "auditTimeline",
          "boundary",
          "currentWork",
          "dependencies",
          "executionSummary",
          "inboxUnconsumed",
          "pendingWorks",
          "responsibility",
          "verification",
        ]);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("audit timeline filter is the frozen intervention set; ordering survives unordered input", () => {
    expect([...AUDIT_TIMELINE_EVENT_TYPES]).toEqual([
      "HumanInterventionApplied",
      "WorkSteered",
      "DecisionRecorded",
    ]);
    const reversed = [4, 2].map(
      (sequence) =>
        ({
          eventId: `evt_${sequence}`,
          projectId: p10Project,
          sequence,
          eventType: "WorkSteered",
          eventVersion: 1,
          occurredAt: `t${sequence}`,
          aggregateRef: "a",
          actor: "user:gov",
          payload: { workId: W_ROOT },
        }) as never,
    );
    const timeline = deriveAuditTimeline(
      p10Root,
      reversed,
      new Set([W_ROOT]),
      () => null,
    );
    expect(timeline.map((entry) => entry.sequence)).toEqual([2, 4]);
  });
});

describe("P10-006 Current Work (01 §1; SD §12.1)", () => {
  it("current work with active execution; null without current work; workspace without execution renders no activeExecution", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();

        const current: CurrentWorkRes = yield* deriveCurrentWork(
          p10Root,
          deps.currentWork,
        );
        expect(current).toEqual({
          workId: W_ROOT,
          objective: "current objective",
          status: "Open",
          revision: 7,
          activeExecution: { executionId: EXE_ROOT, admittedAt: "t0" },
        });

        expect(yield* deriveCurrentWork(p10Child, deps.currentWork)).toBeNull();
      }),
      makeP10App(),
    );
  });
});

describe("P10-006 Verification view (01 §1 ⑤)", () => {
  it("open verification renders criteria/evidence/acceptance; concluded fallback renders the aggregate verdict; none renders empty optionals", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();

        const open: VerificationRes = yield* deriveVerificationView(
          W_ROOT,
          deps.verificationView,
        );
        expect(open.verificationId).toBe("ver_d1");
        expect(open.targetWorkRevision).toBe(7);
        expect(open.verdict).toBeUndefined();
        expect(open.criteriaResults.every((c) => c.verdict === "Unknown")).toBe(
          true,
        );
        expect(open.evidenceRefs).toEqual([
          "evd_00000000-0000-7000-8000-0000000000d1",
        ]);
        expect(open.acceptance?.acceptanceId).toBe(
          "acc_00000000-0000-7000-8000-0000000000d1",
        );

        // a workspace-less work: no verifications at all
        const none: VerificationRes = yield* deriveVerificationView(
          W_PEND,
          deps.verificationView,
        );
        expect(none.verificationId).toBeUndefined();
        expect(none.targetWorkRevision).toBeUndefined();
        expect(none.criteriaResults).toEqual([]);
        expect(none.evidenceRefs).toEqual([]);
      }),
      makeP10App(),
    );
  });

  it("does not attach an acceptance that belongs to another verification at the same work revision", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();
        const mismatchedAcceptance = {
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000d9" as never,
          workId: W_ROOT,
          targetWorkRevision: parse(WorkRevision)(7),
          verificationId: "ver_00000000-0000-7000-8000-0000000000d9" as never,
          actor: "user:gov" as never,
          acceptedAt: "t9",
        };
        const verification = yield* deriveVerificationView(W_ROOT, {
          ...deps.verificationView,
          findAcceptanceByWorkRevision: () =>
            Effect.succeed(Option.some(mismatchedAcceptance)),
        });
        const detail = yield* deriveWorkspaceDetail(p10Root, {
          ...deps.workspaceDetail,
          findAcceptanceByWorkRevision: () =>
            Effect.succeed(Option.some(mismatchedAcceptance)),
        });

        expect(verification.verificationId).toBe("ver_d1");
        expect(verification.targetWorkRevision).toBe(7);
        expect(verification.acceptance).toBeUndefined();
        expect(detail.verification?.verificationId).toBe("ver_d1");
        expect(detail.verification?.targetWorkRevision).toBe(7);
        expect(detail.verification?.acceptance).toBeUndefined();
      }),
      makeP10App(),
    );
  });

  it("concluded selection: current-revision row wins; per-criterion verdicts stay Unknown (never invented from the aggregate)", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();
        const sqlDeps = deps.verificationView;

        // conclude the seeded verification via a new Concluded row set
        yield* seedCanonical(
          Effect.gen(function* () {
            yield* insertVerificationRow({
              verificationId: "ver_d2",
              workId: W_PEND,
              targetWorkRevision: 3,
              ownerWorkspaceId: p10Root,
              executionIds: [],
              state: "Concluded",
              verdict: "Fail",
            });
            yield* insertVerificationRow({
              verificationId: "ver_d3",
              workId: W_PEND,
              targetWorkRevision: 5,
              ownerWorkspaceId: p10Root,
              executionIds: [],
              state: "Concluded",
              verdict: "Unknown",
            });
          }),
        );

        const concluded: VerificationRes = yield* deriveVerificationView(
          W_PEND,
          sqlDeps,
        );
        // work revision is 0 — no Concluded row matches it; highest
        // target revision wins (ver_d3)
        expect(concluded.verificationId).toBe("ver_d3");
        expect(concluded.targetWorkRevision).toBe(5);
        expect(concluded.verdict).toBe("Unknown");
        expect(
          concluded.criteriaResults.every((c) => c.verdict === "Unknown"),
        ).toBe(true);
      }),
      makeP10App(),
    );
  });
});

describe("P10-006 Dependency view (01 §1; projectId|workspaceId scoping)", () => {
  it("project scope lists every row; workspace scope filters to the workspace's works", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();

        const byProject: DependencyRes = {
          rows: yield* deriveDependencyRows(
            { projectId: p10Project },
            deps.dependencyView,
          ),
        };
        expect(byProject.rows.map((row) => row.dependencyId)).toEqual([
          "dep_d1",
          "dep_d2",
          "dep_d3",
          "dep_d4",
        ]);
        expect(byProject.rows[0]).toEqual({
          dependencyId: "dep_d1",
          consumerWorkId: W_ROOT,
          binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
          state: "Unsatisfied",
          satisfiedBy: undefined,
        });

        const byWorkspace: DependencyRes = {
          rows: yield* deriveDependencyRows(
            { workspaceId: p10Root },
            deps.dependencyView,
          ),
        };
        expect(byWorkspace.rows.map((row) => row.dependencyId)).toEqual([
          "dep_d1",
          "dep_d3",
          "dep_d4",
        ]);
      }),
      makeP10App(),
    );
  });
});

describe("P10-006 ProjectionQueryPort bindings (05 §1: envelope + typed errors)", () => {
  it("workspace-detail query returns the GQ5 envelope; invalid request and unknown workspace are typed Problem errors", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedDetail;
        const deps = yield* makeP10Deps();
        const service = makeProjectionQueryService({
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

        const enveloped = yield* service.query<never, WorkspaceDetailRes>(
          "workspace-detail",
          { workspaceId: p10Root } as never,
        );
        expect(enveloped.watermark).toBe(7);
        expect(enveloped.lag).toBe(0);
        expect(enveloped.value.responsibility.purpose).toBe("p10");
        expect(
          enveloped.value.auditTimeline.map((entry) => entry.sequence),
        ).toEqual([2, 4, 5]);

        const invalid = yield* Effect.flip(
          service.query("workspace-detail", {} as never),
        );
        expect(invalid._tag).toBe("ProjectionInvalidRequest");
        expect(invalid.code).toBe("projection/invalid-request");

        const missing = yield* Effect.flip(
          service.query("workspace-detail", {
            workspaceId: "ws_00000000-0000-7000-8000-00000000dead" as never,
          } as never),
        );
        expect(missing._tag).toBe("ProjectionUnavailable");
        expect(missing.code).toBe("projection/unavailable");
      }),
      makeP10App(),
    );
  });
});
