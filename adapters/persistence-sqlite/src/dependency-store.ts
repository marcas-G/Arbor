import type {
  DeliverableId,
  Dependency,
  DependencyId,
  DependencyRevision,
} from "@arbor/domain";
import {
  type DeliverableArtifactBinding,
  DeliverableRepository,
  type DeliverableRepositoryError,
  DependencyRepository,
  type DependencyRepositoryError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface DependencyRow {
  readonly dependency_id: string;
  readonly project_id: string;
  readonly consumer_work_id: string;
  readonly producer_binding: string;
  readonly expected_deliverable: string;
  readonly revision: number;
  readonly state: string;
  readonly satisfied_by_deliverable_id: string | null;
  readonly satisfied_at_dependency_revision: number | null;
}

const toDependency = (row: DependencyRow): Dependency =>
  ({
    dependencyId: row.dependency_id,
    consumerWorkId: row.consumer_work_id,
    producerBinding: JSON.parse(row.producer_binding),
    expectedDeliverable: JSON.parse(row.expected_deliverable),
    revision: row.revision,
    state: row.state,
    satisfiedByDeliverableId: row.satisfied_by_deliverable_id ?? undefined,
    satisfiedAtDependencyRevision:
      row.satisfied_at_dependency_revision ?? undefined,
  }) as unknown as Dependency;

interface DeliverableRow {
  readonly deliverable_id: string;
  readonly source_work_id: string;
  readonly source_work_revision: number;
  readonly kind: string;
}

/** P7 `01` §10: state + revision CAS — first committer wins; deliverables are
 * immutable (insert-only). */
export const DependencyRepositoryLive: Layer.Layer<
  DependencyRepository,
  never,
  SqlClient
> = Layer.effect(
  DependencyRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): DependencyRepositoryError => ({
      _tag: "DependencyRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return DependencyRepository.of({
      insert: (dependency: Dependency, projectId: string) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = new Date().toISOString();
          yield* run(
            sql.unsafe(
              "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              [
                dependency.dependencyId,
                projectId,
                dependency.consumerWorkId,
                JSON.stringify(dependency.producerBinding),
                JSON.stringify(dependency.expectedDeliverable),
                dependency.revision,
                dependency.state,
                dependency.satisfiedByDeliverableId ?? null,
                dependency.satisfiedAtDependencyRevision ?? null,
                now,
                now,
              ],
            ),
          );
        }),
      findById: (dependencyId: DependencyId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<DependencyRow>(
              "SELECT dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision FROM dependencies WHERE dependency_id = ?",
              [dependencyId],
            ),
          );
          return rows.length > 0
            ? Option.some(toDependency(rows[0] as DependencyRow))
            : Option.none();
        }),
      listUnsatisfiedByProject: (projectId: string) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<DependencyRow>(
              "SELECT dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision FROM dependencies WHERE project_id = ? AND state = 'Unsatisfied'",
              [projectId],
            ),
          );
          return rows.map(toDependency);
        }),
      /** CAS on (dependencyId, expectedRevision, state='Unsatisfied');
       * `None` = the row moved on (stale or already terminal). */
      transitionIfUnsatisfiedRevision: (
        dependencyId: DependencyId,
        expectedRevision: DependencyRevision,
        next: Dependency,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ dependency_id: string }>(
              "UPDATE dependencies SET revision = ?, state = ?, producer_binding = ?, expected_deliverable = ?, satisfied_by_deliverable_id = ?, satisfied_at_dependency_revision = ?, updated_at = ? WHERE dependency_id = ? AND revision = ? AND state = 'Unsatisfied' RETURNING dependency_id",
              [
                next.revision,
                next.state,
                JSON.stringify(next.producerBinding),
                JSON.stringify(next.expectedDeliverable),
                next.satisfiedByDeliverableId ?? null,
                next.satisfiedAtDependencyRevision ?? null,
                new Date().toISOString(),
                dependencyId,
                expectedRevision,
              ],
            ),
          );
          return rows.length === 1 ? Option.some(next) : Option.none();
        }),
    });
  }),
);

export const DeliverableRepositoryLive: Layer.Layer<
  DeliverableRepository,
  never,
  SqlClient
> = Layer.effect(
  DeliverableRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): DeliverableRepositoryError => ({
      _tag: "DeliverableRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return DeliverableRepository.of({
      insert: (
        deliverable: {
          readonly deliverableId: DeliverableId;
          readonly sourceWorkId: import("@arbor/domain").WorkId;
          readonly sourceWorkRevision: number;
          readonly kind: string;
        },
        artifacts: ReadonlyArray<DeliverableArtifactBinding>,
        projectId: string,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = new Date().toISOString();
          yield* run(
            sql.unsafe(
              "INSERT INTO deliverables (deliverable_id, project_id, source_work_id, source_work_revision, kind, created_at) VALUES (?,?,?,?,?,?)",
              [
                deliverable.deliverableId,
                projectId,
                deliverable.sourceWorkId,
                deliverable.sourceWorkRevision,
                deliverable.kind,
                now,
              ],
            ),
          );
          for (const artifact of artifacts) {
            yield* run(
              sql.unsafe(
                "INSERT INTO deliverable_artifacts (deliverable_id, role, artifact_id) VALUES (?,?,?)",
                [deliverable.deliverableId, artifact.role, artifact.artifactId],
              ),
            );
          }
        }),
      findById: (deliverableId: DeliverableId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<DeliverableRow>(
              "SELECT deliverable_id, source_work_id, source_work_revision, kind FROM deliverables WHERE deliverable_id = ?",
              [deliverableId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                deliverableId: row.deliverable_id as DeliverableId,
                sourceWorkId:
                  row.source_work_id as import("@arbor/domain").WorkId,
                sourceWorkRevision: row.source_work_revision,
                kind: row.kind,
              });
        }),
      listArtifactRoles: (deliverableId: DeliverableId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ role: string }>(
              "SELECT role FROM deliverable_artifacts WHERE deliverable_id = ?",
              [deliverableId],
            ),
          );
          return rows.map((row) => row.role);
        }),
    });
  }),
);
