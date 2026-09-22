import type {
  CanonicalResourceRegion,
  EnvironmentFingerprint,
  ProjectId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { PendingDomainEvent } from "./journal.js";
import type { TransactionScope } from "./session.js";

export type EnvironmentChangeCause =
  | "ExternalDrift"
  | "Governance"
  | "WorktreeLifecycle";

/** A full environment observation produced by a prober (real resolver in
 * P11-003; fake in tests). Observation-only by contract — producing this
 * never advances anything. */
export interface EnvironmentObservation {
  readonly projectId: ProjectId;
  readonly observedRevision: string;
  readonly fingerprint: EnvironmentFingerprint;
  readonly snapshotBlobRef: string;
  readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
}

/** The re-probe seam (P11 `03` §1 / B4): given a conflict, obtain ONE fresh
 * full observation. Implemented by the real resolver in P11-003; a fake in
 * this task's tests drives the control flow. The previous observation's
 * fingerprint/changedRegions must NOT be reused — the seam returns a
 * complete new observation or fails. */
export interface EnvironmentReProbe {
  readonly reprobe: (
    projectId: ProjectId,
  ) => Effect.Effect<
    EnvironmentObservation,
    { readonly _tag: "ReProbeFailed"; readonly cause: unknown },
    never
  >;
}

export class EnvironmentReProbePort extends Context.Service<
  EnvironmentReProbePort,
  EnvironmentReProbe
>()("arbor/EnvironmentReProbe") {}

/** Persisted change record row (environment_changes). */
export interface EnvironmentChangeRecord {
  readonly changeId: string;
  readonly projectId: ProjectId;
  readonly fromRevision: string;
  readonly toRevision: string;
  readonly previousFingerprint: string;
  readonly nextFingerprint: string;
  readonly snapshotBlobRef: string;
  readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
  readonly cause: EnvironmentChangeCause;
  readonly recordedAt: string;
}

export type RecordEnvironmentChangeOutcome =
  | {
      readonly _tag: "Advanced";
      readonly fromRevision: string;
      readonly toRevision: string;
    }
  | {
      readonly _tag: "NoChange";
      readonly atRevision: string;
      readonly fingerprint: string;
    }
  | { readonly _tag: "AnchorMissing" }
  | {
      readonly _tag: "SecondConflictEscalatedToAttention";
      readonly currentRevision: string;
    }
  | { readonly _tag: "FirstConflictReProbing" };

export interface RecordEnvironmentChangeService {
  readonly record: (
    observation: EnvironmentObservation,
    cause: EnvironmentChangeCause,
  ) => Effect.Effect<
    RecordEnvironmentChangeOutcome,
    | { readonly _tag: "ChangePersistenceFailure"; readonly cause: unknown }
    | { readonly _tag: "ReProbeFailed"; readonly cause: unknown },
    TransactionScope
  >;
  readonly latestChange: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<EnvironmentChangeRecord>,
    { readonly _tag: "ChangePersistenceFailure"; readonly cause: unknown },
    TransactionScope
  >;
}

export class RecordEnvironmentChange extends Context.Service<
  RecordEnvironmentChange,
  RecordEnvironmentChangeService
>()("arbor/RecordEnvironmentChange") {}

/** Outbox facts produced by a successful REC commit (same transaction as
 * the anchor advancement + change record — the caller persists/journals
 * them inside that boundary; see implementation). */
export interface RecCommitFacts {
  readonly change: EnvironmentChangeRecord;
  readonly event: PendingDomainEvent;
  readonly wakeTargets: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workId: string;
    readonly fromRevision: string;
    readonly toRevision: string;
  }>;
}
