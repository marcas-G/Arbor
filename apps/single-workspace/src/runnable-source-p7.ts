import type { WorkId, WorkspaceId } from "@arbor/domain";
import {
  DependencyRepository,
  RunnableWorkSource,
  type RunnableWorkSourceError,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
  type WorkWait,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/**
 * Dependency-aware single-workspace `RunnableWorkSource` (P7 `03`; DID v1.10
 * G3 / §8.18A). Supersedes the P5 provisional implementation; the P2 port
 * signature is unchanged. Frozen classification rules:
 *
 * - `waiting(w) :⇔` w has an active WorkWait `∨` w has an unresolved blocking
 *   Dependency. An Unsatisfied Dependency alone never blocks (single-negative
 *   rule): blocking additionally requires an active WorkWait of w whose
 *   conditions reference `DependencyChanged(d.dependencyId, _)` — any
 *   observedRevision.
 * - `current = Some(w)` only when `w ∈ Open ∧ ¬waiting(w)`; otherwise None.
 * - `runnable` excludes every waiting Work and the current, ordered by WorkId.
 * - Read set is one snapshot transaction; classify is read-only (no WorkWait
 *   registration/clearing, no wake, no canonical writes — SD No.53).
 */
export const DependencyAwareRunnableWorkSourceLive: Layer.Layer<
  RunnableWorkSource,
  never,
  | WorkspaceRepository
  | WorkRepository
  | DependencyRepository
  | WorkWaitStore
  | TransactionPort
> = Layer.effect(
  RunnableWorkSource,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const dependencies = yield* DependencyRepository;
    const waits = yield* WorkWaitStore;
    const tx = yield* TransactionPort;

    const waitReferencesDependency = (
      wait: WorkWait,
      dependencyId: string,
    ): boolean =>
      wait.waitSpec.conditions.some(
        (condition) =>
          condition._tag === "DependencyChanged" &&
          condition.dependencyId === dependencyId,
      );

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

          const activeWaits = yield* waits.listActive();
          const activeWaitsByWork = new Map<WorkId, ReadonlyArray<WorkWait>>();
          for (const wait of activeWaits) {
            const previous = activeWaitsByWork.get(wait.workId) ?? [];
            activeWaitsByWork.set(wait.workId, [...previous, wait]);
          }

          const unsatisfied = Option.isSome(workspace)
            ? yield* dependencies.listUnsatisfiedByProject(
                workspace.value.projectId,
              )
            : [];
          const blockingWorks = new Set<WorkId>();
          for (const dependency of unsatisfied) {
            const consumerWaits = activeWaitsByWork.get(
              dependency.consumerWorkId,
            );
            if (
              consumerWaits?.some((wait) =>
                waitReferencesDependency(wait, dependency.dependencyId),
              )
            ) {
              blockingWorks.add(dependency.consumerWorkId);
            }
          }

          const waiting = (workId: WorkId): boolean =>
            activeWaitsByWork.has(workId) || blockingWorks.has(workId);

          const pointed = Option.isSome(workspace)
            ? workspace.value.currentWorkId
            : null;
          const current: Option.Option<WorkId> =
            pointed !== null && openIds.includes(pointed) && !waiting(pointed)
              ? Option.some(pointed)
              : Option.none();
          const runnable = openIds
            .filter((workId) => !waiting(workId))
            .filter(
              (workId) => !Option.isSome(current) || workId !== current.value,
            )
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
