import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CurrentWorkRes } from "../../packages/api-contracts/src/index.js";
import { parse, WorkId } from "../../packages/domain/dist/index.js";
import type { ProjectionStale } from "../../packages/ports/src/errors.js";
import { makeEffectiveFactsQueryFace } from "../../packages/projection-runtime/src/index.js";
import {
  insertEventRow,
  insertProjectRootRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
} from "../support/p10-fixture.js";
import { makeQueryService, runtimeDepsOf } from "./support.js";

describe("p10-acceptance (P10 07 Stories A–G)", () => {
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
});
