import type {
  DeliverableId,
  DependencyId,
  DomainError,
  ExecutionId,
  FormationProposalId,
  VerificationId,
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
    }
  | {
      /** P8 `01` §1: P8-frozen enum (v1.11 G2 one-Open-per-revision). */
      readonly _tag: "VerificationAlreadyOpen";
      readonly workId: WorkId;
    }
  | {
      /** P8 `01` §1: P8-frozen enum (structured mission validation, v1.11 G1). */
      readonly _tag: "InvalidVerificationMission";
      readonly reason: string;
    }
  | {
      /** P8 `01` §4/§5: P8-frozen enum (verification lookup rejection). */
      readonly _tag: "VerificationNotFound";
      readonly verificationId: VerificationId;
    }
  | {
      /** P8 `01` §4: P8-frozen double-uniqueness typed rejection — at most
       * one acceptance per (workId, targetWorkRevision). Same-acceptanceId
       * replays above the gateway are receipt dedup; everything reaching
       * the handler lands here (the repository unique index is the
       * concurrency backstop). */
      readonly _tag: "AcceptanceAlreadyExists";
      readonly workId: WorkId;
    };
