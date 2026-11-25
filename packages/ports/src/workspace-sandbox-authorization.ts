import type {
  ProjectId,
  WorkspaceId,
  WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type WorkspaceSandboxAuthorizationStoreError =
  RepositoryFailure<"WorkspaceSandboxAuthorizationStore">;

/** Immutable current-head ledger. A returned fact includes proof of its exact
 * committed P1 receipt. Historical heads never regain current authority. */
export interface WorkspaceSandboxAuthorizationStoreService {
  readonly findCurrent: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<WorkspaceSandboxAuthorization>,
    WorkspaceSandboxAuthorizationStoreError,
    TransactionScope
  >;
  /** Gateway only. Must append exactly the successor of the current head. */
  readonly appendCommitted: (
    authorization: WorkspaceSandboxAuthorization,
  ) => Effect.Effect<
    void,
    WorkspaceSandboxAuthorizationStoreError,
    TransactionScope
  >;
}

export class WorkspaceSandboxAuthorizationStore extends Context.Service<
  WorkspaceSandboxAuthorizationStore,
  WorkspaceSandboxAuthorizationStoreService
>()("arbor/WorkspaceSandboxAuthorizationStore") {}
