import type { FormationProposalId, WorkId, WorkspaceId } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type FormationFulfillmentState =
  | "AwaitingDecision"
  | "PendingApplication"
  | "WorkspaceCreated"
  | "Applied"
  | "Blocked";

export interface FormationFulfillmentRecord {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly expectedChildWorkspaceId: WorkspaceId;
  readonly expectedInitialWorkId: WorkId | null;
  readonly state: FormationFulfillmentState;
  readonly typedBlock: string | null;
  readonly lastAttemptAt: string | null;
  readonly revision: number;
}

export type FormationFulfillmentStoreError =
  RepositoryFailure<"FormationFulfillmentStore">;

export interface FormationFulfillmentStoreService {
  readonly put: (
    record: FormationFulfillmentRecord,
  ) => Effect.Effect<void, FormationFulfillmentStoreError, TransactionScope>;
  readonly findByProposal: (
    proposalId: FormationProposalId,
    proposalRevision: number,
  ) => Effect.Effect<
    Option.Option<FormationFulfillmentRecord>,
    FormationFulfillmentStoreError,
    TransactionScope
  >;
}

export class FormationFulfillmentStore extends Context.Service<
  FormationFulfillmentStore,
  FormationFulfillmentStoreService
>()("arbor/FormationFulfillmentStore") {}
