import type {
  AcceptanceId,
  ArtifactId,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { WorkRepositoryError } from "./errors.js";
import type { TransactionOperationalFailure } from "./session.js";
import type {
  AcceptanceRepositoryError,
  VerificationRepositoryError,
} from "./verification-store.js";

export interface AcceptedWorkKnowledgeEntry {
  readonly _tag: "AcceptedWorkOutcome";
  readonly workId: WorkId;
  readonly workRevision: WorkRevision;
  readonly objective: string;
  readonly completionExpectation: string;
  readonly acceptanceId: AcceptanceId;
  readonly verificationId: VerificationId;
  readonly verificationSummaryRef: string | null;
  readonly artifactRefs: ReadonlyArray<ArtifactId>;
  readonly acceptedAt: string;
  readonly provenance: "CanonicalAcceptance";
}

export interface WorkspaceKnowledgeView {
  readonly workspaceId: WorkspaceId;
  readonly entries: ReadonlyArray<AcceptedWorkKnowledgeEntry>;
  readonly fingerprint: string;
}

export type WorkspaceKnowledgeReadError =
  | WorkRepositoryError
  | VerificationRepositoryError
  | AcceptanceRepositoryError
  | TransactionOperationalFailure;

export interface WorkspaceKnowledgePortService {
  readonly load: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<WorkspaceKnowledgeView, WorkspaceKnowledgeReadError>;
}

export class WorkspaceKnowledgePort extends Context.Service<
  WorkspaceKnowledgePort,
  WorkspaceKnowledgePortService
>()("arbor/WorkspaceKnowledgePort") {}
