import { ExecutionId, ProjectId, parse, WorkspaceId } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  type SandboxPolicyPreIntentRequirementV1,
  sameSandboxPolicyPreIntentRequirement,
} from "../src/sandbox-policy-requirement.js";

const requirement = {
  _tag: "SandboxPolicyPreIntentRequirementV1",
  version: 1,
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  episodeBinding: {
    _tag: "WorkEpisode",
    workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1",
    targetWorkRevision: 5,
  },
  expectedEpisodeRevision: 4,
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  logicalStepNo: 2,
  repairAttempt: 0,
  logicalActionId: "action-1",
  actionIndex: 1,
  callRef: "call-1",
  actionRevision: 3,
  inputHash: "a".repeat(64),
  toolName: "shell",
  toolVersion: "shell-v1",
  approvalId: "approval-1",
  approvalState: "Pending",
  approvalRevision: 0,
  approvalConsumedBy: null,
  approvalExpiresAt: "2026-10-21T12:00:00.000Z",
} as const satisfies SandboxPolicyPreIntentRequirementV1;

describe("SandboxPolicyPreIntentRequirementV1", () => {
  it("compares the complete typed source tuple structurally", () => {
    expect(
      sameSandboxPolicyPreIntentRequirement(requirement, { ...requirement }),
    ).toBe(true);
    const fields = [
      "projectId",
      "workspaceId",
      "executionId",
      "expectedEpisodeRevision",
      "providerTurnId",
      "logicalStepNo",
      "repairAttempt",
      "logicalActionId",
      "actionIndex",
      "callRef",
      "actionRevision",
      "inputHash",
      "toolName",
      "toolVersion",
      "approvalId",
      "approvalRevision",
      "approvalExpiresAt",
    ] as const;
    for (const field of fields) {
      const changed = {
        ...requirement,
        [field]: `${requirement[field]}.changed`,
      };
      expect(
        sameSandboxPolicyPreIntentRequirement(
          requirement,
          changed as unknown as SandboxPolicyPreIntentRequirementV1,
        ),
        field,
      ).toBe(false);
    }
    expect(
      sameSandboxPolicyPreIntentRequirement(requirement, {
        ...requirement,
        episodeBinding: {
          ...requirement.episodeBinding,
          targetWorkRevision: 6,
        },
      }),
    ).toBe(false);
  });
});
