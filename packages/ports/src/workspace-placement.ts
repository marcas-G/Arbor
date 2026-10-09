import type {
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { ResolvedChildPlacementRef } from "./assign-work-target-binding.js";
import type {
  WorkRepositoryError,
  WorkspaceRepositoryError,
} from "./errors.js";
import type { FormationProposalStoreError } from "./formation.js";
import type {
  FormationFulfillmentState,
  FormationFulfillmentStoreError,
} from "./formation-fulfillment.js";
import type { TransactionOperationalFailure } from "./session.js";
import type {
  AcceptanceRepositoryError,
  VerificationRepositoryError,
} from "./verification-store.js";

export interface WorkspacePlacementCandidate {
  readonly ref: string;
  readonly name: string;
  readonly responsibilitySummary: string;
  readonly currentWorkSummary: string | null;
  readonly openWorkCount: number;
  readonly readyResults: ReadonlyArray<{
    readonly resultRef: string;
    readonly objective: string;
    readonly workRevision: WorkRevision;
  }>;
  readonly revision: number;
}

export interface InFlightFormationSummary {
  readonly proposalRef: string;
  readonly proposedName: string;
  readonly responsibilitySummary: string;
  readonly initialWorkSummary: string | null;
  readonly governanceState: "Pending" | "Approved";
  readonly fulfillmentState: FormationFulfillmentState;
  readonly revision: number;
}

export interface WorkspacePlacementSnapshot {
  readonly current: WorkspacePlacementCandidate & { readonly ref: "current" };
  readonly directChildren: ReadonlyArray<WorkspacePlacementCandidate>;
  readonly inFlightFormations: ReadonlyArray<InFlightFormationSummary>;
  readonly nextCursor: string | null;
  readonly fingerprint: string;
}

export type WorkspacePlacementReadError =
  | FormationProposalStoreError
  | FormationFulfillmentStoreError
  | AcceptanceRepositoryError
  | TransactionOperationalFailure
  | WorkspaceRepositoryError
  | VerificationRepositoryError
  | WorkRepositoryError;

export interface WorkspacePlacementPortService {
  readonly list: (input: {
    readonly rootWorkspaceId: WorkspaceId;
    readonly cursor?: string;
    readonly query?: string;
  }) => Effect.Effect<WorkspacePlacementSnapshot, WorkspacePlacementReadError>;
  readonly resolveChildRef: (
    rootWorkspaceId: WorkspaceId,
    ref: string,
  ) => Effect.Effect<
    Option.Option<ResolvedChildPlacementRef>,
    WorkspacePlacementReadError
  >;
  readonly read: (
    rootWorkspaceId: WorkspaceId,
    ref: string,
  ) => Effect.Effect<
    Option.Option<WorkspacePlacementCandidate>,
    WorkspacePlacementReadError
  >;
  readonly resolveResultRef: (
    parentWorkspaceId: WorkspaceId,
    resultRef: string,
  ) => Effect.Effect<
    Option.Option<{
      readonly childWorkspaceId: WorkspaceId;
      readonly workId: WorkId;
      readonly workRevision: WorkRevision;
      readonly verificationId: VerificationId;
    }>,
    WorkspacePlacementReadError
  >;
}

export class WorkspacePlacementPort extends Context.Service<
  WorkspacePlacementPort,
  WorkspacePlacementPortService
>()("arbor/WorkspacePlacementPort") {}
