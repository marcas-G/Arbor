import type {
  CommandId,
  GrantedWorkspaceSandboxAuthorization,
  NetworkPolicyV1,
  Principal,
  ProjectId,
  WorkspaceId,
  WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { TransactionScope } from "./session.js";
import type { WorkspaceSandboxAuthorizationStoreError } from "./workspace-sandbox-authorization.js";

export type WorkspaceSandboxInitializationOutcome =
  | {
      readonly _tag: "Initialized";
      readonly authorization: WorkspaceSandboxAuthorization;
    }
  | {
      readonly _tag: "AlreadyInitialized";
      readonly authorization: WorkspaceSandboxAuthorization;
    }
  | { readonly _tag: "Revoked" }
  | { readonly _tag: "Stale" }
  | { readonly _tag: "Unavailable"; readonly reason: string };

export interface WorkspaceSandboxAuthorizationInitializationInput {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly commandId: CommandId;
  readonly actorPrincipal: Principal;
  readonly resourceBoundaryRevision: number;
  readonly workspacePolicyRevision: number;
  readonly recordedAt: string;
  readonly providerId: string;
  readonly networkPolicy: NetworkPolicyV1;
  readonly parentAuthorization?: GrantedWorkspaceSandboxAuthorization;
}

export interface WorkspaceSandboxAuthorizationInitializationPortService {
  readonly initialize: (
    input: WorkspaceSandboxAuthorizationInitializationInput,
  ) => Effect.Effect<
    WorkspaceSandboxInitializationOutcome,
    WorkspaceSandboxAuthorizationStoreError,
    TransactionScope
  >;
}

export class WorkspaceSandboxAuthorizationInitializationPort extends Context.Service<
  WorkspaceSandboxAuthorizationInitializationPort,
  WorkspaceSandboxAuthorizationInitializationPortService
>()("arbor/WorkspaceSandboxAuthorizationInitializationPort") {}
