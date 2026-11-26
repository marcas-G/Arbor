import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AttentionRes } from "../../packages/api-contracts/src/index.js";
import {
  parse,
  WorkId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertExecutionRow,
  insertProjectRootRow,
  insertVerificationRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Flagged,
  p10Leaf,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  snapshotDatabase,
} from "../support/p10-fixture.js";
import { makeQueryService } from "./support.js";

describe("p10-acceptance (P10 07 Stories A–G)", () => {
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
            workspaceId: p10Leaf,
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
            workspaceId: p10Leaf,
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
          aggregateRef: "exe_b2",
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
          targetWorkspaceId: p10Leaf,
          dedupKey: "safety-stop:exe_b1",
        });
        expect(bySource.get("RecoveryEscalation")).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Leaf,
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
});
