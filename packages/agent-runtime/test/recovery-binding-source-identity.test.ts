import {
  ExecutionId,
  ProviderTurnId,
  parse,
} from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  recoveryBindingIdentityFor,
  recoveryBindingPolicyRevisionsFor,
} from "../src/agent-loop-actions.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const step = (): AgentLoopStepRecord => ({
  identity: { executionId, logicalStepNo: 7, repairAttempt: 1 },
  providerTurnId,
  state: "ActionsInProgress",
  nextActionIndex: 2,
  revision: 3,
  updatedAt: "2026-10-12T00:00:00.000Z",
});

const action = (): AgentLoopStepActionRecord => ({
  identity: { executionId, logicalStepNo: 7, repairAttempt: 1 },
  actionIndex: 2,
  logicalActionId: "lac_018f2b3c-4d5e-7abc-8def-0123456789a3",
  callRef: "call-1",
  routeKind: "Executable",
  actionKind: "patch",
  inputHash: "a".repeat(64),
  state: "Pending",
  revision: 0,
  updatedAt: "2026-10-12T00:00:00.000Z",
});

const sourceIdentity = (overrides: {
  readonly step?: AgentLoopStepRecord;
  readonly action?: AgentLoopStepActionRecord;
  readonly expectedExecutionId?: typeof executionId;
  readonly expectedProviderTurnId?: typeof providerTurnId;
  readonly actionIndex?: number;
  readonly callRef?: string;
} = {}) =>
  recoveryBindingIdentityFor({
    step: overrides.step ?? step(),
    action: overrides.action ?? action(),
    executionId: overrides.expectedExecutionId ?? executionId,
    providerTurnId: overrides.expectedProviderTurnId ?? providerTurnId,
    actionIndex: overrides.actionIndex ?? 2,
    callRef: overrides.callRef ?? "call-1",
  });

describe("P3 RecoveryBinding source identity", () => {
  it("binds one persisted Step, ProviderTurn, LogicalAction and callRef", () => {
    expect(sourceIdentity()).toEqual({
      executionId,
      providerTurnId,
      logicalStepNo: 7,
      repairAttempt: 1,
      logicalActionId: action().logicalActionId,
      actionIndex: 2,
      callRef: "call-1",
    });
  });

  it("fails closed for a wrong Execution, ProviderTurn, callRef or action index", () => {
    expect(
      sourceIdentity({
        expectedExecutionId: parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a4",
        ),
      }),
    ).toBeUndefined();
    expect(
      sourceIdentity({
        expectedProviderTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789a5",
        ),
      }),
    ).toBeUndefined();
    expect(sourceIdentity({ callRef: "other-call" })).toBeUndefined();
    expect(sourceIdentity({ actionIndex: 3 })).toBeUndefined();
  });

  it("fails closed when an Action belongs to a different persisted Step", () => {
    const mismatchedAction = {
      ...action(),
      identity: { executionId, logicalStepNo: 8, repairAttempt: 1 },
    } satisfies AgentLoopStepActionRecord;
    expect(sourceIdentity({ action: mismatchedAction })).toBeUndefined();
  });
});

describe("P3 RecoveryBinding policy revision source", () => {
  it("carries the exact prepared ControlBasis policy revisions", () => {
    const controlBasis = {
      workspacePolicyRevision: 17,
      projectPolicyRevision: 29,
      responsibilityRevision: 1,
      resourceBoundaryRevision: 2,
      authorizationDigest: "digest",
      environmentRevision: "0",
    };
    expect(recoveryBindingPolicyRevisionsFor(controlBasis)).toEqual({
      workspacePolicyRevision: 17,
      projectPolicyRevision: 29,
    });
  });

  it("does not substitute defaults for an invalid source revision", () => {
    expect(
      recoveryBindingPolicyRevisionsFor({
        workspacePolicyRevision: Number.NaN,
        projectPolicyRevision: 29,
      }),
    ).toBeUndefined();
  });
});
