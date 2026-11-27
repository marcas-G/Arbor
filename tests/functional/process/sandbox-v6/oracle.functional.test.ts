import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../../packages/ports/src/index.js";
import {
  type ActionRow,
  type InvocationRow,
  isP9SandboxUnavailableTerminal,
  type OutcomeProbe,
  p9ActionStepForProbe,
  p9NoEffectEvidenceForProbe,
  postDecisionExpectedFailureProbeForInvocation,
  type StepRow,
} from "./oracle.js";

describe("V6 P9 action oracle tracks the exact P4 source Step", () => {
  const probe: OutcomeProbe = {
    executionId: "exe_v6-oracle",
    invocationId: "tin_v6-oracle",
    callRef: "call_v6-oracle",
    toolName: "shell",
    providerTurnId: "ptn_exe_v6-oracle_0",
    logicalActionId: "lac_v6-oracle",
    actionIndex: 0,
    outcomeTag: "ExpectedFailure",
    recoveryBindingIdentity: {
      executionId: "exe_v6-oracle",
      providerTurnId: "ptn_exe_v6-oracle_0",
      logicalStepNo: 0,
      repairAttempt: 0,
      logicalActionId: "lac_v6-oracle",
      actionIndex: 0,
      callRef: "call_v6-oracle",
    },
  };

  it("uses the original terminal Step after a successor has become latest", () => {
    const bindingSha256 = "b".repeat(64);
    const attentionFactId = `att_${sha256Hex(
      JSON.stringify({
        version: 1,
        executionId: probe.executionId,
        policyRevision: 1,
      }),
    )}`;
    const invocation: InvocationRow = {
      execution_id: probe.executionId,
      invocation_id: probe.invocationId,
      settled_at: "2026-10-23T10:00:00.000Z",
      settlement_kind: "ExpectedFailure",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      recovery_binding_sha256: bindingSha256,
      result_ref: null,
      observation_json: JSON.stringify({
        _tag: "ExpectedFailure",
        observation: {
          text: "required sandbox capability was unavailable or could not be verified; execution did not start",
          truncated: false,
        },
        sandboxProviderUnavailable: {
          policyRevision: 1,
          policyDigest: "a".repeat(64),
          profile: "ReadOnly",
          providerId: "windows-restricted-appcontainer-job",
          providerVersion: "t3d-v1",
          capabilityRevision: "4",
          probeEvidenceRef: `sha256:${"c".repeat(64)}`,
          failureCode: "ProviderVersionMismatch",
          effectDisposition: "NoEffect",
        },
      }),
    };
    const actions: ActionRow[] = [
      {
        execution_id: probe.executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        action_index: 0,
        logical_action_id: "lac_v6-oracle",
        call_ref: "call_v6-oracle",
        state: "TerminalRejected",
        result_ref: attentionFactId,
      },
    ];
    const steps: StepRow[] = [
      {
        execution_id: probe.executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: "ptn_exe_v6-oracle_0",
        state: "NextStepReady",
      },
      {
        execution_id: probe.executionId,
        logical_step_no: 1,
        repair_attempt: 0,
        provider_turn_id: "ptn_exe_v6-oracle_1",
        state: "Prepared",
      },
    ];
    const exact = p9ActionStepForProbe({
      probe,
      invocation,
      actions,
      steps,
    });
    expect(exact?.step).toEqual(steps[0]);
    expect(
      isP9SandboxUnavailableTerminal({
        probe,
        invocation,
        action: exact?.action,
        step: exact?.step,
        unavailableFact: {
          execution_id: probe.executionId,
          policy_revision: 1,
          policy_digest: "a".repeat(64),
          profile_id: "ReadOnly",
          provider_id: "windows-restricted-appcontainer-job",
          provider_version: "t3d-v1",
          probe_evidence_ref: `sha256:${"c".repeat(64)}`,
          failure_code: "ProviderVersionMismatch",
          attention_fact_id: attentionFactId,
        },
        effectAttempts: [
          {
            invocation_id: probe.invocationId,
            attempt_no: 0,
            admission_state: "MayHaveStarted",
            admission_source: "P39Admission",
            binding_sha256: bindingSha256,
          },
        ],
        artifacts: [],
      }),
    ).toBe(true);
  });

  it("does not label a generic ExpectedFailure as the P9 unavailable terminal", () => {
    const invocation: InvocationRow = {
      execution_id: probe.executionId,
      invocation_id: probe.invocationId,
      settled_at: "2026-10-23T10:00:00.000Z",
      settlement_kind: "ExpectedFailure",
      effect_admission_state: "MayHaveStarted",
      recovery_binding_state: "Bound",
      recovery_binding_sha256: "b".repeat(64),
      result_ref: null,
      observation_json: JSON.stringify({
        _tag: "ExpectedFailure",
        observation: { text: "ordinary tool failure" },
        truncated: false,
      }),
    };
    const exact = p9ActionStepForProbe({
      probe,
      invocation,
      actions: [
        {
          execution_id: probe.executionId,
          logical_step_no: 0,
          repair_attempt: 0,
          action_index: 0,
          logical_action_id: "lac_v6-oracle",
          call_ref: "call_v6-oracle",
          state: "Applied",
          result_ref: null,
        },
      ],
      steps: [
        {
          execution_id: probe.executionId,
          logical_step_no: 0,
          repair_attempt: 0,
          provider_turn_id: "ptn_exe_v6-oracle_0",
          state: "SettlementProposed",
        },
      ],
    });
    expect(
      isP9SandboxUnavailableTerminal({
        probe,
        invocation,
        action: exact?.action,
        step: exact?.step,
        unavailableFact: undefined,
        effectAttempts: [],
        artifacts: [],
      }),
    ).toBe(false);
  });

  it.each([undefined, "OutcomeUncertain"] as const)(
    "rejects MayHaveStarted without exact P9 NoEffect evidence (%s)",
    (effectDisposition) => {
      const evidence = p9NoEffectEvidenceForProbe(probe);
      const observation = JSON.parse(
        String(evidence.invocation.observation_json),
      ) as {
        readonly _tag: string;
        readonly observation: {
          readonly text: string;
          readonly truncated: boolean;
        };
        readonly sandboxProviderUnavailable: Record<string, unknown>;
      };
      const unavailable = { ...observation.sandboxProviderUnavailable };
      if (effectDisposition === undefined) delete unavailable.effectDisposition;
      else unavailable.effectDisposition = effectDisposition;
      expect(
        isP9SandboxUnavailableTerminal({
          ...evidence,
          invocation: {
            ...evidence.invocation,
            observation_json: JSON.stringify({
              ...observation,
              sandboxProviderUnavailable: unavailable,
            }),
          },
        }),
      ).toBe(false);
    },
  );

  it("requires matching immutable P9 attempt/fact identity and no artifact result", () => {
    const evidence = p9NoEffectEvidenceForProbe(probe);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        effectAttempts: evidence.effectAttempts.map((attempt) => ({
          ...attempt,
          binding_sha256: "d".repeat(64),
        })),
      }),
    ).toBe(false);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        unavailableFact: {
          ...evidence.unavailableFact,
          failure_code: "OtherFailure",
        },
      }),
    ).toBe(false);
    expect(
      isP9SandboxUnavailableTerminal({
        ...evidence,
        artifacts: [
          { artifact_id: "art_v6-oracle", invocation_id: probe.invocationId },
        ],
      }),
    ).toBe(false);
  });

  it("accepts the canonical MayHaveStarted plus typed P9 NoEffect terminal", () => {
    expect(
      isP9SandboxUnavailableTerminal(p9NoEffectEvidenceForProbe(probe)),
    ).toBe(true);
  });

  it("ignores pre-decision policy parking and requires a fresh exact ExpectedFailure probe", () => {
    const preDecisionPark = {
      boundary: "P4ExecutableToolRuntimeOutcome",
      executionId: probe.executionId,
      invocationId: probe.invocationId,
      outcomeTag: "SandboxPolicyRequiredInterruption",
    };
    const postDecisionFailure = {
      ...preDecisionPark,
      outcomeTag: "ExpectedFailure",
    };
    expect(
      postDecisionExpectedFailureProbeForInvocation({
        probes: [preDecisionPark, postDecisionFailure],
        startIndex: 1,
        executionId: probe.executionId,
        invocationId: probe.invocationId,
      }),
    ).toMatchObject({ outcomeTag: "ExpectedFailure" });
    expect(
      postDecisionExpectedFailureProbeForInvocation({
        probes: [preDecisionPark],
        startIndex: 0,
        executionId: probe.executionId,
        invocationId: probe.invocationId,
      }),
    ).toBeUndefined();
  });
});
