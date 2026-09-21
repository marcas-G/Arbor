import type {
  DeliverableId,
  Dependency,
  DependencyId,
  DependencyRevision,
  ProjectId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type DependencyRepositoryError =
  RepositoryFailure<"DependencyRepository">;
export type DeliverableRepositoryError =
  RepositoryFailure<"DeliverableRepository">;

/** P7 `01` §10: state + revision CAS (first committer wins). */
export interface DependencyRepositoryService {
  readonly insert: (
    dependency: Dependency,
    projectId: ProjectId,
  ) => Effect.Effect<void, DependencyRepositoryError, TransactionScope>;
  readonly findById: (
    dependencyId: DependencyId,
  ) => Effect.Effect<
    Option.Option<Dependency>,
    DependencyRepositoryError,
    TransactionScope
  >;
  readonly listUnsatisfiedByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<Dependency>,
    DependencyRepositoryError,
    TransactionScope
  >;
  readonly transitionIfUnsatisfiedRevision: (
    dependencyId: DependencyId,
    expectedRevision: DependencyRevision,
    next: Dependency,
  ) => Effect.Effect<
    Option.Option<Dependency>,
    DependencyRepositoryError,
    TransactionScope
  >;
}

export class DependencyRepository extends Context.Service<
  DependencyRepository,
  DependencyRepositoryService
>()("arbor/DependencyRepository") {}

export interface DeliverableArtifactBinding {
  readonly role: string;
  readonly artifactId: string;
}

/** P7 `01` §10: immutable facts — insert and read only, never update. */
export interface DeliverableRepositoryService {
  readonly insert: (
    deliverable: {
      readonly deliverableId: DeliverableId;
      readonly sourceWorkId: import("@arbor/domain").WorkId;
      readonly sourceWorkRevision: number;
      readonly kind: string;
    },
    artifacts: ReadonlyArray<DeliverableArtifactBinding>,
    projectId: ProjectId,
  ) => Effect.Effect<void, DeliverableRepositoryError, TransactionScope>;
  readonly findById: (deliverableId: DeliverableId) => Effect.Effect<
    Option.Option<{
      readonly deliverableId: DeliverableId;
      readonly sourceWorkId: import("@arbor/domain").WorkId;
      readonly sourceWorkRevision: number;
      readonly kind: string;
    }>,
    DeliverableRepositoryError,
    TransactionScope
  >;
  readonly listArtifactRoles: (
    deliverableId: DeliverableId,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    DeliverableRepositoryError,
    TransactionScope
  >;
}

export class DeliverableRepository extends Context.Service<
  DeliverableRepository,
  DeliverableRepositoryService
>()("arbor/DeliverableRepository") {}

export type { Dependency, DependencyId, DependencyRevision };
