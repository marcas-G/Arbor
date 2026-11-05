import {
  admitExecution,
  assignWork,
  createWorkspace,
  type Execution,
  ExecutionId,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  startVerification,
  type Verification,
  VerificationId,
  type Work,
  WorkId,
  WorkRevision,
  type Workspace,
  WorkspaceId,
} from "@arbor/domain";

/** Build a complete Verification ADT for tests without casting partial rows. */
export const makeVerificationFixture = (input: {
  readonly verificationId: string;
  readonly workId: string;
  readonly targetWorkRevision?: number;
  readonly verdict?: "Pass" | "Fail" | "Unknown";
}): Verification => {
  const verification = startVerification({
    verificationId: parse(VerificationId)(input.verificationId),
    workId: parse(WorkId)(input.workId),
    targetWorkRevision: parse(WorkRevision)(input.targetWorkRevision ?? 0),
    missionSnapshot: {
      goal: "test verification",
      criteria: [],
      riskRequirements: [],
    },
  });
  if (input.verdict === undefined) return verification;
  return {
    ...verification,
    state: { status: "Concluded", verdict: input.verdict },
  };
};

/** Build a complete Workspace ADT for adapter/application tests. */
export const makeWorkspaceFixture = (input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly resourcePath: string;
  readonly parentWorkspaceId?: string | null;
  readonly currentWorkId?: string | null;
  readonly lifecycle?: "Active" | "Retired";
  readonly revision?: number;
}): Workspace => ({
  ...createWorkspace({
    workspaceId: parse(WorkspaceId)(input.workspaceId),
    projectId: parse(ProjectId)(input.projectId),
    parentWorkspaceId:
      input.parentWorkspaceId === undefined || input.parentWorkspaceId === null
        ? null
        : parse(WorkspaceId)(input.parentWorkspaceId),
    name: "test workspace",
    responsibilityDefinition: {
      purpose: "test responsibility",
      ownedResponsibilities: [],
      obligations: [],
      includes: [],
      excludes: [],
      interfaces: [],
    },
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: input.resourcePath }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(parse(WorkspaceId)(input.workspaceId)),
    primarySessionId: parse(SessionId)(input.sessionId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(input.revision ?? 0),
  }),
  currentWorkId:
    input.currentWorkId === undefined || input.currentWorkId === null
      ? null
      : parse(WorkId)(input.currentWorkId),
  lifecycle: input.lifecycle ?? "Active",
});

export const makeWorkFixture = (input: {
  readonly workId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly objective?: string;
}): Work => {
  const result = assignWork({
    workId: parse(WorkId)(input.workId),
    projectId: parse(ProjectId)(input.projectId),
    workspaceId: parse(WorkspaceId)(input.workspaceId),
    objective: input.objective ?? "test objective",
    why: "test why",
    constraints: [],
    completionExpectation: "test completion",
    verificationMission: {
      goal: "test verification",
      criteria: [],
      riskRequirements: [],
    },
    provenance: { predecessorWorkId: null, reason: "test" },
    revision: parse(WorkRevision)(0),
    authorized: true,
    workspaceAcceptsWork: true,
  });
  if (!result.ok) throw new Error(`invalid work fixture: ${result.error._tag}`);
  return result.value;
};

export const makeWorkExecutionFixture = (input: {
  readonly executionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workId: string;
}): Execution => {
  const result = admitExecution({
    executionId: parse(ExecutionId)(input.executionId),
    projectId: parse(ProjectId)(input.projectId),
    workspaceId: parse(WorkspaceId)(input.workspaceId),
    sessionId: parse(SessionId)(input.sessionId),
    binding: {
      _tag: "WorkspaceExecution",
      workspaceId: parse(WorkspaceId)(input.workspaceId),
      episode: {
        _tag: "WorkEpisode",
        workId: parse(WorkId)(input.workId),
        targetWorkRevision: parse(WorkRevision)(0),
      },
    },
    admittedAt: "2026-01-01T00:00:00.000Z",
    noOtherActiveMain: true,
  });
  if (!result.ok)
    throw new Error(`invalid execution fixture: ${result.error._tag}`);
  return result.value;
};

export const makeExecutionBoundFixture = (input: {
  readonly executionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly mission: string;
}): Execution => {
  const result = admitExecution({
    executionId: parse(ExecutionId)(input.executionId),
    projectId: parse(ProjectId)(input.projectId),
    workspaceId: parse(WorkspaceId)(input.workspaceId),
    sessionId: parse(SessionId)(input.sessionId),
    binding: {
      _tag: "ExecutionBoundAgentBinding",
      parentExecutionId: null,
      mission: input.mission,
    },
    admittedAt: "2026-01-01T00:00:00.000Z",
    noOtherActiveMain: true,
  });
  if (!result.ok)
    throw new Error(`invalid execution fixture: ${result.error._tag}`);
  return result.value;
};
