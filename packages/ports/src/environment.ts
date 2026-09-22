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
 *  - advanceAnchor(projectId, expected) — CAS successor write; ONLY
 *    RecordEnvironmentChange (P11-002) may call it. A stale expected value
 *    is a typed conflict; blind advance is structurally impossible.
 *
 * No other advancement path exists on this port (CI-1).
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
  /** CAS successor advancement (RecordEnvironmentChange only). */
  readonly advanceAnchor: (
    projectId: ProjectId,
    expected: string,
  ) => Effect.Effect<
    | { readonly _tag: "Advanced"; readonly to: string }
    | { readonly _tag: "AnchorMissing" }
    | { readonly _tag: "RevisionConflict"; readonly current: string },
    EnvironmentRevisionStoreError,
    TransactionScope
  >;
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
