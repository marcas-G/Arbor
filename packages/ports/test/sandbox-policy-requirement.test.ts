import {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  Sha256,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
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
    workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    targetWorkRevision: parse(WorkRevision)(5),
  },
  expectedEpisodeRevision: 4,
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  logicalStepNo: 2,
  repairAttempt: 0,
  logicalActionId: "action-1",
  actionIndex: 1,
  callRef: "call-1",
  actionRevision: 3,
  inputHash: parse(Sha256)("a".repeat(64)),
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
      "_tag",
      "version",
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
      "approvalState",
      "approvalRevision",
      "approvalConsumedBy",
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
          targetWorkRevision: parse(WorkRevision)(6),
        },
      }),
    ).toBe(false);
    expect(
      sameSandboxPolicyPreIntentRequirement(requirement, {
        ...requirement,
        episodeBinding: {
          ...requirement.episodeBinding,
          workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2"),
        },
      }),
    ).toBe(false);
  });
});
