import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { Ah7RecoveredContext } from "./start-fixture.js";
import {
  isToolResultFor,
  readEffectAttempts,
  readExecutableApprovalAfterRecovery,
  readExecutionProviderTurns,
  readP4InvocationApprovalBinding,
  readP39RecoveryBinding,
  readProjectActiveGrantCount,
  readReconciliationFacts,
  readTestExternalEffects,
  readTestReconciliationCallCount,
  readToolResultForCall,
} from "./support.js";

export const assertAh7Recovered = async (
  ctx: Ah7RecoveredContext,
): Promise<void> => {
  const {
    fixture,
    client,
    project,
    marker,
    hit,
    crashed,
    targetExecutionId,
    targetCallRef,
    executableApproval,
    crashedAction,
    crashedTarget,
    crashedSourceStep,
    originalProviderTurnId,
    effectPath,
    contentBefore,
    recovered,
    attemptsBeforeRecovery,
    bindingBeforeRecovery,
  } = ctx;
  const {
    semantics,
    profileDrift,
    mismatchedProofIsUnknown,
    reconciliationMode,
    noEffectRetryDenied,
    resumesUnadmittedIntent,
    reconciliationDrift,
    recoveryCrashBoundary,
  } = ctx.flags;
  const recoveredTarget = readExecutionProviderTurns(
    fixture.databaseFile,
    targetExecutionId,
  );
  expect(recoveredTarget.execution).toEqual(crashedTarget.execution);
  const recoveredTargetInvocations = recovered.toolInvocations.filter(
    (invocation) => invocation.execution_id === targetExecutionId,
  );
  expect(recoveredTargetInvocations).toHaveLength(1);
  const settledInvocation = recoveredTargetInvocations[0];
  expect(settledInvocation).toMatchObject({
    invocation_id: hit.invocationId,
    execution_id: targetExecutionId,
    side_effect_semantics: semantics,
  });
  const recoveredInvocationBinding = readP4InvocationApprovalBinding(
    fixture.databaseFile,
    targetExecutionId,
    hit.invocationId,
  );
  expect(recoveredInvocationBinding?.approval_id).toBe(
    executableApproval.approvalId,
  );
  expect(recoveredInvocationBinding?.arguments_json).toBe(
    executableApproval.row.arguments_json,
  );
  const reconciliationFacts =
    reconciliationMode === undefined
      ? []
      : readReconciliationFacts(fixture.databaseFile, hit.invocationId);
  const effectAttempts =
    reconciliationMode === undefined
      ? []
      : readEffectAttempts(fixture.databaseFile, hit.invocationId);
  const externalEffects =
    reconciliationMode === undefined
      ? []
      : readTestExternalEffects(fixture.databaseFile);
  if (profileDrift !== undefined) {
    expect(reconciliationFacts).toEqual([]);
    expect(effectAttempts).toEqual(attemptsBeforeRecovery);
    expect(effectAttempts).toHaveLength(1);
    expect(effectAttempts[0]).toMatchObject({
      attempt_no: 0,
      admission_state: "MayHaveStarted",
    });
    expect(
      readP39RecoveryBinding(fixture.databaseFile, hit.invocationId),
    ).toEqual(bindingBeforeRecovery);
    expect(externalEffects).toEqual([]);
    expect(
      readTestReconciliationCallCount(fixture.databaseFile, hit.invocationId),
    ).toBe(0);
    expect(recoveredInvocationBinding).toMatchObject({
      effect_admission_state: "MayHaveStarted",
      result_ref: null,
      settlement_kind: null,
      settled_at: null,
      selected_attempt_no: null,
      selected_fact_id: null,
    });
  } else if (mismatchedProofIsUnknown) {
    expect(reconciliationFacts).toHaveLength(1);
    expect(reconciliationFacts[0]).toMatchObject({
      attempt_no: 0,
      outcome: "StillUnknown",
      reason_code: "EvidenceBindingMismatch",
      fact_disposition: "RecoveryInput",
      result_ref: null,
    });
    expect(effectAttempts).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        admission_state: "MayHaveStarted",
      }),
    ]);
    expect(externalEffects).toEqual([]);
    expect(recoveredInvocationBinding).toMatchObject({
      settlement_kind: null,
      settled_at: null,
      selected_attempt_no: null,
      selected_fact_id: null,
      result_ref: null,
      observation_json: null,
    });
  } else if (reconciliationMode === "NotOccurred") {
    expect(reconciliationFacts).toHaveLength(1);
    expect(reconciliationFacts[0]).toMatchObject({
      attempt_no: 0,
      outcome: "NotOccurred",
      reason_code: null,
      fact_disposition: "RecoveryInput",
      result_ref: null,
    });
    expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
    if (noEffectRetryDenied) {
      expect(effectAttempts).toHaveLength(1);
      expect(effectAttempts[0]).toMatchObject({
        attempt_no: 0,
        admission_state: "MayHaveStarted",
      });
      expect(externalEffects).toHaveLength(0);
      expect(recoveredInvocationBinding).toMatchObject({
        settlement_kind: "ReconciledNoEffect",
        settlement_provenance: "Reconciliation",
        selected_attempt_no: 0,
        selected_fact_id: reconciliationFacts[0]?.fact_id,
        observation_format_version: "p4-canonical-tool-observation-v1",
      });
      expect(recoveredInvocationBinding?.result_ref).toMatch(/^art_/u);
      const expectedReasonCode =
        reconciliationDrift === "authority"
          ? "AuthoritySnapshotChanged"
          : reconciliationDrift === "approval"
            ? "ApprovalNoLongerAuthorized"
            : reconciliationDrift === "stop"
              ? "StopRequested"
              : "ResourceSnapshotChanged";
      expect(
        JSON.parse(String(recoveredInvocationBinding?.settlement_json)),
      ).toMatchObject({
        _tag: "ReconciledNoEffect",
        reasonCode: expectedReasonCode,
      });
      const observation = JSON.parse(
        Buffer.from(
          recoveredInvocationBinding?.observation_json ?? new Uint8Array(),
        ).toString("utf8"),
      );
      expect(observation).toMatchObject({
        _tag: "ReconciledNoEffect",
        reasonCode: expectedReasonCode,
        reconciliationFactRef: reconciliationFacts[0]?.fact_id,
      });
    } else {
      expect(effectAttempts).toHaveLength(2);
      expect(effectAttempts.map((attempt) => attempt.attempt_no)).toEqual([
        0, 1,
      ]);
      expect(effectAttempts.map((attempt) => attempt.admission_state)).toEqual([
        "MayHaveStarted",
        "MayHaveStarted",
      ]);
      expect(effectAttempts[0]?.effect_key).toBe(effectAttempts[1]?.effect_key);
      expect(externalEffects).toHaveLength(1);
      expect(externalEffects[0]?.result_ref).toMatch(/^art_/u);
      expect(recoveredInvocationBinding).toMatchObject({
        settlement_kind: "Success",
        settlement_provenance: "Ordinary",
        selected_attempt_no: null,
        selected_fact_id: null,
        observation_format_version: "p4-canonical-tool-observation-v1",
      });
    }
    expect(recoveredInvocationBinding?.observation_sha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
  } else if (reconciliationMode === "Occurred") {
    expect(reconciliationFacts).toHaveLength(1);
    expect(reconciliationFacts[0]).toMatchObject({
      attempt_no: 0,
      outcome: "Occurred",
      reason_code: null,
      fact_disposition: "RecoveryInput",
    });
    expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
    expect(reconciliationFacts[0]?.result_ref).toMatch(/^art_/u);
    expect(reconciliationFacts[0]?.result_ref).not.toBe(
      reconciliationFacts[0]?.evidence_ref,
    );
    expect(effectAttempts).toHaveLength(1);
    expect(externalEffects).toHaveLength(1);
    expect(recoveredInvocationBinding).toMatchObject({
      settlement_kind: "Success",
      settlement_provenance: "Reconciliation",
      selected_attempt_no: 0,
      selected_fact_id: reconciliationFacts[0]?.fact_id,
      result_ref: reconciliationFacts[0]?.result_ref,
      observation_format_version: "p4-canonical-tool-observation-v1",
    });
    expect(recoveredInvocationBinding?.observation_sha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
  } else if (reconciliationMode === "StillUnknown") {
    expect(reconciliationFacts).toHaveLength(1);
    expect(reconciliationFacts[0]).toMatchObject({
      attempt_no: 0,
      outcome: "StillUnknown",
      reason_code: "AttemptNotFinal",
      fact_disposition: "RecoveryInput",
      result_ref: null,
      evidence_ref: null,
    });
    expect(effectAttempts).toHaveLength(1);
    expect(externalEffects).toHaveLength(0);
    expect(recoveredInvocationBinding).toMatchObject({
      settlement_kind: null,
      settled_at: null,
      result_ref: null,
      observation_format_version: null,
      observation_json: null,
      observation_sha256: null,
    });
    const escalationDb = new DatabaseSync(fixture.databaseFile, {
      readOnly: true,
    });
    let escalationRows: ReadonlyArray<{
      event_type: string;
      payload_json: string;
    }>;
    try {
      escalationRows = escalationDb
        .prepare(
          "SELECT event_type, payload_json FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
        )
        .all(targetExecutionId) as unknown as typeof escalationRows;
    } finally {
      escalationDb.close();
    }
    expect(escalationRows).toHaveLength(1);
    expect(JSON.parse(String(escalationRows[0]?.payload_json))).toEqual({
      executionId: targetExecutionId,
      invocationRefsFingerprint: hit.invocationId,
      refs: [hit.invocationId],
    });
    const attention = await client.view<{
      rows: ReadonlyArray<{
        source?: string;
        severity?: string;
        targetWorkspaceId?: string;
        dedupKey?: string;
      }>;
    }>("attention", { projectId: project.projectId });
    const visibleEscalations = attention.rows.filter(
      (row) =>
        row.source === "RecoveryEscalation" &&
        row.dedupKey ===
          `reconciliation-escalated:${targetExecutionId}:${hit.invocationId}`,
    );
    expect(visibleEscalations).toHaveLength(1);
    expect(visibleEscalations[0]).toMatchObject({
      severity: "ActionRequired",
      targetWorkspaceId: project.rootWorkspaceId,
    });
  }
  const recoveredApproval = readExecutableApprovalAfterRecovery(
    fixture.databaseFile,
    executableApproval.approvalId,
    targetExecutionId,
  );
  expect(recoveredApproval.approval).toMatchObject({
    state: "Consumed",
    consumed_by: hit.invocationId,
  });
  expect(recoveredApproval.approvals).toHaveLength(1);
  if (reconciliationDrift === "authority") {
    expect(
      readProjectActiveGrantCount(fixture.databaseFile, targetExecutionId),
    ).toBe(0);
  } else if (reconciliationDrift === "approval") {
    expect(recoveredApproval.approval.expires_at).toBe(
      "2000-01-01T00:00:00.000Z",
    );
  } else if (reconciliationDrift === "stop") {
    expect(
      (
        recovered.executions as Array<{
          execution_id: string;
          stop_requested_at: string | null;
        }>
      ).find((execution) => execution.execution_id === targetExecutionId)
        ?.stop_requested_at,
    ).not.toBeNull();
  }
  if (profileDrift !== undefined) {
    expect(settledInvocation?.settled_at).toBeNull();
    expect(settledInvocation?.settlement_kind).toBeNull();
  } else if (resumesUnadmittedIntent) {
    expect(settledInvocation?.settled_at).not.toBeNull();
    expect(settledInvocation?.settlement_kind).toBe("Success");
  } else if (noEffectRetryDenied) {
    expect(settledInvocation?.settled_at).not.toBeNull();
    expect(settledInvocation?.settlement_kind).toBe("ReconciledNoEffect");
  } else if (mismatchedProofIsUnknown) {
    expect(settledInvocation?.settled_at).toBeNull();
    expect(settledInvocation?.settlement_kind).toBeNull();
  } else if (
    reconciliationMode === "NotOccurred" ||
    reconciliationMode === "Occurred"
  ) {
    expect(settledInvocation?.settled_at).not.toBeNull();
    expect(settledInvocation?.settlement_kind).toBe("Success");
  } else if (semantics === "NonIdempotent") {
    expect(recoveredInvocationBinding?.effect_admission_state).toBe(
      "MayHaveStarted",
    );
    expect(settledInvocation?.settled_at).not.toBeNull();
    expect(settledInvocation?.settlement_kind).toBe("OutcomeUnknown");
    expect(JSON.parse(String(settledInvocation?.settlement_json))).toEqual({
      _tag: "OutcomeUnknown",
      reconciliationRefs: [hit?.invocationId],
    });
  } else {
    expect(settledInvocation?.settled_at).toBeNull();
    expect(settledInvocation?.settlement_kind).toBeNull();
    expect(settledInvocation?.settlement_json).toBeNull();
  }
  const recoveredTargetActions = recovered.actions.filter(
    (action) =>
      action.execution_id === targetExecutionId &&
      action.call_ref === hit.callRef,
  );
  if (noEffectRetryDenied) {
    expect(recoveredTargetActions).toHaveLength(1);
    expect(recoveredTargetActions[0]).toMatchObject({
      execution_id: targetExecutionId,
      logical_action_id: crashedAction.logical_action_id,
      call_ref: crashedAction.call_ref,
    });
    // The P4 denial may already be visible as a terminal rejection, but
    // this case qualifies the P4 retry gate only, not P3 projection crash
    // convergence. In particular, it must never report an applied effect.
    expect(recoveredTargetActions[0]?.state).not.toBe("Applied");
  } else {
    expect(recoveredTargetActions).toEqual([
      expect.objectContaining({
        execution_id: targetExecutionId,
        logical_action_id: crashedAction.logical_action_id,
        call_ref: crashedAction.call_ref,
        state:
          profileDrift !== undefined || mismatchedProofIsUnknown
            ? "ReconciliationPending"
            : resumesUnadmittedIntent ||
                reconciliationMode === "NotOccurred" ||
                reconciliationMode === "Occurred"
              ? "Applied"
              : "ReconciliationPending",
      }),
    ]);
  }
  const recoveredExecution = recovered.executions.find(
    (execution) => execution.execution_id === targetExecutionId,
  );
  const contentAfter = existsSync(effectPath)
    ? readFileSync(effectPath, "utf8")
    : null;
  const markerLineCount = (text: string | null): number =>
    (text ?? "").split(/\r?\n/u).filter((line) => line === marker).length;
  if (
    profileDrift !== undefined ||
    mismatchedProofIsUnknown ||
    (!resumesUnadmittedIntent && reconciliationMode === "StillUnknown")
  ) {
    if (mismatchedProofIsUnknown) {
      expect([null, "OutcomeUnknown"]).toContain(
        recoveredExecution?.settlement_kind,
      );
      if (recoveredExecution?.settlement_kind === "OutcomeUnknown") {
        expect(JSON.parse(String(recoveredExecution.settlement_json))).toEqual({
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: [hit?.invocationId],
          },
        });
      }
    } else {
      expect(recoveredExecution).toMatchObject({
        settlement_kind: "OutcomeUnknown",
      });
      expect(JSON.parse(String(recoveredExecution?.settlement_json))).toEqual({
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: [hit?.invocationId],
        },
      });
    }
  }
  if (semantics === "NonIdempotent" && !resumesUnadmittedIntent) {
    const toolResultsForCall = recovered.toolResults.filter(
      (row) => readToolResultForCall([row], targetCallRef) !== undefined,
    );
    expect(toolResultsForCall).toHaveLength(1);
    const unresolvedToolResult = readToolResultForCall(
      recovered.toolResults,
      targetCallRef,
    );
    expect(unresolvedToolResult).toBeDefined();
    expect(unresolvedToolResult?.row.source_kind).toBe("AgentLoopAction");
    expect(unresolvedToolResult?.payload).toMatchObject({
      _tag: "ToolResult",
      callRef: targetCallRef,
      toolName: "shell",
      status: "OutcomeUnknown",
      artifactRefs: [],
      truncated: false,
    });
    expect(unresolvedToolResult?.payload).not.toHaveProperty("canonicalRefs");
    expect(unresolvedToolResult?.payload).not.toHaveProperty("resultRef");
    expect(unresolvedToolResult?.payload).not.toHaveProperty("invocationId");
    expect(unresolvedToolResult?.row.source_ref).toBe(
      recoveredTargetActions[0]?.observation_source_ref,
    );
    expect(unresolvedToolResult?.payload.observationRef).toBe(
      recoveredTargetActions[0]?.observation_source_ref,
    );
    expect(
      recovered.artifacts.filter(
        (artifact) => artifact.invocation_id === hit.invocationId,
      ),
    ).toEqual([]);
  }
  const recoveredSourceStep = recovered.steps.find(
    (step) =>
      step.execution_id === targetExecutionId &&
      step.logical_step_no === crashedAction.logical_step_no &&
      step.repair_attempt === crashedAction.repair_attempt,
  );
  expect(crashedSourceStep).toMatchObject({
    state: "ActionsInProgress",
    next_action_index: 0,
    provider_turn_id: expect.any(String),
    decoded_output_hash: expect.any(String),
    model_output_session_sequence: expect.any(Number),
  });
  expect(recoveredSourceStep).toMatchObject({
    provider_turn_id: crashedSourceStep?.provider_turn_id,
    decoded_output_hash: crashedSourceStep?.decoded_output_hash,
    model_output_session_sequence:
      crashedSourceStep?.model_output_session_sequence,
  });
  const recoveredActionCursor = recoveredSourceStep?.next_action_index;
  if (
    recoveryCrashBoundary === "AH7BeforeToolSettlementCommit" ||
    recoveryCrashBoundary === "AH7AfterToolSettlementCommit"
  ) {
    expect([0, 1]).toContain(recoveredActionCursor);
  } else {
    expect(recoveredActionCursor).toBe(1);
  }
  expect(
    crashed.outputs.filter(
      (output) => output.source_ref === `${originalProviderTurnId}:assistant`,
    ),
  ).toHaveLength(1);
  expect(
    recovered.outputs.filter(
      (output) => output.source_ref === `${originalProviderTurnId}:assistant`,
    ),
  ).toHaveLength(1);
  expect(
    recovered.attempts.filter(
      (attempt) => attempt.provider_turn_id === originalProviderTurnId,
    ),
  ).toEqual(
    crashed.attempts.filter(
      (attempt) => attempt.provider_turn_id === originalProviderTurnId,
    ),
  );
  if (resumesUnadmittedIntent) {
    expect(
      recoveredTarget.providerTurns.find(
        (turn) => turn.provider_turn_id === originalProviderTurnId,
      ),
    ).toEqual(
      crashedTarget.providerTurns.find(
        (turn) => turn.provider_turn_id === originalProviderTurnId,
      ),
    );
    const successorTurn = recoveredTarget.providerTurns.find(
      (turn) => turn.provider_turn_id !== originalProviderTurnId,
    );
    expect(successorTurn?.settled_at).not.toBeNull();
    expect(
      recovered.outputs.filter(
        (output) =>
          output.source_ref === `${successorTurn?.provider_turn_id}:assistant`,
      ),
    ).toHaveLength(1);
    expect(recoveredSourceStep?.next_action_index).toBe(1);
    expect(
      recovered.actions.find(
        (action) =>
          action.execution_id === targetExecutionId &&
          action.call_ref === hit?.callRef,
      )?.observation_source_ref,
    ).toEqual(expect.any(String));
    expect(
      recovered.toolResults.filter((row) =>
        isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
      ),
    ).toHaveLength(1);
    expect(ctx.targetProviderCalls).toBeGreaterThan(1);
    expect(contentBefore).toBeNull();
    expect(markerLineCount(contentAfter)).toBe(1);
  } else if (profileDrift !== undefined) {
    expect(recoveredTarget.providerTurns).toEqual(crashedTarget.providerTurns);
    expect(ctx.targetProviderCalls).toBe(1);
    expect(contentAfter).toBeNull();
  } else if (mismatchedProofIsUnknown) {
    expect(recoveredTarget.providerTurns).toEqual(crashedTarget.providerTurns);
    expect(ctx.targetProviderCalls).toBe(1);
    expect(contentAfter).toBeNull();
  } else if (
    reconciliationMode === "NotOccurred" ||
    reconciliationMode === "Occurred"
  ) {
    expect(
      recoveredTarget.providerTurns.filter((turn) =>
        crashedTarget.providerTurns.some(
          (crashedTurn) =>
            crashedTurn.provider_turn_id === turn.provider_turn_id,
        ),
      ),
    ).toEqual(crashedTarget.providerTurns);
    // B2: the call count is not the invariant — the replay gate decides:
    // denied variants record the no-effect observation exactly once and
    // never re-execute; admitted variants record no denial at all (the
    // marker count below) and chatter stays bounded by MAX_TURNS. See
    // PR #12 for the full diagnosis.
    const denials = recovered.toolResults.filter((row) =>
      String(row.payload_json).includes(
        "authoritative source confirmed that the effect attempt did not occur",
      ),
    );
    expect(denials).toHaveLength(noEffectRetryDenied ? 1 : 0);
    expect(ctx.targetProviderCalls).toBeLessThanOrEqual(24);
    if (noEffectRetryDenied) {
      expect(contentAfter).toBeNull();
      expect(externalEffects).toHaveLength(0);
    } else {
      expect(contentAfter).toBeDefined();
      expect(markerLineCount(contentAfter)).toBe(1);
    }
  } else {
    expect(recoveredTarget.providerTurns).toEqual(crashedTarget.providerTurns);
    expect(ctx.targetProviderCalls).toBe(1);
    expect(contentAfter).toBe(contentBefore);
    if (semantics === "NonIdempotent") {
      expect(markerLineCount(contentAfter)).toBe(1);
    }
  }
  expect(fixture.daemonErrors).toEqual([]);
};
