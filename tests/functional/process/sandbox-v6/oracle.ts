import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../../../packages/ports/src/index.js";
import { decodeToolObservation, isRecord } from "./support.js";

export interface OutcomeProbe {
  readonly boundary?: string;
  readonly executionId: string;
  readonly invocationId: string;
  readonly callRef: string;
  readonly toolName: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionIndex?: number;
  readonly outcomeTag?: string;
  readonly recoveryBindingIdentity?: {
    readonly executionId: string;
    readonly providerTurnId: string;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
  };
}

export const postDecisionExpectedFailureProbeForInvocation = (input: {
  readonly probes: ReadonlyArray<Record<string, unknown>>;
  readonly startIndex: number;
  readonly executionId: string;
  readonly invocationId: string;
}): OutcomeProbe | undefined =>
  input.probes
    .slice(input.startIndex)
    .find(
      (probe) =>
        probe.boundary === "P4ExecutableToolRuntimeOutcome" &&
        probe.executionId === input.executionId &&
        probe.invocationId === input.invocationId &&
        probe.outcomeTag === "ExpectedFailure",
    ) as unknown as OutcomeProbe | undefined;

export interface ActionRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly state: string;
  readonly result_ref: string | null;
}

export interface StepRow {
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly provider_turn_id: string;
  readonly state: string;
}

export interface InvocationRow {
  readonly execution_id: string;
  readonly invocation_id: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly effect_admission_state: string;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly result_ref: string | null;
  readonly observation_json: unknown;
}

export interface UnavailableFactRow {
  readonly execution_id: string;
  readonly policy_revision: number;
  readonly policy_digest: string;
  readonly profile_id: string;
  readonly provider_id: string;
  readonly provider_version: string;
  readonly probe_evidence_ref: string | null;
  readonly failure_code: string;
  readonly attention_fact_id: string;
}

export interface EffectAttemptRow {
  readonly invocation_id: string;
  readonly attempt_no: number;
  readonly admission_state: string;
  readonly admission_source: string;
  readonly binding_sha256: string | null;
}

export interface ArtifactRow {
  readonly artifact_id: string;
  readonly invocation_id: string;
}

export const p9ActionStepForProbe = (input: {
  readonly probe: OutcomeProbe;
  readonly invocation: InvocationRow | undefined;
  readonly actions: ReadonlyArray<ActionRow>;
  readonly steps: ReadonlyArray<StepRow>;
}) => {
  const { probe, invocation } = input;
  const source = probe.recoveryBindingIdentity;
  if (
    source === undefined ||
    invocation === undefined ||
    source.executionId !== probe.executionId ||
    source.executionId !== invocation.execution_id ||
    invocation.invocation_id !== probe.invocationId ||
    source.providerTurnId !== probe.providerTurnId ||
    source.logicalActionId !== probe.logicalActionId ||
    source.logicalActionId.length === 0 ||
    source.callRef !== probe.callRef ||
    source.callRef.length === 0 ||
    source.actionIndex !== probe.actionIndex
  )
    return undefined;
  const step = input.steps.find(
    (candidate) =>
      candidate.execution_id === source.executionId &&
      candidate.logical_step_no === source.logicalStepNo &&
      candidate.repair_attempt === source.repairAttempt &&
      candidate.provider_turn_id === source.providerTurnId,
  );
  const action = input.actions.find(
    (candidate) =>
      candidate.execution_id === source.executionId &&
      candidate.logical_step_no === source.logicalStepNo &&
      candidate.repair_attempt === source.repairAttempt &&
      candidate.action_index === source.actionIndex &&
      candidate.logical_action_id === source.logicalActionId &&
      candidate.call_ref === source.callRef,
  );
  return step === undefined || action === undefined
    ? undefined
    : { action, step };
};

