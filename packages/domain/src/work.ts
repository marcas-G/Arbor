import type { Acceptance } from "./dependency.js";
import type { ProjectId, WorkId, WorkspaceId } from "./ids.js";
import { incrementOrdinal, WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";
import type { Verification, VerificationMission } from "./verification.js";

export type WorkLifecycle = "Open" | "Completed" | "Cancelled";

export interface Provenance {
  readonly predecessorWorkId: WorkId | null;
  readonly reason: string;
}

export interface Work {
  readonly workId: WorkId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: VerificationMission;
  readonly provenance: Provenance;
  readonly lifecycle: WorkLifecycle;
  readonly revision: WorkRevision;
}

export interface AssignWorkInput {
  readonly workId: WorkId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: VerificationMission;
  readonly provenance: Provenance;
  readonly revision: WorkRevision;
  readonly authorized: boolean;
  readonly workspaceAcceptsWork: boolean;
}

export const assignWork = (input: AssignWorkInput): DomainResult<Work> => {
  if (!input.workspaceAcceptsWork) {
    return err({
      _tag: "RetirePreconditionFailed",
      workspaceId: input.workspaceId,
      reason: "workspace does not accept new work",
    });
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "AssignWork requires authority",
    });
  }
  return ok({
    workId: input.workId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    objective: input.objective,
    why: input.why,
    constraints: input.constraints,
    completionExpectation: input.completionExpectation,
    verificationMission: input.verificationMission,
    provenance: input.provenance,
    lifecycle: "Open",
    revision: input.revision,
  });
};

const terminalError = () => ({
  _tag: "TerminalLifecycleMutation" as const,
  entity: "Work",
  lifecycle: "terminal",
});

export interface RefineWorkInput {
  readonly authorized: boolean;
  readonly weakensProtectedRequirements: boolean;
  readonly objective?: string;
  readonly completionExpectation?: string;
  readonly verificationMission?: VerificationMission;
}

export const refineWork = (
  work: Work,
  input: RefineWorkInput,
): DomainResult<Work> => {
  if (work.lifecycle !== "Open") {
    return err(terminalError());
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "RefineWork requires authority",
    });
  }
  if (input.weakensProtectedRequirements) {
    return err({
      _tag: "AuthorityDenied",
      reason:
        "producer cannot weaken protected Objective / CompletionExpectation / VerificationMission",
    });
  }
  return ok({
    ...work,
    objective: input.objective ?? work.objective,
    completionExpectation:
      input.completionExpectation ?? work.completionExpectation,
    verificationMission: input.verificationMission ?? work.verificationMission,
    revision: incrementOrdinal(WorkRevision)(work.revision),
  });
};

export interface SteerWorkInput extends RefineWorkInput {}

export const steerWork = (
  work: Work,
  input: SteerWorkInput,
): DomainResult<Work> => refineWork(work, input);

const evidenceMismatch = (workId: WorkId) => ({
  _tag: "VerificationAcceptanceMismatch" as const,
  workId,
});

export const completeWork = (
  work: Work,
  verification: Verification,
  acceptance: Acceptance,
): DomainResult<Work> => {
  if (work.lifecycle !== "Open") {
    return err(terminalError());
  }
  if (verification.workId !== work.workId) {
    return err(evidenceMismatch(work.workId));
  }
  if (verification.targetWorkRevision !== work.revision) {
    return err(evidenceMismatch(work.workId));
  }
  if (
    verification.state.status !== "Concluded" ||
    verification.state.verdict !== "Pass"
  ) {
    return err(evidenceMismatch(work.workId));
  }
  if (acceptance.workId !== work.workId) {
    return err(evidenceMismatch(work.workId));
  }
  if (acceptance.targetWorkRevision !== work.revision) {
    return err(evidenceMismatch(work.workId));
  }
  if (acceptance.verificationId !== verification.verificationId) {
    return err(evidenceMismatch(work.workId));
  }
  return ok({ ...work, lifecycle: "Completed" });
};

export interface CancelWorkInput {
  readonly authorized: boolean;
}

export const cancelWork = (
  work: Work,
  input: CancelWorkInput,
): DomainResult<Work> => {
  if (work.lifecycle !== "Open") {
    return err(terminalError());
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "CancelWork requires governance authority",
    });
  }
  return ok({ ...work, lifecycle: "Cancelled" });
};

export const isWorkOpen = (work: Work): boolean => work.lifecycle === "Open";

export const isWorkTerminal = (work: Work): boolean =>
  work.lifecycle !== "Open";

export const isWorkCurrent = (
  work: Work,
  currentWorkId: WorkId | null,
): boolean => currentWorkId !== null && currentWorkId === work.workId;
