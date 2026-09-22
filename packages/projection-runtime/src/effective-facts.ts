import type {
  Dependency,
  InboxEntry,
  ProducerBinding,
  ProjectId,
  ResourceBoundary,
  ResourceBoundaryRevision,
  ResponsibilityDefinition,
  ResponsibilityRevision,
  Revision,
  Verification,
  Work,
  WorkId,
  WorkLifecycle,
  Workspace,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "./errors.js";
import { projectionReadError } from "./errors.js";

// --- P10 `03` §1 (GQ2): the single shared canonical-state-derived
// projection ------------------------------------------------------------
//
// SINGLE-SOURCE NOTE (GQ2): the P3 Context Builder READS this projection
// and must not re-derive a second copy; the UI reads the same. This module
// is the only derivation of the frozen input set inside projection-runtime
// — consumers import `deriveEffectiveFacts`, never re-assemble the inputs.
//
// P3's own freshness gating for action admission (ControlBasis /
// DecisionStale, DID §8.19) is P3-owned and unchanged: this projection
// only supplies facts; it never decides admission.

/** Frozen definition-input names (P10 `03` §1) — no more, no less. */
export const EFFECTIVE_FACTS_INPUTS = [
  "responsibility",
  "boundary",
  "policyCaps",
  "openDependencies",
  "currentWork",
  "openVerifications",
  "unconsumedInboxMarkers",
] as const;

export type EffectiveFactsInputName = (typeof EFFECTIVE_FACTS_INPUTS)[number];

/** Open Dependency marker — state + binding exactly (P10 `03` §1). */
export interface OpenDependencyMarker {
  readonly dependencyId: string;
  readonly state: Dependency["state"];
  readonly binding: ProducerBinding;
}

/** Current Work marker (identity + phase facts). */
export interface CurrentWorkMarker {
  readonly workId: WorkId;
  readonly objective: string;
  readonly lifecycle: WorkLifecycle;
}

/** Open Verification marker (identity + revision target). */
export interface OpenVerificationMarker {
  readonly verificationId: string;
  readonly workId: WorkId;
  readonly targetWorkRevision: number;
}

/** Unconsumed Inbox marker (identity + summary + arrival). */
export interface UnconsumedInboxMarker {
  readonly entryKey: string;
  readonly kind: InboxEntry["kind"];
  readonly summary: string;
  readonly admittedAt: string;
}

/** The frozen definition inputs — exactly EFFECTIVE_FACTS_INPUTS keys
 * (one key per input; revisions ride inside their input). */
export interface EffectiveFacts {
  /** Responsibility at its current revision. */
  readonly responsibility: {
    readonly definition: ResponsibilityDefinition;
    readonly revision: ResponsibilityRevision;
  };
  /** ResourceBoundary at its current revision. */
  readonly boundary: {
    readonly boundary: ResourceBoundary;
    readonly revision: ResourceBoundaryRevision;
  };
  /** Workspace policy caps at their current revision. */
  readonly policyCaps: {
    readonly policy: WorkspacePolicy;
    readonly revision: Revision;
  };
  /** Open Dependencies (state, binding). */
  readonly openDependencies: ReadonlyArray<OpenDependencyMarker>;
  /** Current Work (Work row referenced by workspaces.current_work_id). */
  readonly currentWork: CurrentWorkMarker | null;
  /** Open Verifications. */
  readonly openVerifications: ReadonlyArray<OpenVerificationMarker>;
  /** Unconsumed Inbox markers. */
  readonly unconsumedInboxMarkers: ReadonlyArray<UnconsumedInboxMarker>;
}

/** Snapshot = the frozen facts plus the GQ5 watermark it reflects. */
export interface EffectiveFactsSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly facts: EffectiveFacts;
  readonly watermark: number;
}

/** Read faces EffectiveFacts derives from (read-only over canonical
 * tables; injected — the package owns no storage and never writes). */
export interface EffectiveFactsDeps {
  readonly findWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Workspace>, ProjectionReadError>;
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly listWorksByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Work>, ProjectionReadError>;
  /** Every dependency whose consumer work belongs to the workspace
   * (the open/state filter is applied by the derive, not the face). */
  readonly listDependenciesByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Dependency>, ProjectionReadError>;
  /** Verifications targeting the workspace's works (Open filter applied
   * by the derive). */
  readonly listVerificationsByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Verification>, ProjectionReadError>;
  readonly listUnconsumedInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<InboxEntry>, ProjectionReadError>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
}

/** Materialize the EffectiveFacts snapshot for one workspace — the
 * on-read derive half of "incremental via generic consumer + on-read
 * derive for joins" (P10 `03` §1). Zero canonical mutation. */
export const deriveEffectiveFacts = (
  workspaceId: WorkspaceId,
  deps: EffectiveFactsDeps,
): Effect.Effect<EffectiveFactsSnapshot, ProjectionReadError> =>
  Effect.gen(function* () {
    const found = yield* deps.findWorkspace(workspaceId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        projectionReadError(`no workspace ${workspaceId}`),
      );
    }
    const workspace = found.value;

    let currentWork: CurrentWorkMarker | null = null;
    if (workspace.currentWorkId !== null) {
      const work = yield* deps.findWork(workspace.currentWorkId);
      if (Option.isNone(work)) {
        return yield* Effect.fail(
          projectionReadError(
            `workspace ${workspaceId} currentWorkId ${workspace.currentWorkId} has no work row`,
          ),
        );
      }
      currentWork = {
        workId: work.value.workId,
        objective: work.value.objective,
        lifecycle: work.value.lifecycle,
      };
    }

    const dependencies = yield* deps.listDependenciesByWorkspace(workspaceId);
    const verifications = yield* deps.listVerificationsByWorkspace(workspaceId);
    const inbox = yield* deps.listUnconsumedInbox(workspaceId);
    const watermark = yield* deps.journalLastSequence(workspace.projectId);

    const facts: EffectiveFacts = {
      responsibility: {
        definition: workspace.responsibilityDefinition,
        revision: workspace.responsibilityRevision,
      },
      boundary: {
        boundary: workspace.resourceBoundary,
        revision: workspace.resourceBoundaryRevision,
      },
      policyCaps: {
        policy: workspace.workspacePolicy,
        revision: workspace.workspacePolicyRevision,
      },
      openDependencies: dependencies
        .filter((dependency) => dependency.state === "Unsatisfied")
        .map((dependency) => ({
          dependencyId: dependency.dependencyId,
          state: dependency.state,
          binding: dependency.producerBinding,
        })),
      currentWork,
      openVerifications: verifications
        .filter((verification) => verification.state.status === "Open")
        .map((verification) => ({
          verificationId: verification.verificationId,
          workId: verification.workId,
          targetWorkRevision: verification.targetWorkRevision,
        })),
      unconsumedInboxMarkers: inbox.map((entry) => ({
        entryKey: entry.entryKey,
        kind: entry.kind,
        summary: entry.summary,
        admittedAt: entry.admittedAt,
      })),
    };

    return { workspaceId, facts, watermark };
  });