export const isP9SandboxUnavailableTerminal = (input: {
  readonly probe: OutcomeProbe;
  readonly invocation: InvocationRow | undefined;
  readonly action: ActionRow | undefined;
  readonly step: StepRow | undefined;
  readonly unavailableFact: UnavailableFactRow | undefined;
  readonly effectAttempts: ReadonlyArray<EffectAttemptRow>;
  readonly artifacts: ReadonlyArray<ArtifactRow>;
}): boolean => {
  const {
    probe,
    invocation,
    action,
    step,
    unavailableFact,
    effectAttempts,
    artifacts,
  } = input;
  if (
    probe.outcomeTag !== "ExpectedFailure" ||
    invocation === undefined ||
    action === undefined ||
    step === undefined ||
    invocation.invocation_id !== probe.invocationId ||
    invocation.settlement_kind !== "ExpectedFailure" ||
    invocation.settled_at === null ||
    action.state !== "TerminalRejected" ||
    action.logical_action_id !== probe.logicalActionId ||
    action.action_index !== probe.actionIndex ||
    action.call_ref !== probe.callRef ||
    step.execution_id !== probe.executionId ||
    !["StepEffectsCommitted", "NextStepReady", "SettlementProposed"].includes(
      step.state,
    )
  )
    return false;
  const observation = decodeToolObservation(invocation.observation_json);
  const boundedObservation = observation.observation;
  const failureText =
    typeof boundedObservation === "object" &&
    boundedObservation !== null &&
    "text" in boundedObservation &&
    typeof boundedObservation.text === "string"
      ? boundedObservation.text
      : undefined;
  const sandboxUnavailableValue = observation.sandboxProviderUnavailable;
  if (!isRecord(sandboxUnavailableValue)) return false;
  const sandboxUnavailable = sandboxUnavailableValue;
  if (
    observation._tag !== "ExpectedFailure" ||
    failureText === undefined ||
    !failureText.includes("execution did not start") ||
    sandboxUnavailable.failureCode !== "ProviderVersionMismatch" ||
    sandboxUnavailable.effectDisposition !== "NoEffect" ||
    invocation.effect_admission_state !== "MayHaveStarted" ||
    invocation.recovery_binding_state !== "Bound" ||
    invocation.recovery_binding_sha256 === null ||
    invocation.result_ref !== null ||
    unavailableFact === undefined ||
    action.result_ref !== unavailableFact.attention_fact_id ||
    unavailableFact.execution_id !== probe.executionId ||
    unavailableFact.policy_revision !== sandboxUnavailable.policyRevision ||
    unavailableFact.policy_digest !== sandboxUnavailable.policyDigest ||
    unavailableFact.profile_id !== sandboxUnavailable.profile ||
    unavailableFact.provider_id !== sandboxUnavailable.providerId ||
    unavailableFact.provider_version !== sandboxUnavailable.providerVersion ||
    unavailableFact.probe_evidence_ref !==
      sandboxUnavailable.probeEvidenceRef ||
    unavailableFact.failure_code !== sandboxUnavailable.failureCode ||
    unavailableFact.attention_fact_id !==
      `att_${sha256Hex(JSON.stringify({ version: 1, executionId: probe.executionId, policyRevision: sandboxUnavailable.policyRevision }))}` ||
    effectAttempts.length !== 1 ||
    effectAttempts[0]?.invocation_id !== probe.invocationId ||
    effectAttempts[0]?.attempt_no !== 0 ||
    effectAttempts[0]?.admission_state !== "MayHaveStarted" ||
    effectAttempts[0]?.admission_source !== "P39Admission" ||
    effectAttempts[0]?.binding_sha256 !== invocation.recovery_binding_sha256 ||
    artifacts.length !== 0
  )
    return false;
  return (
    probe.recoveryBindingIdentity?.executionId === probe.executionId &&
    probe.recoveryBindingIdentity.callRef === probe.callRef &&
    probe.recoveryBindingIdentity.logicalActionId === probe.logicalActionId &&
    probe.recoveryBindingIdentity.actionIndex === probe.actionIndex
  );
};

