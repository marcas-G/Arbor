import type { ProjectId, WorkId, WorkspaceId } from "@arbor/domain";
import {
  AcceptanceRepository,
  CompletionHoldRead,
  DependencyRepository,
  ExecutionRepository,
  RunnableWorkSource,
  type RunnableWorkSourceError,
  TransactionPort,
  TransactionScope,
  VerificationRepository,
  WorkReadmissionGateStore,
  WorkRepository,
  WorkspaceRepository,
  type WorkWait,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const isCompletionClaimedSettlement = (
  settlementJson: string,
  workRevision: number,
): boolean => {
  try {
    const settlement = JSON.parse(settlementJson) as {
      readonly _tag?: unknown;
      readonly result?: {
        readonly _tag?: unknown;
        readonly workRevision?: unknown;
        readonly claimRef?: unknown;
      };
    };
    return (
      settlement._tag === "Completed" &&
      settlement.result?._tag === "CompletionClaimed" &&
      settlement.result.workRevision === workRevision &&
      typeof settlement.result.claimRef === "string" &&
      settlement.result.claimRef.length > 0
    );
  } catch {
    return false;
  }
};

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
  | ExecutionRepository
  | DependencyRepository
  | WorkWaitStore
  | WorkReadmissionGateStore
  | TransactionPort
> = Layer.effect(
  RunnableWorkSource,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const dependencies = yield* DependencyRepository;
    const verifications = yield* Effect.serviceOption(VerificationRepository);
    const acceptances = yield* Effect.serviceOption(AcceptanceRepository);
    const completionHoldRead = yield* Effect.serviceOption(CompletionHoldRead);
    const waits = yield* WorkWaitStore;
    // E06: the durable environment-blocking fact source is a required
    // classifier input on every tick path (AGENTS.md: a Work blocked by an
    // unavailable environment stays blocked across ticks and restarts).
    const readmissionGate = yield* WorkReadmissionGateStore;
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
          const held = new Set<WorkId>();
          // The completion-hold faces are persistence-optional: whether the
          // backing tables exist is probed by the adapter
          // (`CompletionHoldRead`), so a database below the P8 baseline skips
          // both hold classifications instead of failing them.
          const holdPersistenceAvailable = Option.isSome(completionHoldRead)
            ? yield* completionHoldRead.value.available
            : false;
          if (holdPersistenceAvailable) {
            // Completion claims come from the persistence adapter: it owns
            // the row shape, the binding-generation columns and the claim
            // filter. `bindingWorkRevision === null` marks a pre-0024 legacy
            // binding row (revision only inside the settlement JSON); those
            // claims are evaluated against the Work's current revision,
            // matching the legacy classification rule (`revision !== 0` is
            // skipped because a legacy claim cannot hold a refined Work).
            const projectId = Option.isSome(workspace)
              ? workspace.value.projectId
              : ("" as ProjectId);
            const allClaims = yield* executions.listCompletionClaims(
              projectId,
              workspaceId,
            );
            const usesEpisodeBinding = allClaims.some(
              (claim) => claim.bindingWorkRevision !== null,
            );
            for (const work of open) {
              if (!usesEpisodeBinding && work.revision !== 0) continue;
              const claimsForWork = allClaims.filter(
                (claim) => claim.workId === work.workId,
              );
              const holdsCurrentRevision = claimsForWork.some(
                (claim) =>
                  // Episode rows carry the binding revision; the original
                  // classification matched `episode_revision = work.revision`
                  // in SQL, so only claims bound to the exact current revision
                  // count. Legacy rows carry no binding revision and are
                  // judged against the Work's current revision directly.
                  (claim.bindingWorkRevision === null ||
                    claim.bindingWorkRevision === work.revision) &&
                  isCompletionClaimedSettlement(
                    claim.settlementJson,
                    claim.bindingWorkRevision ?? work.revision,
                  ),
              );
              if (holdsCurrentRevision) {
                held.add(work.workId);
              }
            }
          }
          // A PASS Verification is intentionally distinct from Acceptance,
          // but it is also not a request to run the same producer Work again.
          // Between VerificationConcluded(Pass), human/Parent Acceptance and
          // the deterministic CompleteWork consumer, the Work remains Open.
          // Hold that exact revision so scheduler ticks cannot repeatedly
          // invoke the model while the acceptance decision is pending.
          // An already committed Acceptance is held for the same reason: the
          // completion consumer may be between its event and CompleteWork
          // transaction.
          if (
            holdPersistenceAvailable &&
            Option.isSome(verifications) &&
            Option.isSome(acceptances)
          ) {
            for (const work of open) {
              const acceptance = yield* acceptances.value.findByWorkRevision(
                work.workId,
                work.revision,
              );
              if (Option.isSome(acceptance)) {
                held.add(work.workId);
                continue;
              }
              const history = yield* verifications.value.listByWork(
                work.workId,
              );
              const concludedCurrentRevision = history.filter(
                (verification) =>
                  verification.targetWorkRevision === work.revision &&
                  verification.state.status === "Concluded",
              );
              if (
                concludedCurrentRevision.some(
                  (verification) =>
                    verification.state.status === "Concluded" &&
                    verification.state.verdict === "Pass",
                )
              ) {
                held.add(work.workId);
              } else if (concludedCurrentRevision.length > 0) {
                held.delete(work.workId);
              }
            }
          }
          if (Option.isSome(workspace) && open.length > 0) {
            for (const work of open) {
              // A terminal provider record can be intentionally held by the
              // readmission gate when its failure evidence is incomplete.
              // Classification must keep the daemon alive so the user can
              // inspect the Work and submit a new revision; turning that
              // durable hold into a scheduler error makes recovery
              // impossible after a restart.
              const source = yield* readmissionGate
                .hasBlockingSource({
                  projectId: workspace.value.projectId,
                  workspaceId,
                  workId: work.workId,
                  workRevision: work.revision,
                })
                .pipe(
                  Effect.catchTag("ReadmissionGateIntegrityFailure", () => {
                    held.add(work.workId);
                    return Effect.succeed(Option.none());
                  }),
                );
              if (Option.isSome(source)) held.add(work.workId);
            }
          }

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
            pointed !== null &&
            openIds.includes(pointed) &&
            !waiting(pointed) &&
            !held.has(pointed)
              ? Option.some(pointed)
              : Option.none();
          const runnable = openIds
            .filter((workId) => !waiting(workId))
            .filter((workId) => !held.has(workId))
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
