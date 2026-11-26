import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  CurrentWorkRes,
  DependencyRes,
  InboxViewRes,
  TranscriptRes,
  UsageRes,
  WorkspaceDetailRes,
} from "../../packages/api-contracts/src/index.js";
import { parse, WorkId } from "../../packages/domain/dist/index.js";
import {
  deriveCurrentWork,
  deriveDependencyRows,
  deriveInboxView,
  deriveTranscriptPage,
  deriveUsageRows,
  deriveVerificationView,
  deriveWorkspaceDetail,
} from "../../packages/projection-runtime/src/index.js";
import {
  insertAcceptanceRow,
  insertDependencyRow,
  insertEventRow,
  insertEvidenceRow,
  insertExecutionRow,
  insertInboxRow,
  insertProjectRootRow,
  insertProposalRow,
  insertProviderTurnRow,
  insertSessionEntryRow,
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
} from "../support/p10-fixture.js";

describe("p10-acceptance (P10 07 Stories A–G)", () => {
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
          revision: 0,
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
          revision: 0,
          activeExecution: { executionId: exeRoot, admittedAt: "t0" },
        });
        expect(yield* deriveCurrentWork(p10Child, deps.currentWork)).toBeNull();

        const verificationRes = yield* deriveVerificationView(
          rootWork,
          deps.verificationView,
        );
        expect(verificationRes.verificationId).toBe("ver_d1");
        expect(verificationRes.targetWorkRevision).toBe(0);
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
});