export const p9NoEffectEvidenceForProbe = (probe: OutcomeProbe) => {
  const bindingSha256 = "b".repeat(64);
  const attentionFactId = `att_${sha256Hex(
    JSON.stringify({
      version: 1,
      executionId: probe.executionId,
      policyRevision: 1,
    }),
  )}`;
  const unavailable = {
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    profile: "ReadOnly",
    providerId: "windows-restricted-appcontainer-job",
    providerVersion: "t3d-v1",
    capabilityRevision: "4",
    probeEvidenceRef: `sha256:${"c".repeat(64)}`,
    failureCode: "ProviderVersionMismatch",
    effectDisposition: "NoEffect",
  };
  return {
    probe,
    invocation: {
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
        sandboxProviderUnavailable: unavailable,
      }),
    } satisfies InvocationRow,
    action: {
      execution_id: probe.executionId,
      logical_step_no: probe.recoveryBindingIdentity?.logicalStepNo ?? 0,
      repair_attempt: probe.recoveryBindingIdentity?.repairAttempt ?? 0,
      action_index: probe.actionIndex ?? 0,
      logical_action_id: probe.logicalActionId ?? "lac_v6-oracle",
      call_ref: probe.callRef,
      state: "TerminalRejected",
      result_ref: attentionFactId,
    } satisfies ActionRow,
    step: {
      execution_id: probe.executionId,
      logical_step_no: probe.recoveryBindingIdentity?.logicalStepNo ?? 0,
      repair_attempt: probe.recoveryBindingIdentity?.repairAttempt ?? 0,
      provider_turn_id: probe.providerTurnId ?? "ptn_v6-oracle",
      state: "NextStepReady",
    } satisfies StepRow,
    unavailableFact: {
      execution_id: probe.executionId,
      policy_revision: 1,
      policy_digest: unavailable.policyDigest,
      profile_id: unavailable.profile,
      provider_id: unavailable.providerId,
      provider_version: unavailable.providerVersion,
      probe_evidence_ref: unavailable.probeEvidenceRef,
      failure_code: unavailable.failureCode,
      attention_fact_id: attentionFactId,
    } satisfies UnavailableFactRow,
    effectAttempts: [
      {
        invocation_id: probe.invocationId,
        attempt_no: 0,
        admission_state: "MayHaveStarted",
        admission_source: "P39Admission",
        binding_sha256: bindingSha256,
      },
    ] satisfies ReadonlyArray<EffectAttemptRow>,
    artifacts: [] as ReadonlyArray<ArtifactRow>,
  };
};

export const readP9OutcomeSourceForProbe = (
  databaseFile: string,
  probe: OutcomeProbe,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const invocation = db
      .prepare(
        `SELECT execution_id, invocation_id, effect_admission_state,
                recovery_binding_state, recovery_binding_sha256, settled_at,
                settlement_kind, result_ref, observation_json
           FROM tool_invocations
          WHERE execution_id = ? AND invocation_id = ?`,
      )
      .get(probe.executionId, probe.invocationId) as InvocationRow | undefined;
    const actions = db
      .prepare(
        `SELECT execution_id, logical_step_no, repair_attempt, action_index,
                logical_action_id, call_ref, state, result_ref
           FROM agent_loop_step_actions WHERE execution_id = ?
          ORDER BY logical_step_no, repair_attempt, action_index`,
      )
      .all(probe.executionId) as unknown as ReadonlyArray<ActionRow>;
    const steps = db
      .prepare(
        `SELECT execution_id, logical_step_no, repair_attempt,
                provider_turn_id, state
           FROM agent_loop_steps WHERE execution_id = ?
          ORDER BY logical_step_no, repair_attempt`,
      )
      .all(probe.executionId) as unknown as ReadonlyArray<StepRow>;
    const exact = p9ActionStepForProbe({ probe, invocation, actions, steps });
    const observation =
      invocation === undefined
        ? undefined
        : decodeToolObservation(invocation.observation_json);
    const unavailable = observation?.sandboxProviderUnavailable;
    const policyRevision =
      typeof unavailable === "object" &&
      unavailable !== null &&
      "policyRevision" in unavailable &&
      typeof unavailable.policyRevision === "number"
        ? unavailable.policyRevision
        : undefined;
    const unavailableFact =
      policyRevision === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT execution_id, policy_revision, policy_digest, profile_id,
                      provider_id, provider_version, probe_evidence_ref,
                      failure_code,
                      attention_fact_id
                 FROM sandbox_provider_unavailable_facts
                WHERE execution_id = ? AND policy_revision = ?`,
            )
            .get(probe.executionId, policyRevision) as
            | UnavailableFactRow
            | undefined);
    const effectAttempts =
      invocation === undefined
        ? []
        : (db
            .prepare(
              `SELECT invocation_id, attempt_no, admission_state,
                      admission_source, binding_sha256
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? ORDER BY attempt_no`,
            )
            .all(
              probe.invocationId,
            ) as unknown as ReadonlyArray<EffectAttemptRow>);
    const artifacts =
      invocation === undefined
        ? []
        : (db
            .prepare(
              `SELECT artifact_id, invocation_id FROM artifacts
                WHERE invocation_id = ? ORDER BY artifact_id`,
            )
            .all(probe.invocationId) as unknown as ReadonlyArray<ArtifactRow>);
    db.exec("COMMIT");
    return {
      invocation,
      action: exact?.action,
      step: exact?.step,
      unavailableFact,
      effectAttempts,
      artifacts,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};
