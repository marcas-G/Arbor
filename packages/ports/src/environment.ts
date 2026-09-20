import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
  ResourceOwnershipClaim,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  EnvironmentError,
  EnvironmentRevisionStoreError,
  ResourceOwnershipRepositoryError,
  ResourceResolutionStale,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

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
  readonly claims: ReadonlyArray<ResourceOwnershipClaim>;
}

export interface OwnershipWriteServiceService {
  readonly resolveAndWrite: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
    claims: ReadonlyArray<ResourceOwnershipClaim>,
  ) => Effect.Effect<
    OwnershipWriteResult,
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
  >;
}

export class OwnershipWriteService extends Context.Service<
  OwnershipWriteService,
  OwnershipWriteServiceService
>()("arbor/OwnershipWriteService") {}
