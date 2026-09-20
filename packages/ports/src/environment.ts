import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  EnvironmentError,
  EnvironmentRevisionStoreError,
  ResourceOwnershipRepositoryError,
  ResourceResolutionStale,
} from "./errors.js";
import type { ResourceOwnershipClaimRecord } from "./repositories.js";
import type {
  TransactionOperationalFailure,
  TransactionScope,
} from "./session.js";

export interface EnvironmentRevisionStoreService {
  readonly current: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<string>,
    EnvironmentRevisionStoreError,
    TransactionScope
  >;
  readonly record: (
    projectId: ProjectId,
    revision: string,
  ) => Effect.Effect<void, EnvironmentRevisionStoreError, TransactionScope>;
}

export class EnvironmentRevisionStore extends Context.Service<
  EnvironmentRevisionStore,
  EnvironmentRevisionStoreService
>()("arbor/EnvironmentRevisionStore") {}

export interface ResolvedEnvironment {
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly observedEnvironmentRevision: string;
}

export interface ProjectEnvironmentPortService {
  readonly resolve: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<ResolvedEnvironment, EnvironmentError>;
}

export class ProjectEnvironmentPort extends Context.Service<
  ProjectEnvironmentPort,
  ProjectEnvironmentPortService
>()("arbor/ProjectEnvironmentPort") {}

export interface OwnershipWriteResult {
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly claims: ReadonlyArray<ResourceOwnershipClaimRecord>;
}

export interface OwnershipWriteServiceService {
  readonly resolveAndWrite: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
    claims: ReadonlyArray<ResourceOwnershipClaimRecord>,
  ) => Effect.Effect<
    OwnershipWriteResult,
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
    | TransactionOperationalFailure
    | EnvironmentRevisionStoreError
  >;
}

export class OwnershipWriteService extends Context.Service<
  OwnershipWriteService,
  OwnershipWriteServiceService
>()("arbor/OwnershipWriteService") {}
