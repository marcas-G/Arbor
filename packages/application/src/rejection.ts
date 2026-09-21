import type {
  DeliverableId,
  DependencyId,
  DomainError,
  ExecutionId,
  FormationProposalId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";

export type CommandRejection =
  | DomainError
  | { readonly _tag: "FencingRejected" }
  | { readonly _tag: "ExecutionStopping" }
  | {
      readonly _tag: "WorkspaceNotFound";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly _tag: "ExecutionNotFound";
      readonly executionId: ExecutionId;
    }
  | {
      /** P6 `04` §2: P6-frozen enum (P1 did not define it). */
      readonly _tag: "WorkNotFound";
      readonly workId: WorkId;
    }
  | {
      /** P6 `01` §4.2: governance-entity lookup rejection. */
      readonly _tag: "FormationProposalNotFound";
      readonly proposalId: FormationProposalId;
    }
  | {
      /** P6 `02` §3: P6-frozen enum (bodyRef upload quota exceeded). */
      readonly _tag: "ResourceExhausted";
      readonly reason: string;
    }
  | {
      /** P7 `01` §4: P7-frozen enum. */
      readonly _tag: "DependencyNotFound";
      readonly dependencyId: DependencyId;
    }
  | {
      /** P7 `01` §4: P7-frozen enum. */
      readonly _tag: "DeliverableNotFound";
      readonly deliverableId: DeliverableId;
    };
