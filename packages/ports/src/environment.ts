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

/**
 * P11 `01` §3 store mapping: the stored string IS the counter. The typed
 * surface makes the two lazy/legal writes distinguishable (P1-DG-08):
 *
 *  - lazyInitAnchor(projectId)  — the FIRST successful ownership write records
 *    the initial anchor "1" (initialization, not an environment change).
 *  - record(projectId, revision) — the ownership-write face.
 *
 * P12 `05` §5.1 (TR-1): the CAS successor advancement face is **not** on
 * this public surface. It is an internal, non-exported capability reached
 * only through the governed `RecordEnvironmentChange` command path (CI-1), so
 * no observation-side code can import or invoke it. There is no other
 * advancement path on this port.
 */
export interface EnvironmentRevisionStoreService {
  readonly current: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<string>,
    EnvironmentRevisionStoreError,
    TransactionScope
  >;
  /** Read-only raw view (persistence boundary; validated by callers). */
  readonly record: (
    projectId: ProjectId,
    revision: string,
  ) => Effect.Effect<void, EnvironmentRevisionStoreError, TransactionScope>;
  /** P1-DG-08 lazy-init: no-op if an anchor already exists. */
  readonly lazyInitAnchor: (
    projectId: ProjectId,
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
