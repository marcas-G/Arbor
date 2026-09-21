import { createHash } from "node:crypto";
import {
  type ChildWorkspaceProposal,
  CommandId,
  ContextEpochNumber,
  FormationProposalId,
  type FormationProposalRecord,
  makeWorkspacePolicy,
  type Principal,
  type ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { VerifiedCommandAuthority } from "./authority.js";
import { semanticRequestFingerprint } from "./fingerprint.js";

/** Deterministic uuid-v7-shaped id from a seed (P6 `01` §4.2/§4.3). */
const deterministicUuid = (seed: string): string => {
  const digest = createHash("sha256").update(seed).digest("hex");
  const hex = (offset: number, length: number) =>
    digest.slice(offset, offset + length);
  return [
    hex(0, 8),
    hex(8, 4),
    `7${hex(13, 3)}`,
    `8${hex(17, 3)}`,
    hex(20, 12),
  ].join("-");
};

/** Salted deterministic uuid-v7 for caller-preallocated ids. */
export const newUuid7 = (salt: string, seed: string): string =>
  deterministicUuid(`${salt}:${seed}`);

/** Fresh caller-preallocated FormationProposalId (uuid v7 shape). */
export const newFormationProposalId = (): FormationProposalId => {
  const ts = Date.now().toString(16).padStart(12, "0");
  const rand = createHash("sha256")
    .update(`${ts}:${Math.random()}`)
    .digest("hex");
  const uuid = [
    ts.slice(4, 12),
    ts.slice(0, 4),
    `7${rand.slice(0, 3)}`,
    `8${rand.slice(3, 6)}`,
    rand.slice(6, 18),
  ].join("-");
  return parse(FormationProposalId)(`fpr_${uuid}`);
};

export interface FormationIds {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly workId: WorkId;
  readonly createCommandId: CommandId;
  readonly assignCommandId: CommandId;
}

/** Deterministic identity set for a formation plan (caller-preallocated). */
export const deriveFormationIds = (
  proposalId: FormationProposalId,
  revision: number,
): FormationIds => {
  const uuid = proposalId.slice("fpr_".length);
  const cmd = (salt: string) =>
    parse(CommandId)(
      `cmd_${deterministicUuid(`formation:${salt}:${proposalId}:${revision}`)}`,
    );
  return {
    workspaceId: parse(WorkspaceId)(`ws_${uuid}`),
    sessionId: parse(SessionId)(`ses_${uuid}`),
    workId: parse(WorkId)(`wrk_${uuid}`),
    createCommandId: cmd("create"),
    assignCommandId: cmd("assign"),
  };
};

export interface FormationCreatePlan {
  readonly payload: {
    readonly parentWorkspaceId: WorkspaceId;
    readonly workspaceId: WorkspaceId;
    readonly primarySession: {
      readonly sessionId: SessionId;
      readonly contextEpoch: ContextEpochNumber;
    };
    readonly name: string;
    readonly responsibilityDefinition: ChildWorkspaceProposal["responsibilityDraft"];
    readonly responsibilityRevision: ResponsibilityRevision;
    readonly resourceBoundary: ChildWorkspaceProposal["resourceBoundaryDraft"];
    readonly resourceBoundaryRevision: ResourceBoundaryRevision;
    readonly agentBinding: ReturnType<typeof responsibilityBound>;
    readonly workspacePolicy: ReturnType<typeof makeWorkspacePolicy>;
    readonly workspacePolicyRevision: Revision;
    readonly revision: Revision;
  };
  readonly authority: VerifiedCommandAuthority;
}

export const formationCreatePlan = (args: {
  readonly snapshot: FormationProposalRecord;
  readonly ids: FormationIds;
  readonly projectId: ProjectId;
  readonly actor: PendingDomainEvent["actor"];
  readonly principal: Principal;
}): FormationCreatePlan => {
  const payload = {
    parentWorkspaceId: args.snapshot.parentWorkspaceId,
    workspaceId: args.ids.workspaceId,
    primarySession: {
      sessionId: args.ids.sessionId,
      contextEpoch: parse(ContextEpochNumber)(0),
    },
    name: args.snapshot.proposal.name,
    responsibilityDefinition: args.snapshot.proposal.responsibilityDraft,
    responsibilityRevision: parse(ResponsibilityRevision)(1),
    resourceBoundary: args.snapshot.proposal.resourceBoundaryDraft,
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
    agentBinding: responsibilityBound(args.ids.workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  };
  return {
    payload,
    authority: {
      _tag: "CreateChildWorkspaceAuthority",
      principal: args.principal,
      commandId: args.ids.createCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateChildWorkspace",
        projectId: args.projectId,
        actor: args.actor,
        schemaVersion: "1",
        payload,
      }),
      projectId: args.projectId,
      parentWorkspaceId: args.snapshot.parentWorkspaceId,
    },
  };
};

