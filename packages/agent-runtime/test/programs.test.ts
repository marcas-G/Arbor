import {
  Actor,
  CommandId,
  ExecutionId,
  FormationProposalId,
  type FormationProposalRecord,
  Principal,
  ProjectId,
  parse,
  type ResourceBoundary,
  type ResponsibilityDefinition,
  VerificationId,
  type VerificationMission,
  type Work,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../../application/src/command-result.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
  type StartVerificationResult,
} from "../../application/src/commands/start-verification.js";
import {
  deriveFormationIds,
  formationAssignPlan,
} from "../../application/src/formation-plan.js";
import type {
  CommandOutcome,
  GatewayEnvelope,
} from "../../application/src/gateway.js";

describe("M-2 placeholder mission migration", () => {
  const ACTOR = parse(Actor)("user:gov");
  const PRINCIPAL = parse(Principal)("user:gov");
  const PROJECT = parse(ProjectId)("prj_00000000-0000-7000-8000-0000000000a1");
  const PARENT = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000a2");
  const WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a3");
  const COMMAND = parse(CommandId)("cmd_00000000-0000-7000-8000-0000000000a4");
  const VERIFICATION = parse(VerificationId)(
    "ver_00000000-0000-7000-8000-0000000000a5",
  );
  const EXECUTION = parse(ExecutionId)(
    "exe_00000000-0000-7000-8000-0000000000a6",
  );
  const PROPOSAL = parse(FormationProposalId)(
    "fpr_00000000-0000-7000-8000-0000000000a7",
  );

  const approvedSnapshot = (): FormationProposalRecord => ({
    proposalId: PROPOSAL,
    parentWorkspaceId: PARENT,
    proposal: {
      name: "child",
      rationale: "r",
      responsibilityDraft: {} as ResponsibilityDefinition,
      resourceBoundaryDraft: {} as ResourceBoundary,
      initialWork: {
        objective: "o",
        why: "w",
        constraints: [],
        completionExpectation: "c",
        verificationMission: {
          goal: "verify o",
          criteria: [
            {
              criterionId: "done",
              requirement: "c",
              required: true,
            },
          ],
          riskRequirements: [],
        },
      },
    },
    revision: 1,
    state: "Approved",
  });

  const formationMission = (): VerificationMission => {
    const plan = formationAssignPlan({
      snapshot: approvedSnapshot(),
      ids: deriveFormationIds(PROPOSAL, 1),
      projectId: PROJECT,
      actor: ACTOR,
      principal: PRINCIPAL,
    });
    expect(plan).not.toBeNull();
    return (plan as NonNullable<typeof plan>).payload.verificationMission;
  };

  const legacyMission: VerificationMission = {
    goal: "p6-placeholder",
    criteria: [],
    riskRequirements: [],
  };

  const runStartVerification = (mission: VerificationMission) => {
    const work: Work = {
      workId: WORK,
      projectId: PROJECT,
      workspaceId: PARENT,
      objective: "o",
      why: "w",
      constraints: [],
      completionExpectation: "c",
      verificationMission: mission,
      provenance: { predecessorWorkId: null, reason: "p8-programs" },
      lifecycle: "Open",
      revision: parse(WorkRevision)(0),
    };
    const handler = makeStartVerificationHandler({
      works: {
        findById: () => Effect.succeed(Option.some(work)),
      },
      verifications: {
        findOpenByWorkRevision: () => Effect.succeed(Option.none()),
        insert: () => Effect.succeed(undefined),
      },
      deliverables: {
        findById: () => Effect.die(new Error("unused")),
        listArtifacts: () => Effect.die(new Error("unused")),
      },
      environmentRevisions: {
        current: () => Effect.die(new Error("unused")),
      },
    });
    const envelope: GatewayEnvelope<StartVerificationPayload> = {
      commandType: "StartVerification",
      commandId: COMMAND,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: {
        verificationId: VERIFICATION,
        workId: WORK,
        observedWorkRevision: parse(WorkRevision)(0),
        missionSnapshot: mission,
        verifierExecutionId: EXECUTION,
        executableMission: false,
      },
    };
    return Effect.provideService(
      handler.execute(envelope, { _tag: "External", principal: PRINCIPAL }),
      TransactionScope,
      { session: { id: "p8-programs" } },
    );
  };

  it("formation preserves the explicitly proposed verification mission", () => {
    expect(formationMission()).toEqual({
      goal: "verify o",
      criteria: [
        {
          criterionId: "done",
          requirement: "c",
          required: true,
        },
      ],
      riskRequirements: [],
    });
  });

  it("StartVerification accepts the formation mission", async () => {
    const outcome: CommandResult<CommandOutcome<StartVerificationResult>> =
      await Effect.runPromise(runStartVerification(formationMission()));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.result.state).toBe("Open");
      expect(outcome.value.result.verifierExecutionId).toBe(EXECUTION);
      expect(outcome.value.events).toHaveLength(1);
      expect(outcome.value.events[0]?.eventType).toBe("VerificationStarted");
    }
  });

  it("StartVerification typed-rejects the legacy p6-placeholder mission", async () => {
    const outcome = await Effect.runPromise(
      runStartVerification(legacyMission),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error._tag).toBe("InvalidVerificationMission");
    }
  });
});
