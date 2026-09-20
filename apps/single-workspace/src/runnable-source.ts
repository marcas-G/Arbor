import type { WorkId, WorkspaceId } from "@arbor/domain";
import {
  RunnableWorkSource,
  type RunnableWorkSourceError,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/**
 * Provisional single-workspace `RunnableWorkSource` (P5 `02`; DID v1.9 G2).
 * Implements the existing P2 port; it does not define global Work runnability
 * and does not change the port. P7 later supersedes it with a dependency-aware
 * implementation.
 */
export const ProvisionalRunnableWorkSourceLive: Layer.Layer<
  RunnableWorkSource,
  never,
  WorkspaceRepository | WorkRepository | TransactionPort
> = Layer.effect(
  RunnableWorkSource,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const tx = yield* TransactionPort;

    const classify = (
      workspaceId: WorkspaceId,
    ): Effect.Effect<
      {
        readonly current: Option.Option<WorkId>;
        readonly runnable: ReadonlyArray<WorkId>;
      },
      RunnableWorkSourceError
    > =>
      Effect.gen(function* () {
        const body = Effect.gen(function* () {
          const workspace = yield* workspaces.findById(workspaceId);
          const open = yield* works.listByWorkspace(workspaceId, "Open");
          const openIds = open.map((work) => work.workId);
          const pointed = Option.isSome(workspace)
            ? workspace.value.currentWorkId
            : null;
          const current: Option.Option<WorkId> =
            pointed !== null && openIds.includes(pointed)
              ? Option.some(pointed)
              : Option.none();
          const runnable = openIds
            .filter((id) => !Option.isSome(current) || id !== current.value)
            .sort();
          return { current, runnable };
        });
        const ambient = yield* Effect.serviceOption(TransactionScope);
        if (Option.isSome(ambient)) {
          return yield* Effect.provideService(
            body,
            TransactionScope,
            ambient.value,
          );
        }
        return yield* tx.transact(body);
      }).pipe(
        Effect.mapError(
          (cause): RunnableWorkSourceError => ({
            _tag: "RunnableWorkSourceError",
            cause,
          }),
        ),
      );

    return RunnableWorkSource.of({ classify });
  }),
);