export interface FormationAssignPlan {
  readonly payload: {
    readonly workId: WorkId;
    readonly workspaceId: WorkspaceId;
    readonly expectedWorkspaceRevision: Revision;
    readonly objective: string;
    readonly why: string;
    readonly constraints: ReadonlyArray<string>;
    readonly completionExpectation: string;
    readonly verificationMission: {
      readonly goal: string;
      readonly criteria: ReadonlyArray<string>;
      readonly riskRequirements: ReadonlyArray<string>;
    };
    readonly provenance: { predecessorWorkId: null; reason: string };
    readonly revision: WorkRevision;
  };
  readonly authority: VerifiedCommandAuthority;
}

/** P6 `01` §2: the placeholder mission is the P6-frozen minimal form; P8
 * owns Verification semantics. */
export const formationAssignPlan = (args: {
  readonly snapshot: FormationProposalRecord;
  readonly ids: FormationIds;
  readonly projectId: ProjectId;
  readonly actor: PendingDomainEvent["actor"];
  readonly principal: Principal;
}): FormationAssignPlan | null => {
  const initialWork = args.snapshot.proposal.initialWork;
  if (initialWork === undefined) {
    return null;
  }
  const payload = {
    workId: args.ids.workId,
    workspaceId: args.ids.workspaceId,
    expectedWorkspaceRevision: parse(Revision)(0),
    objective: initialWork.objective,
    why: initialWork.why,
    constraints: initialWork.constraints,
    completionExpectation: initialWork.completionExpectation,
    verificationMission: {
      goal: "p6-placeholder",
      criteria: [],
      riskRequirements: [],
    },
    provenance: {
      predecessorWorkId: null,
      reason: `formation:${args.snapshot.proposalId}`,
    },
    revision: parse(WorkRevision)(0),
  };
  return {
    payload,
    authority: {
      _tag: "AssignWorkAuthority",
      principal: args.principal,
      commandId: args.ids.assignCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AssignWork",
        projectId: args.projectId,
        actor: args.actor,
        schemaVersion: "1",
        payload,
      }),
      projectId: args.projectId,
      targetWorkspaceId: args.ids.workspaceId,
    },
  };
};

/** P6 `01` §4: deterministic depth computation — pure structure, no model.
 * `FirstLayer` means the proposer IS the root workspace (S1.4 step 4). */
export type FormationPath = "FirstLayer" | "DeepLayer";

export const formationPathOf = (parent: {
  readonly parentWorkspaceId: WorkspaceId | null;
}): FormationPath =>
  parent.parentWorkspaceId === null ? "FirstLayer" : "DeepLayer";

/** Structural validation for the model-supplied proposal payload (P3 `03`
 * leaves `spec: unknown`; P6 owns the shape). */
export const isChildWorkspaceProposal = (
  value: unknown,
): value is ChildWorkspaceProposal => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.rationale === "string" &&
    typeof candidate.responsibilityDraft === "object" &&
    candidate.responsibilityDraft !== null &&
    typeof candidate.resourceBoundaryDraft === "object" &&
    candidate.resourceBoundaryDraft !== null &&
    (candidate.initialWork === undefined ||
      typeof candidate.initialWork === "object")
  );
};
