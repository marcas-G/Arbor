import {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ExecutableApprovalBinding,
  RecoveryBindingSourceIdentity,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { recoveryBindingIdentityMatches } from "../src/runtime.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a3",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a4",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a5");

const identity: RecoveryBindingSourceIdentity = {
  executionId,
  providerTurnId,
  logicalStepNo: 7,
  repairAttempt: 1,
  logicalActionId: "action-7",
  actionIndex: 2,
  callRef: "call-2",
};

const approvalBinding: ExecutableApprovalBinding = {
  executionId,
  logicalStepNo: identity.logicalStepNo,
  repairAttempt: identity.repairAttempt,
  actionIndex: identity.actionIndex,
  logicalActionId: identity.logicalActionId,
  projectId,
  workspaceId,
  subject: "user-1" as never,
  callRef: identity.callRef,
  toolInvocationId: invocationId,
  toolName: "patch",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson: "{}",
  actionDigest: "a".repeat(64),
  targetResourceSpaceIds: [],
  controlBasisDigest: "b".repeat(64),
};

describe("P4 RecoveryBinding source tuple validation", () => {
  it("accepts the exact execution, invocation callRef and approval action tuple", () => {
    expect(
      recoveryBindingIdentityMatches({
        identity,
        executionId,
        invocationId,
        callRef: identity.callRef,
        approvalBinding,
      }),
    ).toBe(true);
  });

  it("rejects mismatched execution and callRef", () => {
    expect(
      recoveryBindingIdentityMatches({
        identity: {
          ...identity,
          executionId: parse(ExecutionId)(
            "exe_018f2b3c-4d5e-7abc-8def-0123456789a6",
          ),
        },
        executionId,
        invocationId,
        callRef: identity.callRef,
      }),
    ).toBe(false);
    expect(
      recoveryBindingIdentityMatches({
        identity,
        executionId,
        invocationId,
        callRef: "different-call",
      }),
    ).toBe(false);
  });

  it("rejects a step/action mismatch in the trusted approval binding", () => {
    expect(
      recoveryBindingIdentityMatches({
        identity,
        executionId,
        invocationId,
        callRef: identity.callRef,
        approvalBinding: {
          ...approvalBinding,
          logicalStepNo: identity.logicalStepNo + 1,
        },
      }),
    ).toBe(false);
    expect(
      recoveryBindingIdentityMatches({
        identity,
        executionId,
        invocationId,
        callRef: identity.callRef,
        approvalBinding: {
          ...approvalBinding,
          logicalActionId: "different-action",
        },
      }),
    ).toBe(false);
  });
});
