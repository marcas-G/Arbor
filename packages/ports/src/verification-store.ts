import type {
  Acceptance,
  ConclusionReason,
  EvidenceId,
  ExecutionId,
  ProjectId,
  Verification,
  VerificationId,
  VerificationMission,
  VerificationVerdict,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type VerificationRepositoryError =
  RepositoryFailure<"VerificationRepository">;
export type AcceptanceRepositoryError =
  RepositoryFailure<"AcceptanceRepository">;
export type EvidenceRepositoryError = RepositoryFailure<"EvidenceRepository">;

export interface EvidenceRecordRow {
  readonly evidenceId: EvidenceId;
  readonly verificationId: VerificationId;
  readonly criterionId: string;
  readonly kind: string;
  readonly artifactRef: string | null;
  readonly observedEnvironmentRevision: string | null;
  readonly recordedByExecutionId: ExecutionId;
  readonly recordedAt: string;
}

/** P8 `01`/`02`: verification aggregate persistence; one-Open-per-revision
 * enforced by the partial unique index (v1.11 G2). */
export interface VerificationRepositoryService {
  readonly insert: (
    verification: Verification,
    projectId: ProjectId,
    ownerWorkspaceId: WorkspaceId,
  ) => Effect.Effect<void, VerificationRepositoryError, TransactionScope>;
  readonly findById: (
    verificationId: VerificationId,
  ) => Effect.Effect<
    Option.Option<Verification>,
    VerificationRepositoryError,
    TransactionScope
  >;
  readonly findOpenByWorkRevision: (
    workId: WorkId,
    targetWorkRevision: number,
  ) => Effect.Effect<
    Option.Option<Verification>,
    VerificationRepositoryError,
    TransactionScope
  >;
  /** P8 `02` §3 settle-without-conclude scan face: every Open row (the
   * orphan check filters bound executions itself). */
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<Verification>,
    VerificationRepositoryError,
    TransactionScope
  >;
  /** Conclude CAS: only an Open row at this id transitions. */
  readonly concludeIfOpen: (
    verificationId: VerificationId,
    verdict: VerificationVerdict,
    conclusionReason: ConclusionReason | undefined,
  ) => Effect.Effect<
    Option.Option<Verification>,
    VerificationRepositoryError,
    TransactionScope
  >;
  readonly bindExecution: (
    verificationId: VerificationId,
    executionId: ExecutionId,
    boundAt: string,
  ) => Effect.Effect<void, VerificationRepositoryError, TransactionScope>;
}

export class VerificationRepository extends Context.Service<
  VerificationRepository,
  VerificationRepositoryService
>()("arbor/VerificationRepository") {}

/** P8 `04` §1: append-only evidence. */
export interface EvidenceRepositoryService {
  readonly append: (
    record: EvidenceRecordRow,
  ) => Effect.Effect<void, EvidenceRepositoryError, TransactionScope>;
  readonly listByVerification: (
    verificationId: VerificationId,
  ) => Effect.Effect<
    ReadonlyArray<EvidenceRecordRow>,
    EvidenceRepositoryError,
    TransactionScope
  >;
}

export class EvidenceRepository extends Context.Service<
  EvidenceRepository,
  EvidenceRepositoryService
>()("arbor/EvidenceRepository") {}

/** P8 `01` §4: acceptance records; double uniqueness (acceptanceId PK +
 * one acceptance per (workId, targetWorkRevision)). */
export interface AcceptanceRepositoryService {
  readonly insert: (
    acceptance: Acceptance,
    projectId: ProjectId,
  ) => Effect.Effect<void, AcceptanceRepositoryError, TransactionScope>;
  readonly findByWorkRevision: (
    workId: WorkId,
    targetWorkRevision: number,
  ) => Effect.Effect<
    Option.Option<Acceptance>,
    AcceptanceRepositoryError,
    TransactionScope
  >;
}

export class AcceptanceRepository extends Context.Service<
  AcceptanceRepository,
  AcceptanceRepositoryService
>()("arbor/AcceptanceRepository") {}

export type { Verification, VerificationMission };
