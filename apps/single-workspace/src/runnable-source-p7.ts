import type { WorkId, WorkspaceId } from "@arbor/domain";
import {
  AcceptanceRepository,
  DependencyRepository,
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
import { SqlClient } from "effect/unstable/sql/SqlClient";

interface CompletionSettlementRow {
  readonly settlement_json: string;
}

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
  | DependencyRepository
  | WorkWaitStore
  | WorkReadmissionGateStore
  | TransactionPort
> = Layer.effect(
  RunnableWorkSource,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const dependencies = yield* DependencyRepository;
    const verifications = yield* Effect.serviceOption(VerificationRepository);
    const acceptances = yield* Effect.serviceOption(AcceptanceRepository);
    const sql = yield* Effect.serviceOption(SqlClient);
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
          if (Option.isSome(sql)) {
            const executionColumns = new Set(
              yield* sql.value
                .unsafe<{ readonly name: string }>(
                  "PRAGMA table_info(executions)",
                )
                .pipe(Effect.map((rows) => rows.map((row) => row.name))),
            );
            const usesEpisodeBinding =
              executionColumns.has("episode_kind") &&
              executionColumns.has("episode_ref") &&
              executionColumns.has("episode_revision");
            const episodeBinding = usesEpisodeBinding
              ? "episode_kind = 'WorkEpisode' AND episode_ref = ? AND episode_revision = ?"
              : "focus_kind = 'work' AND focus_work_id = ?";
            for (const work of open) {
              if (!usesEpisodeBinding && work.revision !== 0) continue;
              const completionClaims =
                yield* sql.value.unsafe<CompletionSettlementRow>(
                  `SELECT settlement_json
                   FROM executions
                  WHERE project_id = ?
                    AND workspace_id = ?
                    AND binding_kind = 'workspace'
                    AND ${episodeBinding}
                    AND settlement_kind = 'Completed'
                    AND settlement_json IS NOT NULL`,
                  usesEpisodeBinding
                    ? [
                        Option.isSome(workspace)
                          ? workspace.value.projectId
                          : "",
                        workspaceId,
                        work.workId,
                        work.revision,
                      ]
                    : [
                        Option.isSome(workspace)
                          ? workspace.value.projectId
                          : "",
                        workspaceId,
                        work.workId,
                      ],
                );
              if (
                completionClaims.some((row) =>
                  isCompletionClaimedSettlement(
                    row.settlement_json,
                    work.revision,
                  ),
                )
              ) {
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
          const completionTables =
            Option.isSome(sql) &&
            (yield* sql.value.unsafe<{ readonly name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verifications', 'work_acceptances')",
            )).length === 2;
          if (
            completionTables &&
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
