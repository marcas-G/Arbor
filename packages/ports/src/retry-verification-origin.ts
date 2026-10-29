import type {
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  VerificationId,
  WorkId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export const RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY =
  "A historical RetryVerification receipt has incomplete origin evidence.";

export interface RetryVerificationOriginRecord {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Principal;
  readonly sourceVerificationId: VerificationId;
  readonly sourceWorkId: WorkId;
  readonly successorVerificationId: VerificationId;
  readonly successorVerifierExecutionId: ExecutionId;
  readonly createdAt: string;
}

export interface RetryVerificationLegacyDispositionRecord {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly sourceWorkId: WorkId;
  readonly sourceVerificationId: VerificationId;
  readonly disposition: "UnboundLegacy";
  readonly reasonCode: "OriginEvidenceIncomplete";
  readonly createdAt: string;
}

export interface RetryVerificationUnboundLegacyInboxProjection {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly sourceWorkId: WorkId;
  readonly sourceVerificationId: VerificationId;
  readonly disposition: "UnboundLegacy";
  readonly reasonCode: "OriginEvidenceIncomplete";
  readonly ownerWorkspaceId: import("@arbor/domain").WorkspaceId;
  readonly recipientWorkspaceId: import("@arbor/domain").WorkspaceId;
  readonly rootWorkspaceId: import("@arbor/domain").WorkspaceId;
  readonly createdAt: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export type RetryVerificationOriginRepositoryError =
  RepositoryFailure<"RetryVerificationOriginRepository">;

export interface RetryVerificationOriginRepositoryService {
  readonly findOrigin: (
    commandId: CommandId,
  ) => Effect.Effect<
    Option.Option<RetryVerificationOriginRecord>,
    RetryVerificationOriginRepositoryError,
    TransactionScope
  >;
  readonly insertOrigin: (
    origin: RetryVerificationOriginRecord,
  ) => Effect.Effect<
    void,
    RetryVerificationOriginRepositoryError,
    TransactionScope
  >;
  readonly findLegacyDisposition: (
    commandId: CommandId,
  ) => Effect.Effect<
    Option.Option<RetryVerificationLegacyDispositionRecord>,
    RetryVerificationOriginRepositoryError,
    TransactionScope
  >;
  readonly listCurrentUnboundLegacyInbox: (
    recipientWorkspaceId: import("@arbor/domain").WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<RetryVerificationUnboundLegacyInboxProjection>,
    RetryVerificationOriginRepositoryError,
    TransactionScope
  >;
  readonly rebuildUnboundLegacyInboxProjections: (
    updatedAt: string,
  ) => Effect.Effect<
    number,
    RetryVerificationOriginRepositoryError,
    TransactionScope
  >;
}

export class RetryVerificationOriginRepository extends Context.Service<
  RetryVerificationOriginRepository,
  RetryVerificationOriginRepositoryService
>()("arbor/RetryVerificationOriginRepository") {}
