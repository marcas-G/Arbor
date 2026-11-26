import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { TreeViewRes } from "../../packages/api-contracts/src/index.js";
import {
  parse,
  WorkId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { buildTreeView } from "../../packages/projection-runtime/src/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertExecutionRow,
  insertProjectRootRow,
  insertWaitRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
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
} from "../support/fixture-support.js";
import { makeQueryService, malformedTreeCases } from "./support.js";

describe("-acceptance (P10 07 Stories A–G)", () => {
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
            revision: 4,
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
      readonly parentWorkspaceId: WorkspaceId | null;
      readonly status: string;
      readonly subtreeAttention: { attention: number; actionRequired: number };
      readonly currentWork?: {
        readonly workId: WorkId;
        readonly objective: string;
        readonly status: string;
        readonly revision: number;
      };
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
        expect(
          nodes.map((node) => [node.workspaceId, node.parentWorkspaceId]),
        ).toEqual([
          [p10Root, null],
          [p10Child, p10Root],
          [p10Leaf, p10Child],
          [p10Retired, p10Root],
          [p10Flagged, p10Root],
        ]);
        const byId = new Map(nodes.map((node) => [node.workspaceId, node]));
        expect(byId.get(p10Root)?.status).toBe("executing");
        expect(byId.get(p10Child)?.status).toBe("waiting-blocked");
        expect(byId.get(p10Leaf)?.status).toBe("idle");
        expect(byId.get(p10Retired)?.status).toBe("retired");
        expect(byId.get(p10Flagged)?.status).toBe("attention-flagged");
        expect(byId.get(p10Root)?.currentWork).toEqual({
          workId: rootWork,
          objective: "root objective",
          status: "Open",
          revision: 4,
        });
        expect(byId.get(p10Child)?.currentWork).toBeUndefined();
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

  it.each(malformedTreeCases)(
    "rejects a malformed responsibility hierarchy: $label",
    async ({ arrange }) => {
      await runP10(
        Effect.gen(function* () {
          yield* migrate;
          yield* seedCanonical(
            Effect.gen(function* () {
              yield* insertProjectRootRow(p10Root, p10Project);
              yield* insertWorkspaceRow(
                { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
                p10Project,
              );
              yield* insertWorkspaceRow(
                {
                  workspaceId: p10Child,
                  parentWorkspaceId: p10Root,
                  name: "child",
                },
                p10Project,
              );
              yield* insertWorkspaceRow(
                {
                  workspaceId: p10Leaf,
                  parentWorkspaceId: p10Child,
                  name: "leaf",
                },
                p10Project,
              );
            }),
          );
          const deps = yield* makeP10Deps();
          const canonical =
            yield* deps.tree.listWorkspacesByProject(p10Project);
          const attempted = yield* Effect.exit(
            buildTreeView(
              { projectId: p10Project },
              {
                ...deps.tree,
                listWorkspacesByProject: () =>
                  Effect.succeed(arrange(canonical)),
              },
            ),
          );
          expect(Exit.isFailure(attempted)).toBe(true);
          if (Exit.isFailure(attempted)) {
            expect(Cause.squash(attempted.cause)).toMatchObject({
              _tag: "ProjectionReadFailure",
            });
          }
        }),
        makeP10App(),
      );
    },
  );
});
